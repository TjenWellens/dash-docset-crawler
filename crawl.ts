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

  // Keep the URL's original path.
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

  // Resources loaded by this page.
  const resources = new Map<string, Buffer>();

  const responseHandler = async (response: any) => {
    try {
      const url = response.url();

      // Only capture HTTP(S) resources.
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return;
      }

      const contentType =
        response.headers()["content-type"] ?? "";

      // Capture things that are useful offline.
      const interesting =
        contentType.includes("text/css") ||
        contentType.includes("javascript") ||
        contentType.includes("font/") ||
        contentType.includes("image/") ||
        contentType.includes("application/font") ||
        contentType.includes("application/octet-stream");

      if (!interesting) {
        return;
      }

      const body = await response.body();

      resources.set(normalizeUrl(url), body);
    } catch {
      // Some responses cannot have their body read.
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

    await page.waitForTimeout(500);

    // Wait a moment for late resources.
    await page.waitForTimeout(500);

    visited.add(requestedUrl);
    visited.add(finalUrl);

    console.log(`  captured ${resources.size} resources`);

    // Save resources.
    const assetMap = new Map<string, string>();

    for (const [url, body] of resources) {
      const destination = assetOutputPath(url);

      await fs.mkdir(path.dirname(destination), {
        recursive: true,
      });

      await fs.writeFile(destination, body);

      assetMap.set(url, destination);

      console.log(`  asset ${url}`);
    }

    // Get rendered HTML.
    let html = await page.content();

    // Rewrite captured resource URLs.
    for (const [url, destination] of assetMap) {
      const pagePath = pageOutputPath(finalUrl);

      let relative = path.relative(
        path.dirname(pagePath),
        destination
      );

      relative = relative.split(path.sep).join("/");

      // Replace both absolute URLs and paths.
      const parsed = new URL(url);

      const replacements = [
        url,
        parsed.pathname,
      ];

      for (const original of replacements) {
        html = html.split(original).join(relative);
      }
    }

    const destination = pageOutputPath(finalUrl);

    await fs.mkdir(path.dirname(destination), {
      recursive: true,
    });

    await fs.writeFile(destination, html);

    console.log(`  saved ${destination}`);

    // Discover navigation links.
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
  console.log(`Stopped at MAX_PAGES=${maxPages}`);
}
