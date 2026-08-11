import {chromium, type Response} from "playwright";
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
 * Normalize a URL for use as a crawl key.
 *
 * - removes hash
 * - removes query string
 * - removes trailing slash except for "/"
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
 * Is this URL part of the documentation we're crawling?
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
 * Convert a crawled page URL to its local HTML filename.
 *
 * Example:
 *
 * https://orm.drizzle.team/docs/overview
 *   -> output/orm.drizzle.team/docs/overview.html
 *
 * https://orm.drizzle.team/docs/guides/
 *   -> output/orm.drizzle.team/docs/guides/index.html
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

/**
 * Convert an asset URL to its local filename.
 *
 * Assets are kept under:
 *
 *   <hostname>/_assets/<original-path>
 *
 * Example:
 *
 * https://orm.drizzle.team/_astro/foo.css
 *   -> output/orm.drizzle.team/_assets/_astro/foo.css
 *
 * This avoids collisions between pages and assets.
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
 * Capture resources that can affect rendering.
 */
function shouldCapture(response: Response): boolean {
  const url = response.url();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
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
    contentType.includes("application/javascript") ||
    contentType.startsWith("image/")
  ) {
    return true;
  }

  return false;
}

/**
 * Ignore obvious analytics/tracking resources.
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
 * Return a path relative to the current page's output file.
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

/**
 * Convert a URL from the original website to its local output path.
 *
 * This is the important bit for Dash.
 *
 * Examples:
 *
 * /docs/get-started
 *   -> ../docs/get-started.html
 *
 * /_astro/foo.css
 *   -> ../_assets/_astro/foo.css
 *
 * #installation
 *   -> unchanged
 *
 * https://github.com/foo/bar
 *   -> unchanged
 */
function localUrl(
  rawUrl: string,
  pageUrl: string,
  assetMap: Map<string, string>
): string | undefined {
  if (
    rawUrl.startsWith("#") ||
    rawUrl.startsWith("data:") ||
    rawUrl.startsWith("mailto:") ||
    rawUrl.startsWith("tel:") ||
    rawUrl.startsWith("javascript:")
  ) {
    return undefined;
  }

  try {
    const absoluteUrl = new URL(rawUrl, pageUrl);

    // Preserve external origins.
    if (absoluteUrl.origin !== start.origin) {
      return undefined;
    }

    const hash = absoluteUrl.hash;

    absoluteUrl.hash = "";
    absoluteUrl.search = "";

    const normalized = normalizeUrl(absoluteUrl.href);

    /*
     * If this is a crawled documentation page, point at its
     * local .html file.
     */
    if (inScope(normalized)) {
      const destination = pageOutputPath(normalized);

      const relative = relativeAssetUrl(
        pageUrl,
        destination
      );

      return relative + hash;
    }

    /*
     * If it's a captured same-origin asset, point at the
     * local asset.
     */
    const assetDestination = assetMap.get(normalized);

    if (assetDestination) {
      const relative = relativeAssetUrl(
        pageUrl,
        assetDestination
      );

      return relative + hash;
    }

    /*
     * Same-origin URL that wasn't captured. Leave it alone.
     */
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite URLs inside CSS:
 *
 *   url("/_astro/foo.webp")
 *
 * becomes something like:
 *
 *   url("../_assets/_astro/foo.webp")
 *
 * while data URLs and external URLs remain untouched.
 */
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
        rawUrl.startsWith("#") ||
        rawUrl.startsWith("http://") ||
        rawUrl.startsWith("https://") ||
        rawUrl.startsWith("//")
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

/**
 * Rewrite HTML URLs.
 *
 * This handles:
 *
 *   href
 *   src
 *   poster
 *   action
 *
 * Root-relative internal links are converted to local .html
 * paths. Same-origin assets are converted to local assets.
 * External links and anchors are preserved.
 */
function rewriteHtmlUrls(
  html: string,
  pageUrl: string,
  assetMap: Map<string, string>
): string {
  return html.replace(
    /\b(href|src|poster|action)=("([^"]*)"|'([^']*)')/gi,
    (
      match,
      attribute,
      quoted,
      doubleUrl,
      singleUrl
    ) => {
      const rawUrl = doubleUrl ?? singleUrl;

      const rewritten = localUrl(
        rawUrl,
        pageUrl,
        assetMap
      );

      if (!rewritten) {
        return match;
      }

      return `${attribute}="${rewritten}"`;
    }
  );
}

await fs.mkdir(outputDir, {recursive: true});

const browser = await chromium.launch();

const page = await browser.newPage();

/*
 * Queue contains normalized URLs that still need crawling.
 */
const queue: string[] = [normalizeUrl(start.href)];
const queued = new Set(queue);
const visited = new Set<string>();

while (
  queue.length > 0 &&
  visited.size < maxPages
  ) {
  const requestedUrl = queue.shift()!;

  if (visited.has(requestedUrl)) {
    continue;
  }

  console.log(`→ ${requestedUrl}`);

  const resources = new Map<
    string,
    {
      body: Buffer;
      contentType: string;
    }
  >();

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

      const url = normalizeUrl(response.url());

      const body = await response.body();

      resources.set(url, {
        body,
        contentType:
          response.headers()["content-type"] ?? "",
      });
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
      page.off(
        "response",
        responseHandler
      );
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

    /*
     * Don't save redirects that leave our documentation scope.
     */
    if (!inScope(finalUrl)) {
      console.log(
        "  outside scope, skipping"
      );

      page.off(
        "response",
        responseHandler
      );

      continue;
    }

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );

      page.off(
        "response",
        responseHandler
      );

      continue;
    }

    /*
     * Give lazy-loaded assets a chance to appear.
     */
    await page.waitForTimeout(1000);

    visited.add(requestedUrl);
    visited.add(finalUrl);

    console.log(
      `  captured ${resources.size} assets`
    );

    /*
     * Map every captured resource to its local path.
     */
    const assetMap = new Map<
      string,
      string
    >();

    for (const [url, resource] of resources) {
      const destination =
        assetOutputPath(url);

      await fs.mkdir(
        path.dirname(destination),
        {recursive: true}
      );

      await fs.writeFile(
        destination,
        resource.body
      );

      assetMap.set(
        url,
        destination
      );
    }

    /*
     * Get the final DOM after JavaScript has executed.
     */
    let html = await page.content();

    /*
     * Rewrite HTML links/assets.
     */
    html = rewriteHtmlUrls(
      html,
      finalUrl,
      assetMap
    );

    /*
     * Rewrite CSS references to fonts/images/etc.
     */
    for (const [
      url,
      resource
    ] of resources) {
      if (
        !resource.contentType
          .toLowerCase()
          .includes("text/css")
      ) {
        continue;
      }

      const destination =
        assetMap.get(url);

      if (!destination) {
        continue;
      }

      let css =
        resource.body.toString(
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
    }

    /*
     * Save the page itself.
     */
    const destination =
      pageOutputPath(finalUrl);

    await fs.mkdir(
      path.dirname(destination),
      {recursive: true}
    );

    await fs.writeFile(
      destination,
      html
    );

    console.log(
      `  saved ${destination}`
    );

    /*
     * Discover documentation links from the
     * live DOM, before we've rewritten them.
     */
    const links =
      await page
        .locator("a[href]")
        .evaluateAll(
          (anchors) =>
            anchors
              .map(
                (a) =>
                  (
                    a as HTMLAnchorElement
                  ).href
              )
              .filter(Boolean)
        );

    let discovered = 0;

    for (const href of links) {
      try {
        const normalized =
          normalizeUrl(href);

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
  `Crawled ${visited.size} URLs.`
);

if (visited.size >= maxPages) {
  console.log(
    `Stopped at MAX_PAGES=${maxPages} ` +
    `(visited=${visited.size} ` +
    `left_over_in_queue=${queue.length})`
  );
}
