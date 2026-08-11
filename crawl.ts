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

function shouldCapture(response: Response): boolean {
  const url = response.url();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }

  const type = response.request().resourceType();

  // Capture the things that normally affect visual rendering.
  if (
    type === "stylesheet" ||
    type === "font" ||
    type === "image"
  ) {
    return true;
  }

  const contentType =
    response.headers()["content-type"] ?? "";

  if (
    contentType.includes("text/css") ||
    contentType.startsWith("font/") ||
    contentType.includes("application/font")
  ) {
    return true;
  }

  return false;
}

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

function relativeAssetUrl(
  pageUrl: string,
  assetUrl: string,
  destination: string
): string {
  const pagePath = pageOutputPath(pageUrl);

  let relative = path.relative(
    path.dirname(pagePath),
    destination
  );

  return relative.split(path.sep).join("/");
}

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

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

const queue: string[] = [normalizeUrl(start.href)];
const queued = new Set(queue);
const visited = new Set<string>();

while (queue.length > 0 && visited.size < maxPages) {
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

  const responseHandler = async (response: Response) => {
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
      // Some browser responses cannot be read.
    }
  };

  page.on("response", responseHandler);

  try {
    const response = await page.goto(requestedUrl, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });

    if (!response) {
      console.log("  no response");
      page.off("response", responseHandler);
      continue;
    }

    const finalUrl = normalizeUrl(page.url());

    if (finalUrl !== requestedUrl) {
      console.log(`  redirect → ${finalUrl}`);
    }

    if (!inScope(finalUrl)) {
      console.log("  outside scope, skipping");
      page.off("response", responseHandler);
      continue;
    }

    if (!response.ok()) {
      console.log(`  HTTP ${response.status()}, skipping`);
      page.off("response", responseHandler);
      continue;
    }

    // Allow lazy-loaded assets to appear.
    await page.waitForTimeout(1000);

    visited.add(requestedUrl);
    visited.add(finalUrl);

    console.log(`  captured ${resources.size} assets`);

    const assetMap = new Map<string, string>();

    // Save assets first so CSS can reference them.
    for (const [url, resource] of resources) {
      const destination = assetOutputPath(url);

      await fs.mkdir(path.dirname(destination), {
        recursive: true,
      });

      await fs.writeFile(destination, resource.body);

      assetMap.set(url, destination);
    }

    let html = await page.content();

    function rewriteHtmlAssets(
      html: string,
      pageUrl: string,
      assetMap: Map<string, string>
    ): string {
      return html.replace(
        /(src|href)=("([^"]+)"|'([^']+)')/gi,
        (match, attribute, quoted, doubleUrl, singleUrl) => {
          const rawUrl = doubleUrl ?? singleUrl;

          if (
            rawUrl.startsWith("#") ||
            rawUrl.startsWith("data:") ||
            rawUrl.startsWith("mailto:") ||
            rawUrl.startsWith("javascript:")
          ) {
            return match;
          }

          try {
            const absolute = normalizeUrl(
              new URL(rawUrl, pageUrl).href
            );

            const destination = assetMap.get(absolute);

            if (!destination) {
              return match;
            }

            const relative = relativeAssetUrl(
              pageUrl,
              absolute,
              destination
            );

            return `${attribute}="${relative}"`;
          } catch {
            return match;
          }
        }
      );
    }
    html = rewriteHtmlAssets(
      html,
      finalUrl,
      assetMap
    );

    // Rewrite CSS resources recursively.
    for (const [url, resource] of resources) {
      if (!resource.contentType.includes("text/css")) {
        continue;
      }

      const destination = assetMap.get(url);

      if (!destination) {
        continue;
      }

      let css = resource.body.toString("utf8");

      css = rewriteCss(
        css,
        url,
        assetMap
      );

      await fs.writeFile(destination, css);
    }

    const destination = pageOutputPath(finalUrl);

    await fs.mkdir(path.dirname(destination), {
      recursive: true,
    });

    await fs.writeFile(destination, html);

    console.log(`  saved ${destination}`);

    // Discover documentation links.
    const links = await page.locator("a[href]").evaluateAll(
      (anchors) =>
        anchors
          .map((a) => (a as HTMLAnchorElement).href)
          .filter(Boolean)
    );

    let discovered = 0;

    for (const href of links) {
      try {
        const normalized = normalizeUrl(href);

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
        // Ignore malformed URLs.
      }
    }

    console.log(`  discovered ${discovered} new pages`);
  } catch (error) {
    console.error(`  ERROR: ${error}`);
  }

  page.off("response", responseHandler);
}

await browser.close();

console.log();
console.log(`Crawled ${visited.size} URLs.`);

if (visited.size >= maxPages) {
  console.log(`Stopped at MAX_PAGES=${maxPages} (visited=${visited.size} left_over_in_queue=${queue.length})`);
}
