import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const startUrl = process.argv[2];
const outputDir = process.argv[3] ?? "./output";

if (!startUrl) {
  console.error("Usage: npx tsx crawl.ts <url> [output-dir]");
  process.exit(1);
}

const start = new URL(startUrl);

// Normalize the starting URL.
start.hash = "";
start.search = "";

const scopePath = start.pathname.endsWith("/")
  ? start.pathname
  : start.pathname + "/";

function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  // Fragments don't identify separate documents.
  url.hash = "";

  // Query parameters often create duplicate pages in docs sites.
  url.search = "";

  // Normalize trailing slash.
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}

function inScope(raw: string): boolean {
  const url = new URL(raw);

  return (
    url.origin === start.origin &&
    (url.pathname === start.pathname ||
      url.pathname.startsWith(scopePath))
  );
}

function outputPath(raw: string): string {
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

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();

const page = await browser.newPage();

const queue: string[] = [normalizeUrl(start.href)];
const queued = new Set(queue);
const visited = new Set<string>();

while (queue.length > 0) {
  const requestedUrl = queue.shift()!;

  if (visited.has(requestedUrl)) {
    continue;
  }

  console.log(`→ ${requestedUrl}`);

  try {
    const response = await page.goto(requestedUrl, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });

    if (!response) {
      console.log("  no response");
      continue;
    }

    // IMPORTANT:
    // page.url() is the URL after redirects.
    const finalUrl = normalizeUrl(page.url());

    if (finalUrl !== requestedUrl) {
      console.log(`  redirect → ${finalUrl}`);
    }

    // Don't save pages that redirected outside our scope.
    if (!inScope(finalUrl)) {
      console.log(`  outside scope, skipping`);
      continue;
    }

    if (!response.ok()) {
      console.log(`  HTTP ${response.status()}, skipping`);
      continue;
    }

    visited.add(requestedUrl);
    visited.add(finalUrl);

    // Give client-side navigation/rendering a little time.
    await page.waitForTimeout(500);

    const html = await page.content();

    const destination = outputPath(finalUrl);

    await fs.mkdir(path.dirname(destination), {
      recursive: true,
    });

    await fs.writeFile(destination, html);

    console.log(`  saved ${destination}`);

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
}

await browser.close();

console.log();
console.log(`Crawled ${visited.size} URLs.`);
