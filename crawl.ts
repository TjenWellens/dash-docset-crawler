import { chromium, type Response } from "playwright";
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

/*
 * --------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------
 */

type Resource = {
  body: Buffer;
  contentType: string;
  originalUrl: string;
};

/*
 * --------------------------------------------------------------------------
 * URL helpers
 * --------------------------------------------------------------------------
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
 * --------------------------------------------------------------------------
 * Output paths
 * --------------------------------------------------------------------------
 *
 * Pages:
 *
 *   https://example.com/docs/foo
 *     ->
 *   output/example.com/docs/foo.html
 *
 * Assets:
 *
 *   https://example.com/_astro/foo.css
 *     ->
 *   output/example.com/_assets/_astro/foo.css
 *
 * We deliberately put assets in _assets so they cannot collide with
 * generated HTML pages.
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
 * --------------------------------------------------------------------------
 * External noise
 * --------------------------------------------------------------------------
 *
 * These are normally analytics/search/tracking resources that don't belong
 * in an offline documentation copy.
 */

function isExternalNoise(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname;

    return (
      hostname.includes("google-analytics") ||
      hostname.includes("googletagmanager") ||
      hostname.includes("analytics") ||
      hostname.includes("ahrefs") ||
      hostname.includes("algolia") ||
      hostname.includes("onedollarstats") ||
      hostname.includes("doubleclick") ||
      hostname.includes("segment.io") ||
      hostname.includes("sentry.io")
    );
  } catch {
    return true;
  }
}

/*
 * --------------------------------------------------------------------------
 * Resource detection
 * --------------------------------------------------------------------------
 *
 * We capture basically anything that can contribute to rendering.
 *
 * This intentionally isn't restricted to CSS/images/fonts. Modern docs
 * sites frequently load SVGs, JSON configuration, JS chunks, media, etc.
 */

function shouldCapture(response: Response): boolean {
  const url = response.url();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }

  const type = response.request().resourceType();

  if (
    type === "stylesheet" ||
    type === "script" ||
    type === "font" ||
    type === "image" ||
    type === "media"
  ) {
    return true;
  }

  const contentType =
    response.headers()["content-type"] ?? "";

  if (
    contentType.includes("text/css") ||
    contentType.includes("javascript") ||
    contentType.includes("application/javascript") ||
    contentType.startsWith("font/") ||
    contentType.includes("application/font") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/")
  ) {
    return true;
  }

  /*
   * Some sites serve assets with generic content types.
   *
   * These extensions are useful fallbacks.
   */
  const pathname = new URL(url).pathname.toLowerCase();

  if (
    /\.(css|js|mjs|cjs|woff|woff2|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|wav)$/i.test(
      pathname
    )
  ) {
    return true;
  }

  return false;
}

/*
 * --------------------------------------------------------------------------
 * Relative path helpers
 * --------------------------------------------------------------------------
 */

function relativeAssetUrl(
  pageUrl: string,
  destination: string
): string {
  const pagePath = pageOutputPath(pageUrl);

  const relative = path.relative(
    path.dirname(pagePath),
    destination
  );

  return relative.split(path.sep).join("/");
}

function relativeDocumentUrl(
  fromPageUrl: string,
  destination: string
): string {
  const fromPath = pageOutputPath(fromPageUrl);

  const relative = path.relative(
    path.dirname(fromPath),
    destination
  );

  return relative.split(path.sep).join("/");
}

/*
 * --------------------------------------------------------------------------
 * CSS rewriting
 * --------------------------------------------------------------------------
 *
 * Rewrites things such as:
 *
 *   url("/_astro/foo.woff2")
 *   url("../images/foo.png")
 *   url("./foo.svg")
 *
 * into paths relative to the generated CSS file.
 */

function rewriteCss(
  css: string,
  cssUrl: string,
  assetMap: Map<string, string>
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      const value = rawUrl.trim();

      if (
        value.startsWith("data:") ||
        value.startsWith("#") ||
        value.startsWith("blob:") ||
        value.startsWith("http://") ||
        value.startsWith("https://") ||
        value.startsWith("//")
      ) {
        return match;
      }

      try {
        const absolute = normalizeUrl(
          new URL(value, cssUrl).href
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

/*
 * --------------------------------------------------------------------------
 * HTML asset rewriting
 * --------------------------------------------------------------------------
 *
 * Handles:
 *
 *   href="/preferred.css"
 *   src="/_astro/foo.js"
 *   src="/images/foo.png"
 *   href="/favicon.ico"
 *   src="../images/foo.png"
 *
 * It deliberately does NOT rewrite:
 *
 *   #heading
 *   mailto:
 *   javascript:
 *   data:
 *   external URLs
 *
 * Document links are handled separately.
 */

function rewriteHtmlAssets(
  html: string,
  pageUrl: string,
  assetMap: Map<string, string>
): string {
  return html.replace(
    /(src|href)=("([^"]+)"|'([^']+)')/gi,
    (match, attribute, _quoted, doubleUrl, singleUrl) => {
      const rawUrl = doubleUrl ?? singleUrl;

      if (
        rawUrl.startsWith("#") ||
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("mailto:") ||
        rawUrl.startsWith("javascript:") ||
        rawUrl.startsWith("tel:") ||
        rawUrl.startsWith("blob:")
      ) {
        return match;
      }

      let absolute: string;

      try {
        absolute = normalizeUrl(
          new URL(rawUrl, pageUrl).href
        );
      } catch {
        return match;
      }

      /*
       * Only rewrite if this URL is an asset we actually downloaded.
       *
       * This is the important part: because this happens in phase 2,
       * assetMap now contains resources collected across the ENTIRE crawl.
       */
      const destination = assetMap.get(absolute);

      if (!destination) {
        return match;
      }

      const relative = relativeAssetUrl(
        pageUrl,
        destination
      );

      return `${attribute}="${relative}"`;
    }
  );
}

/*
 * --------------------------------------------------------------------------
 * Internal document link rewriting
 * --------------------------------------------------------------------------
 *
 * Example:
 *
 *   /docs/get-started
 *
 * becomes:
 *
 *   get-started.html
 *
 * while:
 *
 *   /docs/get-started#postgres
 *
 * becomes:
 *
 *   get-started.html#postgres
 *
 * External links remain untouched.
 */

function rewriteInternalLinks(
  html: string,
  pageUrl: string,
  pageMap: Map<string, string>
): string {
  return html.replace(
    /(href)=("([^"]+)"|'([^']+)')/gi,
    (match, attribute, _quoted, doubleUrl, singleUrl) => {
      const rawUrl = doubleUrl ?? singleUrl;

      /*
       * Preserve fragments.
       */
      if (rawUrl.startsWith("#")) {
        return match;
      }

      /*
       * Preserve non-document URLs.
       */
      if (
        rawUrl.startsWith("mailto:") ||
        rawUrl.startsWith("javascript:") ||
        rawUrl.startsWith("tel:") ||
        rawUrl.startsWith("data:")
      ) {
        return match;
      }

      let parsed: URL;

      try {
        parsed = new URL(rawUrl, pageUrl);
      } catch {
        return match;
      }

      /*
       * Preserve external links.
       */
      if (parsed.origin !== start.origin) {
        return match;
      }

      const normalized = normalizeUrl(parsed.href);

      /*
       * Only rewrite pages that were actually crawled.
       */
      const destination = pageMap.get(normalized);

      if (!destination) {
        return match;
      }

      const relative = relativeDocumentUrl(
        pageUrl,
        destination
      );

      /*
       * Keep the original #anchor.
       */
      const fragment = parsed.hash;

      return `${attribute}="${relative}${fragment}"`;
    }
  );
}

/*
 * --------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------
 */

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();

const page = await browser.newPage();

/*
 * Global maps.
 *
 * IMPORTANT:
 *
 * These survive the entire crawl. We do NOT recreate them for every page.
 */

const resources = new Map<string, Resource>();

const pages = new Map<string, string>();

const queue: string[] = [
  normalizeUrl(start.href),
];

const queued = new Set(queue);

const visited = new Set<string>();

/*
 * ==========================================================================
 * PHASE 1 — CRAWL
 * ==========================================================================
 *
 * Download pages and resources.
 *
 * We do NOT rewrite anything yet.
 */

console.log();
console.log("=== PHASE 1: CRAWL ===");
console.log();

while (
  queue.length > 0 &&
  visited.size < maxPages
) {
  const requestedUrl = queue.shift()!;

  if (visited.has(requestedUrl)) {
    continue;
  }

  console.log(`→ ${requestedUrl}`);

  const pageResources = new Map<string, Resource>();

  const responseHandler = async (
    response: Response
  ) => {
    try {
      if (!shouldCapture(response)) {
        return;
      }

      if (isExternalNoise(response.url())) {
        return;
      }

      const normalized = normalizeUrl(
        response.url()
      );

      /*
       * Don't download resources outside the site.
       *
       * This keeps the docset focused on the documentation site.
       */
      if (!inScope(normalized)) {
        return;
      }

      const body = await response.body();

      const resource: Resource = {
        body,
        contentType:
          response.headers()["content-type"] ?? "",
        originalUrl: normalized,
      };

      /*
       * Store globally.
       *
       * This is what makes phase 2 deterministic.
       */
      resources.set(normalized, resource);

      pageResources.set(normalized, resource);
    } catch {
      /*
       * Some browser responses cannot be read.
       */
    }
  };

  page.on("response", responseHandler);

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
      page.off("response", responseHandler);
      continue;
    }

    const finalUrl = normalizeUrl(
      page.url()
    );

    if (finalUrl !== requestedUrl) {
      console.log(
        `  redirect → ${finalUrl}`
      );
    }

    if (!inScope(finalUrl)) {
      console.log(
        "  outside scope, skipping"
      );

      page.off("response", responseHandler);
      continue;
    }

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );

      page.off("response", responseHandler);
      continue;
    }

    /*
     * Give lazy-loaded resources a chance to appear.
     */
    await page.waitForTimeout(1000);

    /*
     * Capture the rendered HTML exactly as the browser sees it.
     */
    const html = await page.content();

    const destination =
      pageOutputPath(finalUrl);

    pages.set(finalUrl, destination);

    await fs.mkdir(
      path.dirname(destination),
      { recursive: true }
    );

    /*
     * Save the unmodified HTML for now.
     *
     * It will be rewritten in phase 2.
     */
    await fs.writeFile(
      destination,
      html
    );

    visited.add(requestedUrl);
    visited.add(finalUrl);

    console.log(
      `  captured ${pageResources.size} page resources`
    );

    /*
     * Discover links.
     */
    const links =
      await page.locator("a[href]").evaluateAll(
        (anchors) =>
          anchors
            .map(
              (a) =>
                (a as HTMLAnchorElement).href
            )
            .filter(Boolean)
      );

    let discovered = 0;

    for (const href of links) {
      try {
        const parsed = new URL(href);

        /*
         * Ignore external links.
         */
        if (
          parsed.origin !== start.origin
        ) {
          continue;
        }

        const normalized =
          normalizeUrl(parsed.href);

        if (
          inScope(normalized) &&
          !visited.has(normalized) &&
          !queued.has(normalized)
        ) {
          queue.push(normalized);
          queued.add(normalized);
          discovered++;
        }
      } catch {
        /*
         * Ignore malformed URLs.
         */
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

  page.off(
    "response",
    responseHandler
  );
}

await browser.close();

console.log();
console.log(
  `Crawl complete: ${visited.size} URLs`
);
console.log(
  `Downloaded ${resources.size} unique assets`
);

/*
 * ==========================================================================
 * PHASE 2 — WRITE ASSETS + REWRITE EVERYTHING
 * ==========================================================================
 */

console.log();
console.log("=== PHASE 2: REWRITE ===");
console.log();

/*
 * Build the complete asset map.
 *
 * At this point we have resources from every page.
 */

const assetMap =
  new Map<string, string>();

for (const [
  url,
  resource,
] of resources) {
  const destination =
    assetOutputPath(url);

  assetMap.set(
    url,
    destination
  );

  await fs.mkdir(
    path.dirname(destination),
    { recursive: true }
  );

  await fs.writeFile(
    destination,
    resource.body
  );
}

console.log(
  `Wrote ${assetMap.size} assets`
);

/*
 * Rewrite CSS files.
 *
 * CSS can reference other assets, so this happens after the complete
 * asset map has been constructed.
 */

let rewrittenCss = 0;

for (const [
  url,
  resource,
] of resources) {
  if (
    !resource.contentType.includes(
      "text/css"
    ) &&
    !url.toLowerCase().endsWith(".css")
  ) {
    continue;
  }

  const destination =
    assetMap.get(url);

  if (!destination) {
    continue;
  }

  let css =
    resource.body.toString("utf8");

  css = rewriteCss(
    css,
    url,
    assetMap
  );

  await fs.writeFile(
    destination,
    css
  );

  rewrittenCss++;
}

console.log(
  `Rewrote ${rewrittenCss} CSS files`
);

/*
 * Rewrite HTML.
 *
 * Order matters:
 *
 *   1. assets
 *   2. internal document links
 *
 * Anchors and external links are preserved.
 */

let rewrittenPages = 0;

for (const [
  pageUrl,
  destination,
] of pages) {
  let html =
    await fs.readFile(
      destination,
      "utf8"
    );

  html = rewriteHtmlAssets(
    html,
    pageUrl,
    assetMap
  );

  html = rewriteInternalLinks(
    html,
    pageUrl,
    pages
  );

  await fs.writeFile(
    destination,
    html
  );

  rewrittenPages++;

  console.log(
    `  rewritten ${destination}`
  );
}

console.log();
console.log(
  `Rewrote ${rewrittenPages} HTML pages`
);

console.log();
console.log("Done.");
console.log();
console.log(`Pages:   ${pages.size}`);
console.log(`Assets:  ${assetMap.size}`);
console.log(`Output:  ${path.resolve(outputDir)}`);
console.log();
