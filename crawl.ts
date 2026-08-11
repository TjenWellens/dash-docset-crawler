import { chromium } from "playwright";
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

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  url.hash = "";
  url.search = "";

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}

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

/*
 * Output HTML path.
 *
 * Example:
 *
 * https://orm.drizzle.team/docs/overview
 *
 * -> orm.drizzle.team/docs/overview.html
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

  return path.join(outputDir, url.hostname, pathname);
}

/*
 * All non-HTML resources live under:

   hostname/_assets/...

 * We deliberately preserve the original URL path.
 *
 * Example:
 *
 * https://orm.drizzle.team/_astro/foo.css
 *
 * -> orm.drizzle.team/_assets/_astro/foo.css
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

/*
 * External resources from analytics/search/etc. aren't useful offline.
 *
 * IMPORTANT:
 * We do NOT exclude external links in HTML.
 *
 * This only applies to resources such as:
 *
 * <script src="https://...">
 * <img src="https://...">
 * <link href="https://...">
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

function isHttpUrl(raw: string): boolean {
  return (
    raw.startsWith("http://") ||
    raw.startsWith("https://")
  );
}

/* -------------------------------------------------------------------------- */
/* CSS rewriting                                                              */
/* -------------------------------------------------------------------------- */

function rewriteCss(
  css: string,
  cssUrl: string,
  assetMap: Map<string, string>
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

        const destination = assetMap.get(absolute);

        if (!destination) {
          return match;
        }

        const relative = relativeAssetUrl(
          cssUrl,
          destination
        );

        return `url("${relative}")`;
      } catch {
        return match;
      }
    }
  );
}

function relativeAssetUrl(
  pageOrAssetUrl: string,
  destination: string
): string {
  /*
   * We need the output path corresponding to pageOrAssetUrl.
   *
   * For a CSS file:
   *
   * orm.drizzle.team/_assets/_astro/foo.css
   *
   * the relative path must be calculated from that CSS file.
   */

  const source = assetMapPath(pageOrAssetUrl);

  let relative = path.relative(
    path.dirname(source),
    destination
  );

  return relative.split(path.sep).join("/");
}

function assetMapPath(raw: string): string {
  return assetOutputPath(raw);
}

/* -------------------------------------------------------------------------- */
/* Resource discovery                                                         */
/* -------------------------------------------------------------------------- */

function resolveUrl(
  raw: string,
  baseUrl: string
): string | null {
  if (
    raw.startsWith("#") ||
    raw.startsWith("data:") ||
    raw.startsWith("mailto:") ||
    raw.startsWith("javascript:") ||
    raw.startsWith("tel:")
  ) {
    return null;
  }

  try {
    return normalizeUrl(
      new URL(raw, baseUrl).href
    );
  } catch {
    return null;
  }
}

/*
 * Extract resource references directly from HTML.
 *
 * This is intentionally broader than Playwright's resourceType().
 *
 * We want:
 *
 *   <link href="...">
 *   <script src="...">
 *   <img src="...">
 *   <img srcset="...">
 *   <source src="...">
 *   <source srcset="...">
 *   <video poster="...">
 *   <audio src="...">
 *   <iframe src="...">
 *   <object data="...">
 *
 * and CSS:
 *
 *   url(...)
 */
async function discoverResources(
  page: import("playwright").Page,
  pageUrl: string
): Promise<Set<string>> {
  const urls = new Set<string>();

  const found = await page.evaluate(() => {
    const result: string[] = [];

    function add(value: string | null) {
      if (value) {
        result.push(value);
      }
    }

    document
      .querySelectorAll("link[href]")
      .forEach((el) => {
        add(el.getAttribute("href"));
      });

    document
      .querySelectorAll("script[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("img[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("img[srcset]")
      .forEach((el) => {
        const srcset = el.getAttribute("srcset");

        if (srcset) {
          for (const item of srcset.split(",")) {
            const url = item.trim().split(/\s+/)[0];

            if (url) {
              result.push(url);
            }
          }
        }
      });

    document
      .querySelectorAll("source[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("source[srcset]")
      .forEach((el) => {
        const srcset = el.getAttribute("srcset");

        if (srcset) {
          for (const item of srcset.split(",")) {
            const url = item.trim().split(/\s+/)[0];

            if (url) {
              result.push(url);
            }
          }
        }
      });

    document
      .querySelectorAll("video[poster]")
      .forEach((el) => {
        add(el.getAttribute("poster"));
      });

    document
      .querySelectorAll("video[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("audio[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("iframe[src]")
      .forEach((el) => {
        add(el.getAttribute("src"));
      });

    document
      .querySelectorAll("object[data]")
      .forEach((el) => {
        add(el.getAttribute("data"));
      });

    return result;
  });

  for (const raw of found) {
    const resolved = resolveUrl(raw, pageUrl);

    if (!resolved) {
      continue;
    }

    if (isExternalNoise(resolved)) {
      continue;
    }

    urls.add(resolved);
  }

  /*
   * Also inspect inline styles for url(...).
   */
  const inlineCssUrls = await page.evaluate(() => {
    const result: string[] = [];

    for (const el of document.querySelectorAll("[style]")) {
      const style = el.getAttribute("style") ?? "";

      const matches = style.matchAll(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
      );

      for (const match of matches) {
        result.push(match[2]);
      }
    }

    return result;
  });

  for (const raw of inlineCssUrls) {
    const resolved = resolveUrl(raw, pageUrl);

    if (resolved && !isExternalNoise(resolved)) {
      urls.add(resolved);
    }
  }

  return urls;
}

/* -------------------------------------------------------------------------- */
/* HTML rewriting                                                             */
/* -------------------------------------------------------------------------- */

function rewriteHtmlUrls(
  html: string,
  pageUrl: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, string>
): string {
  /*
   * Rewrite normal src/href/data/poster attributes.
   *
   * Important:
   *
   * - internal documentation links become local .html links
   * - #anchors remain #anchors
   * - external links remain external
   * - internal assets become relative _assets links
   */

  html = html.replace(
    /(href|src|poster|data)=("([^"]*)"|'([^']*)')/gi,
    (match, attribute, quoted, doubleValue, singleValue) => {
      const rawValue = doubleValue ?? singleValue;

      if (
        rawValue.startsWith("#") ||
        rawValue.startsWith("data:") ||
        rawValue.startsWith("mailto:") ||
        rawValue.startsWith("javascript:") ||
        rawValue.startsWith("tel:")
      ) {
        return match;
      }

      let absolute: string;

      try {
        absolute = normalizeUrl(
          new URL(rawValue, pageUrl).href
        );
      } catch {
        return match;
      }

      /*
       * Internal documentation page.
       */
      const pageDestination = pageMap.get(absolute);

      if (pageDestination) {
        const relative = path
          .relative(
            path.dirname(pageOutputPath(pageUrl)),
            pageDestination
          )
          .split(path.sep)
          .join("/");

        return `${attribute}="${relative}"`;
      }

      /*
       * Local asset.
       */
      const assetDestination = assetMap.get(absolute);

      if (assetDestination) {
        const relative = path
          .relative(
            path.dirname(pageOutputPath(pageUrl)),
            assetDestination
          )
          .split(path.sep)
          .join("/");

        return `${attribute}="${relative}"`;
      }

      /*
       * External URL.
       *
       * Preserve it exactly as external.
       */
      return match;
    }
  );

  /*
   * srcset needs special handling because it contains multiple URLs.
   */
  html = html.replace(
    /(srcset)=("([^"]*)"|'([^']*)')/gi,
    (match, attribute, quoted, doubleValue, singleValue) => {
      const rawValue = doubleValue ?? singleValue;

      const rewritten = rawValue
        .split(",")
        .map((item: string) => {
          const parts = item.trim().split(/\s+/);

          if (!parts[0]) {
            return item;
          }

          try {
            const absolute = normalizeUrl(
              new URL(parts[0], pageUrl).href
            );

            const destination =
              assetMap.get(absolute);

            if (!destination) {
              return item;
            }

            const relative = path
              .relative(
                path.dirname(pageOutputPath(pageUrl)),
                destination
              )
              .split(path.sep)
              .join("/");

            parts[0] = relative;

            return parts.join(" ");
          } catch {
            return item;
          }
        })
        .join(", ");

      return `${attribute}="${rewritten}"`;
    }
  );

  return html;
}

/* -------------------------------------------------------------------------- */
/* Phase 1: crawl pages                                                       */
/* -------------------------------------------------------------------------- */

type PageRecord = {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  resources: string[];
};

const pages = new Map<string, PageRecord>();
const allResourceUrls = new Set<string>();

await fs.mkdir(outputDir, {
  recursive: true,
});

const browser = await chromium.launch();

const page = await browser.newPage();

const queue: string[] = [
  normalizeUrl(start.href),
];

const queued = new Set(queue);

console.log("=== PHASE 1: CRAWL ===");

while (
  queue.length > 0 &&
  pages.size < maxPages
) {
  const requestedUrl = queue.shift()!;

  if (pages.has(requestedUrl)) {
    continue;
  }

  console.log(`→ ${requestedUrl}`);

  try {
    const response = await page.goto(
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

    const finalUrl = normalizeUrl(page.url());

    if (finalUrl !== requestedUrl) {
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
     * Give lazy-loaded content a chance to render.
     */
    await page.waitForTimeout(500);

    const html = await page.content();

    /*
     * Discover assets from the DOM.
     */
    const resources =
      await discoverResources(
        page,
        finalUrl
      );

    for (const resource of resources) {
      allResourceUrls.add(resource);
    }

    /*
     * Discover internal documentation links.
     */
    const links =
      await page.locator("a[href]")
        .evaluateAll(
          (anchors) =>
            anchors
              .map((a) =>
                (a as HTMLAnchorElement).href
              )
              .filter(Boolean)
        );

    let discovered = 0;

    for (const href of links) {
      try {
        /*
         * Do not remove # anchors from the href
         * before checking them here.
         *
         * normalizeUrl() removes them for the
         * page identity.
         */
        const normalized =
          normalizeUrl(href);

        if (
          inScope(normalized) &&
          !pages.has(normalized) &&
          !queued.has(normalized)
        ) {
          queue.push(normalized);
          queued.add(normalized);
          discovered++;
        }
      } catch {
        // Ignore malformed links.
      }
    }

    pages.set(finalUrl, {
      requestedUrl,
      finalUrl,
      html,
      resources: [...resources],
    });

    /*
     * A redirect means the requested URL and final URL
     * refer to the same page.
     */
    pages.set(requestedUrl, {
      requestedUrl,
      finalUrl,
      html,
      resources: [...resources],
    });

    console.log(
      `  captured ${resources.size} page resources`
    );

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
  `Resources discovered: ${allResourceUrls.size}`
);

/* -------------------------------------------------------------------------- */
/* Build page map                                                              */
/* -------------------------------------------------------------------------- */

const pageMap = new Map<string, string>();

for (const [url] of pages) {
  const record = pages.get(url)!;

  pageMap.set(
    url,
    pageOutputPath(record.finalUrl)
  );
}

/* -------------------------------------------------------------------------- */
/* Phase 2: download resources                                                 */
/* -------------------------------------------------------------------------- */

console.log();
console.log("=== PHASE 2: DOWNLOAD RESOURCES ===");

const assetMap = new Map<string, string>();

for (const url of allResourceUrls) {
  /*
   * Don't download documentation pages accidentally discovered
   * as resources.
   */
  if (inScope(url)) {
    const pathname =
      new URL(url).pathname;

    /*
     * A root-relative /docs/foo URL should be a page,
     * not an asset.
     */
    if (
      pathname === start.pathname ||
      pathname.startsWith(scopePath)
    ) {
      continue;
    }
  }

  const destination =
    assetOutputPath(url);

  try {
    console.log(`→ ${url}`);

    const response =
      await page.request.get(url, {
        timeout: 60_000,
      });

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );
      continue;
    }

    const body =
      await response.body();

    const contentType =
      response.headers()["content-type"] ?? "";

    await fs.mkdir(
      path.dirname(destination),
      {
        recursive: true,
      }
    );

    /*
     * CSS may contain additional resources:
     *
     *   url(...)
     *
     * We need to discover those before rewriting.
     */
    if (
      contentType.includes("text/css")
    ) {
      const css =
        body.toString("utf8");

      const matches =
        css.matchAll(
          /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
        );

      for (const match of matches) {
        const raw = match[2];

        if (
          raw.startsWith("data:") ||
          raw.startsWith("#")
        ) {
          continue;
        }

        try {
          const absolute =
            normalizeUrl(
              new URL(
                raw,
                url
              ).href
            );

          if (
            !isExternalNoise(absolute)
          ) {
            allResourceUrls.add(
              absolute
            );
          }
        } catch {
          // Ignore malformed CSS URLs.
        }
      }
    }

    await fs.writeFile(
      destination,
      body
    );

    assetMap.set(
      normalizeUrl(url),
      destination
    );

    console.log(
      `  saved ${destination}`
    );
  } catch (error) {
    console.error(
      `  ERROR: ${error}`
    );
  }
}

/*
 * CSS can have introduced new assets.
 *
 * Download any CSS dependencies we discovered
 * during the previous loop.
 */
for (const url of allResourceUrls) {
  if (assetMap.has(url)) {
    continue;
  }

  if (isExternalNoise(url)) {
    continue;
  }

  /*
   * Don't download documentation pages.
   */
  if (
    inScope(url) &&
    (
      new URL(url).pathname ===
        start.pathname ||
      new URL(url).pathname.startsWith(
        scopePath
      )
    )
  ) {
    continue;
  }

  const destination =
    assetOutputPath(url);

  try {
    console.log(
      `→ CSS dependency ${url}`
    );

    const response =
      await page.request.get(url, {
        timeout: 60_000,
      });

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );
      continue;
    }

    const body =
      await response.body();

    await fs.mkdir(
      path.dirname(destination),
      {
        recursive: true,
      }
    );

    await fs.writeFile(
      destination,
      body
    );

    assetMap.set(
      normalizeUrl(url),
      destination
    );
  } catch (error) {
    console.error(
      `  ERROR: ${error}`
    );
  }
}

console.log();
console.log(
  `Downloaded ${assetMap.size} resources`
);

/* -------------------------------------------------------------------------- */
/* Phase 2b: rewrite CSS                                                       */
/* -------------------------------------------------------------------------- */

console.log();
console.log("=== REWRITE CSS ===");

for (const [url, destination] of assetMap) {
  try {
    const ext =
      path.extname(
        new URL(url).pathname
      ).toLowerCase();

    if (ext !== ".css") {
      continue;
    }

    let css =
      await fs.readFile(
        destination,
        "utf8"
      );

    css = rewriteCss(
      css,
      url,
      assetMap
    );

    await fs.writeFile(
      destination,
      css
    );

    console.log(
      `→ rewritten ${url}`
    );
  } catch (error) {
    console.error(
      `  ERROR rewriting ${url}:`,
      error
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 3: write HTML                                                        */
/* -------------------------------------------------------------------------- */

console.log();
console.log("=== WRITE HTML ===");

const written = new Set<string>();

for (const record of pages.values()) {
  const finalUrl =
    record.finalUrl;

  if (written.has(finalUrl)) {
    continue;
  }

  written.add(finalUrl);

  const destination =
    pageOutputPath(finalUrl);

  let html =
    rewriteHtmlUrls(
      record.html,
      finalUrl,
      pageMap,
      assetMap
    );

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
    `→ ${destination}`
  );
}

/* -------------------------------------------------------------------------- */
/* Done                                                                       */
/* -------------------------------------------------------------------------- */

await browser.close();

console.log();
console.log("================================");
console.log("DONE");
console.log("================================");
console.log(
  `Pages:     ${written.size}`
);
console.log(
  `Resources: ${assetMap.size}`
);
console.log(
  `Output:    ${path.resolve(outputDir)}`
);
