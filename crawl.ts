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

// Only crawl URLs under the starting path.
// e.g. /docs/ means /docs/foo is allowed, /blog/foo isn't.
const scopePath = start.pathname.endsWith("/")
  ? start.pathname
  : start.pathname + "/";

function inScope(url: URL) {
  return (
    url.origin === start.origin &&
    (url.pathname === start.pathname ||
      url.pathname.startsWith(scopePath))
  );
}

function outputPath(url: URL) {
  let pathname = url.pathname;

  if (pathname.endsWith("/")) {
    pathname += "index.html";
  } else {
    pathname += ".html";
  }

  return path.join(
    outputDir,
    url.hostname,
    pathname.replace(/^\/+/, "")
  );
}

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

const queue: string[] = [start.href];
const visited = new Set<string>();

while (queue.length > 0) {
  const url = queue.shift()!;

  if (visited.has(url)) continue;
  visited.add(url);

  console.log(`→ ${url}`);

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });

    // Give client-side navigation/rendering a little extra time.
    await page.waitForTimeout(500);

    const html = await page.content();

    const destination = outputPath(new URL(url));

    await fs.mkdir(path.dirname(destination), {
      recursive: true,
    });

    await fs.writeFile(destination, html);

    const links = await page.locator("a[href]").evaluateAll(
      (anchors) =>
        anchors
          .map((a) => (a as HTMLAnchorElement).href)
          .filter(Boolean)
    );

    for (const href of links) {
      try {
        const next = new URL(href);

        // Remove fragments.
        next.hash = "";

        if (inScope(next) && !visited.has(next.href)) {
          queue.push(next.href);
        }
      } catch {
        // Ignore malformed URLs.
      }
    }

    console.log(`  saved ${destination}`);
    console.log(`  discovered ${links.length} links`);
  } catch (error) {
    console.error(`  ERROR: ${error}`);
  }
}

await browser.close();

console.log();
console.log(`Crawled ${visited.size} pages.`);
