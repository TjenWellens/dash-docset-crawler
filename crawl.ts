import { chromium, type BrowserContext, type Page, type Response } from "playwright";
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
 * Convert a page URL to its local HTML path.
 *
 * Example:
 *
 * https://orm.drizzle.team/docs/overview
 *
 * becomes:
 *
 * ./test-drizzle/orm.drizzle.team/docs/overview.html
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
    pathname
  );
}

/**
 * Convert an arbitrary resource URL to its local asset path.
 *
 * Example:
 *
 * https://orm.drizzle.team/_astro/foo.css
 *
 * becomes:
 *
 * ./test-drizzle/orm.drizzle.team/_assets/_astro/foo.css
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
    pathname
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
  assetUrl: string,
  destination: string
): string {
  const pagePath = pageOutputPath(pageUrl);

  const relative = path.relative(
    path.dirname(pagePath),
    destination
  );

  return relative
    .split(path.sep)
    .join("/");
}

/**
 * Rewrite url(...) references inside CSS.
 *
 * This handles things like:
 *
 *   url("../fonts/foo.woff2")
 *   url("/_astro/foo.webp")
 *
 * once the referenced resource has been downloaded.
 */
function rewriteCss(
  css: string,
  cssUrl: string,
  resourceMap: Map<string, string>
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      try {
        const absolute = normalizeUrl(
          new URL(rawUrl, cssUrl).href
        );

        const destination =
          resourceMap.get(absolute);

        if (!destination) {
          return match;
        }

        const relative =
          relativeAssetUrl(
            cssUrl,
            absolute,
            destination
          );

        return `url("${relative}")`;
      } catch {
        return match;
      }
    }
  );
}

/**
 * Collect resources referenced by the current page.
 *
 * IMPORTANT:
 * This deliberately does NOT use page.evaluate().
 *
 * tsx/esbuild can transform evaluate callbacks in a way that
 * introduces __name, which doesn't exist inside Playwright's
 * browser execution context.
 */
async function collectResourceUrls(
  page: Page
): Promise<string[]> {
  const urls = new Set<string>();

  const add = (value: string | null) => {
    if (!value) {
      return;
    }

    try {
      const absolute = new URL(
        value,
        page.url()
      );

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
  };

  // <link href="...">
  const links = page.locator("link[href]");
  const linkCount = await links.count();

  for (let i = 0; i < linkCount; i++) {
    add(
      await links
        .nth(i)
        .getAttribute("href")
    );
  }

  // <img src="...">
  const images = page.locator("img[src]");
  const imageCount = await images.count();

  for (let i = 0; i < imageCount; i++) {
    add(
      await images
        .nth(i)
        .getAttribute("src")
    );
  }

  // <source src="..."> / srcset
  const sources = page.locator("source");
  const sourceCount = await sources.count();

  for (let i = 0; i < sourceCount; i++) {
    const source = sources.nth(i);

    add(
      await source.getAttribute("src")
    );

    const srcset =
      await source.getAttribute("srcset");

    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const url = candidate
          .trim()
          .split(/\s+/)[0];

        if (url) {
          add(url);
        }
      }
    }
  }

  // <script src="...">
  const scripts = page.locator("script[src]");
  const scriptCount = await scripts.count();

  for (let i = 0; i < scriptCount; i++) {
    add(
      await scripts
        .nth(i)
        .getAttribute("src")
    );
  }

  // <video src> / <audio src>
  const media = page.locator(
    "video[src], audio[src]"
  );

  const mediaCount = await media.count();

  for (let i = 0; i < mediaCount; i++) {
    add(
      await media
        .nth(i)
        .getAttribute("src")
    );
  }

  return [...urls];
}

/**
 * Rewrite HTML src/href attributes.
 *
 * Important:
 *
 * - internal page links become local .html links
 * - #anchors remain #anchors
 * - mailto:, javascript:, data: remain untouched
 * - external URLs remain external
 * - downloaded resources become relative local paths
 */
function rewriteHtml(
  html: string,
  pageUrl: string,
  resourceMap: Map<string, string>
): string {
  return html.replace(
    /(src|href)=("([^"]+)"|'([^']+)')/gi,
    (
      match,
      attribute,
      quoted,
      doubleUrl,
      singleUrl
    ) => {
      const rawUrl =
        doubleUrl ?? singleUrl;

      if (
        rawUrl.startsWith("#") ||
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("mailto:") ||
        rawUrl.startsWith("javascript:")
      ) {
        return match;
      }

      try {
        const absolute = new URL(
          rawUrl,
          pageUrl
        );

        /*
         * External links should remain external.
         */
        if (
          absolute.origin !== start.origin
        ) {
          return match;
        }

        /*
         * Preserve internal anchors.
         */
        if (
          absolute.pathname ===
          new URL(pageUrl).pathname &&
          absolute.hash
        ) {
          return `${attribute}="${absolute.hash}"`;
        }

        absolute.hash = "";

        const normalized =
          normalizeUrl(absolute.href);

        /*
         * Resource?
         */
        const resourceDestination =
          resourceMap.get(normalized);

        if (resourceDestination) {
          const relative =
            relativeAssetUrl(
              pageUrl,
              normalized,
              resourceDestination
            );

          return `${attribute}="${relative}"`;
        }

        /*
         * Internal documentation page?
         */
        if (inScope(normalized)) {
          const destination =
            pageOutputPath(normalized);

          let relative = path.relative(
            path.dirname(
              pageOutputPath(pageUrl)
            ),
            destination
          );

          relative = relative
            .split(path.sep)
            .join("/");

          /*
           * Preserve an anchor if one existed.
           */
          if (absolute.hash) {
            relative += absolute.hash;
          }

          return `${attribute}="${relative}"`;
        }

        return match;
      } catch {
        return match;
      }
    }
  );
}

/**
 * Download a resource using Playwright's request context.
 */
async function downloadResource(
  context: BrowserContext,
  resourceUrl: string
): Promise<Buffer | null> {
  try {
    const response =
      await context.request.get(
        resourceUrl,
        {
          timeout: 60_000,
        }
      );

    if (!response.ok()) {
      console.log(
        `  resource ${response.status()}: ${resourceUrl}`
      );

      return null;
    }

    return await response.body();
  } catch (error) {
    console.log(
      `  failed resource: ${resourceUrl}`
    );

    return null;
  }
}

await fs.mkdir(
  outputDir,
  { recursive: true }
);

const browser = await chromium.launch();

const context =
  await browser.newContext();

const page =
  await context.newPage();

/*
 * ============================================================
 * PHASE 1
 * Crawl pages and discover resources.
 * ============================================================
 */

console.log("=== PHASE 1: CRAWL ===");

const queue: string[] = [
  normalizeUrl(start.href)
];

const queued = new Set(queue);
const visited = new Set<string>();

/*
 * page URL -> HTML
 */
const pages = new Map<
  string,
  string
>();

/*
 * resource URL -> metadata
 */
const resources = new Map<
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

  if (visited.has(requestedUrl)) {
    continue;
  }

  console.log(`→ ${requestedUrl}`);

  try {
    const response =
      await page.goto(
        requestedUrl,
        {
          waitUntil: "networkidle",
          timeout: 60_000,
        }
      );

    if (!response) {
      console.log("  no response");
      continue;
    }

    const finalUrl =
      normalizeUrl(page.url());

    if (
      finalUrl !== requestedUrl
    ) {
      console.log(
        `  redirect → ${finalUrl}`
      );
    }

    if (!inScope(finalUrl)) {
      console.log(
        "  outside scope, skipping"
      );

      continue;
    }

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );

      continue;
    }

    /*
     * Give lazy-loaded assets a chance to appear.
     */
    await page.waitForTimeout(1000);

    /*
     * Capture HTML.
     */
    const html =
      await page.content();

    pages.set(
      finalUrl,
      html
    );

    visited.add(requestedUrl);
    visited.add(finalUrl);

    /*
     * Discover resources referenced by HTML.
     */
    const pageResourceUrls =
      await collectResourceUrls(page);

    let newResources = 0;

    for (
      const resourceUrl of pageResourceUrls
      ) {
      if (
        isExternalNoise(resourceUrl)
      ) {
        continue;
      }

      if (
        !resources.has(resourceUrl)
      ) {
        resources.set(
          resourceUrl,
          {
            contentType: "",
          }
        );

        newResources++;
      }
    }

    console.log(
      `  captured ${pageResourceUrls.length} page resources (${newResources} new)`
    );

    /*
     * Discover internal documentation links.
     *
     * No page.evaluate() here either.
     */
    const links: string[] = [];

    const anchors =
      page.locator("a[href]");

    const anchorCount =
      await anchors.count();

    for (
      let i = 0;
      i < anchorCount;
      i++
    ) {
      const href =
        await anchors
          .nth(i)
          .getAttribute("href");

      if (href) {
        links.push(href);
      }
    }

    let discovered = 0;

    for (const href of links) {
      try {
        const url =
          new URL(
            href,
            finalUrl
          );

        /*
         * Ignore external links.
         */
        if (
          url.protocol !== "http:" &&
          url.protocol !== "https:"
        ) {
          continue;
        }

        /*
         * Ignore pure anchors.
         */
        if (
          url.pathname ===
          new URL(finalUrl).pathname &&
          url.hash &&
          !url.search
        ) {
          continue;
        }

        if (
          !inScope(url.href)
        ) {
          continue;
        }

        const normalized =
          normalizeUrl(url.href);

        if (
          !visited.has(normalized) &&
          !queued.has(normalized)
        ) {
          queue.push(normalized);
          queued.add(normalized);
          discovered++;
        }
      } catch {
        // Ignore malformed URLs.
      }
    }

    console.log(
      `  discovered ${discovered} new pages`
    );
  } catch (error) {
    console.error(
      `  ERROR: ${error}`
    );
  }
}

console.log();
console.log(
  `Phase 1 complete: ${pages.size} page URLs`
);

console.log(
  `Resources discovered: ${resources.size}`
);

/*
 * ============================================================
 * PHASE 2
 * Download all resources.
 * ============================================================
 */

console.log();
console.log(
  "=== PHASE 2: DOWNLOAD RESOURCES ==="
);

/*
 * resource URL -> local filesystem path
 */
const resourceMap =
  new Map<string, string>();

let downloaded = 0;

for (
  const resourceUrl of resources.keys()
  ) {
  /*
   * Skip things we don't want in
   * an offline documentation set.
   */
  if (
    isExternalNoise(resourceUrl)
  ) {
    continue;
  }

  const destination =
    assetOutputPath(resourceUrl);

  try {
    await fs.mkdir(
      path.dirname(destination),
      {
        recursive: true,
      }
    );

    const body =
      await downloadResource(
        context,
        resourceUrl
      );

    if (!body) {
      continue;
    }

    await fs.writeFile(
      destination,
      body
    );

    resourceMap.set(
      normalizeUrl(resourceUrl),
      destination
    );

    downloaded++;

    console.log(
      `  ${resourceUrl}`
    );
  } catch (error) {
    console.log(
      `  FAILED ${resourceUrl}`
    );
  }
}

console.log();
console.log(
  `Downloaded ${downloaded} resources`
);

/*
 * ============================================================
 * Rewrite CSS
 * ============================================================
 */

console.log();
console.log(
  "=== REWRITE CSS ==="
);

for (
  const [
    resourceUrl,
    destination
  ] of resourceMap
  ) {
  /*
   * Only inspect resources that are
   * actually CSS.
   */
  let contentType = "";

  try {
    const response =
      await context.request.get(
        resourceUrl,
        {
          timeout: 60_000,
        }
      );

    contentType =
      response.headers()[
        "content-type"
        ] ?? "";
  } catch {
    continue;
  }

  if (
    !contentType.includes(
      "text/css"
    )
  ) {
    continue;
  }

  try {
    let css =
      await fs.readFile(
        destination,
        "utf8"
      );

    css = rewriteCss(
      css,
      resourceUrl,
      resourceMap
    );

    await fs.writeFile(
      destination,
      css
    );

    console.log(
      `  rewritten ${resourceUrl}`
    );
  } catch {
    console.log(
      `  failed CSS ${resourceUrl}`
    );
  }
}

/*
 * ============================================================
 * Write HTML
 * ============================================================
 */

console.log();
console.log(
  "=== WRITE HTML ==="
);

for (
  const [
    pageUrl,
    originalHtml
  ] of pages
  ) {
  const html =
    rewriteHtml(
      originalHtml,
      pageUrl,
      resourceMap
    );

  const destination =
    pageOutputPath(pageUrl);

  await fs.mkdir(
    path.dirname(destination),
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    destination,
    html
  );

  console.log(
    `  ${destination}`
  );
}

await browser.close();

console.log();
console.log(
  "================================"
);
console.log("DONE");
console.log(
  "================================"
);
console.log(
  `Pages:     ${pages.size}`
);
console.log(
  `Resources: ${resourceMap.size}`
);
console.log(
  `Output:    ${path.resolve(outputDir)}`
);