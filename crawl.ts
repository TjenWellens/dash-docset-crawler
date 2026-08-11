import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const startUrl = process.argv[2];
const outputDir = process.argv[3] ?? "./output";
const maxPages = Number(process.env.MAX_PAGES ?? 500);

if (!startUrl) {
  console.error("Usage: npx tsx crawl.ts <url> [output-dir]");
  process.exit(1);
}

const start = new URL(startUrl);
start.hash = "";
start.search = "";

const scopePath = start.pathname.endsWith("/")
  ? start.pathname
  : start.pathname + "/";

/**
 * Normalize a URL:
 * - remove hash
 * - remove query string
 * - remove trailing slash except for "/"
 */
function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  url.hash = "";
  url.search = "";

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}

/**
 * Whether a URL belongs to the documentation scope.
 */
function inScope(raw: string): boolean {
  const url = new URL(raw);

  return (
    url.origin === start.origin &&
    (
      url.pathname === start.pathname ||
      url.pathname.startsWith(scopePath)
    )
  );
}

/**
 * Convert a page URL to a local HTML path.
 *
 * https://orm.drizzle.team/docs/overview
 *
 * -> ./test-drizzle/orm.drizzle.team/docs/overview.html
 */
function pageOutputPath(raw: string): string {
  const url = new URL(raw);

  let pathname = url.pathname;

  if (pathname === "/" || pathname === "") {
    pathname = "index.html";
  } else {
    pathname = pathname.replace(/^\/+/, "");

    if (pathname.endsWith("/")) {
      pathname += "index.html";
    } else {
      pathname += ".html";
    }
  }

  return path.join(
    outputDir,
    url.hostname,
    pathname,
  );
}

/**
 * Convert an arbitrary resource URL to its local asset path.
 *
 * https://orm.drizzle.team/_astro/foo.css
 *
 * -> ./test-drizzle/orm.drizzle.team/_assets/_astro/foo.css
 */
function assetOutputPath(raw: string): string {
  const url = new URL(raw);

  let pathname = url.pathname.replace(/^\/+/, "");

  if (!pathname) {
    pathname = "index";
  }

  return path.join(
    outputDir,
    url.hostname,
    "_assets",
    pathname,
  );
}

/**
 * Resources we care about.
 */
function shouldCapture(response: Response): boolean {
  const url = response.url();

  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://")
  ) {
    return false;
  }

  const type = response.request().resourceType();

  if (
    type === "stylesheet" ||
    type === "font" ||
    type === "image" ||
    type === "script"
  ) {
    return true;
  }

  const contentType =
    response.headers()["content-type"] ?? "";

  if (
    contentType.includes("text/css") ||
    contentType.startsWith("font/") ||
    contentType.includes("application/font") ||
    contentType.includes("javascript") ||
    contentType.includes("image/")
  ) {
    return true;
  }

  return false;
}

/**
 * Ignore analytics/search/telemetry resources.
 */
function isExternalNoise(raw: string): boolean {
  const url = new URL(raw);
  const hostname = url.hostname;

  return (
    hostname.includes("google-analytics") ||
    hostname.includes("googletagmanager") ||
    hostname.includes("analytics") ||
    hostname.includes("ahrefs") ||
    hostname.includes("algolia") ||
    hostname.includes("onedollarstats") ||
    hostname.includes("doubleclick")
  );
}

/**
 * Calculate a relative path from one local file to another.
 */
function relativeAssetUrl(
  pageUrl: string,
  destination: string,
): string {
  const pagePath = pageOutputPath(pageUrl);

  const relative = path.relative(
    path.dirname(pagePath),
    destination,
  );

  return relative
    .split(path.sep)
    .join("/");
}

/**
 * Rewrite url(...) references inside CSS.
 */
function rewriteCss(
  css: string,
  cssUrl: string,
  resourceMap: Map<string, string>,
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, _quote, rawUrl) => {
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      try {
        const absolute = normalizeUrl(
          new URL(rawUrl, cssUrl).href,
        );

        const destination =
          resourceMap.get(absolute);

        if (!destination) {
          return match;
        }

        const relative =
          relativeAssetUrl(
            cssUrl,
            destination,
          );

        return `url("${relative}")`;
      } catch {
        return match;
      }
    },
  );
}

/**
 * Add an absolute HTTP(S) URL to a set.
 */
function addResourceUrl(
  urls: Set<string>,
  value: string | null,
  baseUrl: string,
): void {
  if (!value) {
    return;
  }

  try {
    const absolute = new URL(value, baseUrl);

    if (
      absolute.protocol !== "http:" &&
      absolute.protocol !== "https:"
    ) {
      return;
    }

    absolute.hash = "";
    absolute.search = "";

    urls.add(absolute.href);
  } catch {
    // Ignore malformed URLs.
  }
}

/**
 * Collect actual resources referenced by the current page.
 *
 * IMPORTANT:
 *
 * We deliberately do NOT collect every <link href>.
 *
 * Ordinary <link> elements can contain navigation/canonical/etc.
 * URLs and must not be mistaken for downloadable assets.
 */
async function collectResourceUrls(
  page: Page,
): Promise<string[]> {
  const urls = new Set<string>();
  const baseUrl = page.url();

  /*
   * Stylesheets.
   */
  const stylesheets =
    page.locator('link[rel~="stylesheet"][href]');

  const stylesheetCount =
    await stylesheets.count();

  for (let i = 0; i < stylesheetCount; i++) {
    addResourceUrl(
      urls,
      await stylesheets.nth(i).getAttribute("href"),
      baseUrl,
    );
  }

  /*
   * Icons / favicons.
   */
  const icons =
    page.locator(
      'link[rel~="icon"][href], link[rel~="shortcut icon"][href]'
    );

  const iconCount = await icons.count();

  for (let i = 0; i < iconCount; i++) {
    addResourceUrl(
      urls,
      await icons.nth(i).getAttribute("href"),
      baseUrl,
    );
  }

  /*
   * Preload / modulepreload.
   *
   * Only treat these as resources when they have an href.
   */
  const preloads =
    page.locator(
      'link[rel~="preload"][href], link[rel~="modulepreload"][href]'
    );

  const preloadCount =
    await preloads.count();

  for (let i = 0; i < preloadCount; i++) {
    addResourceUrl(
      urls,
      await preloads.nth(i).getAttribute("href"),
      baseUrl,
    );
  }

  /*
   * <img src>
   */
  const images =
    page.locator("img[src]");

  const imageCount =
    await images.count();

  for (let i = 0; i < imageCount; i++) {
    addResourceUrl(
      urls,
      await images.nth(i).getAttribute("src"),
      baseUrl,
    );

    const srcset =
      await images.nth(i).getAttribute("srcset");

    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const url =
          candidate.trim().split(/\s+/)[0];

        addResourceUrl(
          urls,
          url,
          baseUrl,
        );
      }
    }
  }

  /*
   * <source src> / srcset
   */
  const sources =
    page.locator("source");

  const sourceCount =
    await sources.count();

  for (let i = 0; i < sourceCount; i++) {
    const source = sources.nth(i);

    addResourceUrl(
      urls,
      await source.getAttribute("src"),
      baseUrl,
    );

    const srcset =
      await source.getAttribute("srcset");

    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const url =
          candidate.trim().split(/\s+/)[0];

        addResourceUrl(
          urls,
          url,
          baseUrl,
        );
      }
    }
  }

  /*
   * <script src>
   */
  const scripts =
    page.locator("script[src]");

  const scriptCount =
    await scripts.count();

  for (let i = 0; i < scriptCount; i++) {
    addResourceUrl(
      urls,
      await scripts.nth(i).getAttribute("src"),
      baseUrl,
    );
  }

  /*
   * <video src>, <audio src>
   */
  const media =
    page.locator(
      "video[src], audio[src]"
    );

  const mediaCount =
    await media.count();

  for (let i = 0; i < mediaCount; i++) {
    addResourceUrl(
      urls,
      await media.nth(i).getAttribute("src"),
      baseUrl,
    );
  }

  /*
   * <video poster>
   */
  const posters =
    page.locator("video[poster]");

  const posterCount =
    await posters.count();

  for (let i = 0; i < posterCount; i++) {
    addResourceUrl(
      urls,
      await posters.nth(i).getAttribute("poster"),
      baseUrl,
    );
  }

  return [...urls];
}

/**
 * Rewrite HTML src/href attributes.
 *
 * Rules:
 *
 * 1. #anchor                 -> preserve
 * 2. mailto/javascript/data  -> preserve
 * 3. external URL            -> preserve
 * 4. internal page           -> local .html
 * 5. downloaded resource     -> local asset
 */
function rewriteHtml(
  html: string,
  pageUrl: string,
  resourceMap: Map<string, string>,
): string {
  return html.replace(
    /(src|href|poster)=("([^"]+)"|'([^']+)')/gi,
    (
      match,
      attribute,
      _quoted,
      doubleUrl,
      singleUrl,
    ) => {
      const rawUrl =
        doubleUrl ?? singleUrl;

      /*
       * Fragment-only anchors.
       */
      if (
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      /*
       * Non-HTTP URLs.
       */
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("mailto:") ||
        rawUrl.startsWith("javascript:") ||
        rawUrl.startsWith("tel:")
      ) {
        return match;
      }

      let absolute: URL;

      try {
        absolute =
          new URL(rawUrl, pageUrl);
      } catch {
        return match;
      }

      /*
       * External links stay external.
       */
      if (
        absolute.origin !== start.origin
      ) {
        return match;
      }

      /*
       * Save the fragment before normalization.
       */
      const hash =
        absolute.hash;

      absolute.hash = "";

      /*
       * Ignore query parameters in the
       * local copy, just like normalizeUrl().
       */
      const normalized =
        normalizeUrl(
          absolute.href,
        );

      /*
       * --------------------------------------------------------
       * IMPORTANT:
       * Internal documentation pages are checked FIRST.
       *
       * This prevents /docs/sustainability from ever being
       * interpreted as an asset.
       * --------------------------------------------------------
       */
      if (
        inScope(normalized)
      ) {
        const destination =
          pageOutputPath(normalized);

        let relative =
          path.relative(
            path.dirname(
              pageOutputPath(pageUrl),
            ),
            destination,
          );

        relative =
          relative
            .split(path.sep)
            .join("/");

        if (hash) {
          relative += hash;
        }

        return `${attribute}="${relative}"`;
      }

      /*
       * --------------------------------------------------------
       * Resource.
       * --------------------------------------------------------
       */
      const resourceDestination =
        resourceMap.get(normalized);

      if (
        resourceDestination
      ) {
        const relative =
          relativeAssetUrl(
            pageUrl,
            resourceDestination,
          );

        return `${attribute}="${relative}"`;
      }

      /*
       * Unknown internal URL:
       * leave it untouched rather than guessing.
       */
      return match;
    },
  );
}

/**
 * Download a resource using Playwright's request context.
 */
async function downloadResource(
  context: BrowserContext,
  resourceUrl: string,
): Promise<{
  body: Buffer;
  contentType: string;
} | null> {
  try {
    const response =
      await context.request.get(
        resourceUrl,
        {
          timeout: 60_000,
        },
      );

    if (!response.ok()) {
      console.log(
        `  resource ${response.status()}: ${resourceUrl}`,
      );

      return null;
    }

    return {
      body: await response.body(),
      contentType:
        response.headers()["content-type"] ?? "",
    };
  } catch {
    console.log(
      `  failed resource: ${resourceUrl}`,
    );

    return null;
  }
}

await fs.mkdir(
  outputDir,
  { recursive: true },
);

const browser =
  await chromium.launch();

const context =
  await browser.newContext();

const page =
  await context.newPage();

/*
 * ============================================================
 * PHASE 1: CRAWL
 * ============================================================
 */

console.log("=== PHASE 1: CRAWL ===");

const queue: string[] = [
  normalizeUrl(start.href),
];

const queued =
  new Set(queue);

const visited =
  new Set<string>();

/*
 * page URL -> HTML
 */
const pages =
  new Map<string, string>();

/*
 * resource URL -> metadata
 */
const resources =
  new Map<
    string,
    {
      contentType: string;
    }
  >();

while (
  queue.length > 0 &&
  visited.size < maxPages
  ) {
  const requestedUrl =
    queue.shift()!;

  if (
    visited.has(requestedUrl)
  ) {
    continue;
  }

  console.log(
    `→ ${requestedUrl}`,
  );

  try {
    const response =
      await page.goto(
        requestedUrl,
        {
          waitUntil: "networkidle",
          timeout: 60_000,
        },
      );

    if (!response) {
      console.log(
        "  no response",
      );

      continue;
    }

    const finalUrl =
      normalizeUrl(page.url());

    if (
      finalUrl !== requestedUrl
    ) {
      console.log(
        `  redirect → ${finalUrl}`,
      );
    }

    if (
      !inScope(finalUrl)
    ) {
      console.log(
        "  outside scope, skipping",
      );

      continue;
    }

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`,
      );

      continue;
    }

    /*
     * Give lazy-loaded assets a chance.
     */
    await page.waitForTimeout(1000);

    /*
     * Capture HTML.
     */
    const html =
      await page.content();

    pages.set(
      finalUrl,
      html,
    );

    visited.add(
      requestedUrl,
    );

    visited.add(
      finalUrl,
    );

    /*
     * Discover resources.
     */
    const pageResourceUrls =
      await collectResourceUrls(page);

    let newResources = 0;

    for (
      const resourceUrl of pageResourceUrls
      ) {
      if (
        isExternalNoise(
          resourceUrl,
        )
      ) {
        continue;
      }

      if (
        !resources.has(
          resourceUrl,
        )
      ) {
        resources.set(
          resourceUrl,
          {
            contentType: "",
          },
        );

        newResources++;
      }
    }

    console.log(
      `  captured ${pageResourceUrls.length} page resources (${newResources} new)`,
    );

    /*
     * Discover internal documentation links.
     *
     * No page.evaluate().
     */
    const anchors =
      page.locator("a[href]");

    const anchorCount =
      await anchors.count();

    let discovered = 0;

    for (
      let i = 0;
      i < anchorCount;
      i++
    ) {
      const href =
        await anchors
          .nth(i)
          .getAttribute("href");

      if (!href) {
        continue;
      }

      try {
        const url =
          new URL(
            href,
            finalUrl,
          );

        /*
         * Only HTTP(S).
         */
        if (
          url.protocol !== "http:" &&
          url.protocol !== "https:"
        ) {
          continue;
        }

        /*
         * Pure same-page anchors aren't pages.
         */
        if (
          url.pathname ===
          new URL(finalUrl).pathname &&
          url.search === "" &&
          url.hash
        ) {
          continue;
        }

        /*
         * External links aren't crawled.
         */
        if (
          !inScope(url.href)
        ) {
          continue;
        }

        const normalized =
          normalizeUrl(
            url.href,
          );

        if (
          !visited.has(normalized) &&
          !queued.has(normalized)
        ) {
          queue.push(
            normalized,
          );

          queued.add(
            normalized,
          );

          discovered++;
        }
      } catch {
        // Ignore malformed URLs.
      }
    }

    console.log(
      `  discovered ${discovered} new pages`,
    );
  } catch (error) {
    console.error(
      `  ERROR: ${error}`,
    );
  }
}

console.log();
console.log(
  `Phase 1 complete: ${pages.size} page URLs`,
);

if (visited.size >= maxPages && queue.length > 0) {
  console.log(`⚠️  Crawl stopped because MAX_PAGES=${maxPages} was reached.`);
  console.log(`    Pages crawled: ${visited.size}`);
  console.log(`    Pages remaining in queue: ${queue.length}`);
} else if (queue.length === 0) {
  console.log("✓ Crawl completed: queue is empty.");
  console.log(`  Pages crawled: ${visited.size}`);
} else {
  console.log("Crawl stopped for another reason.");
  console.log(`  Pages crawled: ${visited.size}`);
  console.log(`  Pages remaining in queue: ${queue.length}`);
}

console.log(
  `Resources discovered: ${resources.size}`,
);

/*
 * ============================================================
 * PHASE 2: DOWNLOAD RESOURCES
 * ============================================================
 */

console.log();
console.log(
  "=== PHASE 2: DOWNLOAD RESOURCES ===",
);

/*
 * resource URL -> local filesystem path
 */
const resourceMap =
  new Map<string, string>();

/*
 * resource URL -> content type
 */
const resourceContentTypes =
  new Map<string, string>();

let downloaded = 0;

for (
  const resourceUrl of resources.keys()
  ) {
  if (
    isExternalNoise(
      resourceUrl,
    )
  ) {
    continue;
  }

  const destination =
    assetOutputPath(
      resourceUrl,
    );

  try {
    await fs.mkdir(
      path.dirname(destination),
      {
        recursive: true,
      },
    );

    const result =
      await downloadResource(
        context,
        resourceUrl,
      );

    if (!result) {
      continue;
    }

    await fs.writeFile(
      destination,
      result.body,
    );

    const normalized =
      normalizeUrl(
        resourceUrl,
      );

    resourceMap.set(
      normalized,
      destination,
    );

    resourceContentTypes.set(
      normalized,
      result.contentType,
    );

    downloaded++;

    console.log(
      `  ${resourceUrl}`,
    );
  } catch {
    console.log(
      `  FAILED ${resourceUrl}`,
    );
  }
}

console.log();
console.log(
  `Downloaded ${downloaded} resources`,
);

/*
 * ============================================================
 * REWRITE CSS
 * ============================================================
 */

console.log();
console.log(
  "=== REWRITE CSS ===",
);

for (
  const [
    resourceUrl,
    destination,
  ] of resourceMap
  ) {
  const contentType =
    resourceContentTypes.get(
      resourceUrl,
    ) ?? "";

  if (
    !contentType.includes(
      "text/css",
    )
  ) {
    continue;
  }

  try {
    let css =
      await fs.readFile(
        destination,
        "utf8",
      );

    css =
      rewriteCss(
        css,
        resourceUrl,
        resourceMap,
      );

    await fs.writeFile(
      destination,
      css,
    );

    console.log(
      `  rewritten ${resourceUrl}`,
    );
  } catch {
    console.log(
      `  failed CSS ${resourceUrl}`,
    );
  }
}

/*
 * ============================================================
 * WRITE HTML
 * ============================================================
 */

console.log();
console.log(
  "=== WRITE HTML ===",
);

for (
  const [
    pageUrl,
    originalHtml,
  ] of pages
  ) {
  const html =
    rewriteHtml(
      originalHtml,
      pageUrl,
      resourceMap,
    );

  const destination =
    pageOutputPath(
      pageUrl,
    );

  await fs.mkdir(
    path.dirname(
      destination,
    ),
    {
      recursive: true,
    },
  );

  await fs.writeFile(
    destination,
    html,
  );

  console.log(
    `  ${destination}`,
  );
}

await browser.close();

console.log();
console.log(
  "================================",
);
console.log("DONE");
console.log(
  "================================",
);
console.log(
  `Pages:     ${pages.size}`,
);
console.log(
  `Resources: ${resourceMap.size}`,
);
console.log(
  `Output:    ${path.resolve(outputDir)}`,
);