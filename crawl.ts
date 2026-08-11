import { chromium, type Page } from "playwright";
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

type PageRecord = {
  url: string;
  html: string;
  resourceUrls: string[];
};

const pages = new Map<string, PageRecord>();
const resources = new Set<string>();

function normalizeUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);

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
 * Convert a documentation URL into its local HTML path.
 *
 * https://orm.drizzle.team/docs/overview
 *   -> orm.drizzle.team/docs/overview.html
 *
 * https://orm.drizzle.team/docs/guides/
 *   -> orm.drizzle.team/docs/guides/index.html
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
 * All non-HTML resources go under:
 *
 *   <host>/_assets/<original-path>
 *
 * Examples:
 *
 * /preferred.css
 *   -> orm.drizzle.team/_assets/preferred.css
 *
 * /_astro/foo.css
 *   -> orm.drizzle.team/_assets/_astro/foo.css
 *
 * /images/foo.png
 *   -> orm.drizzle.team/_assets/images/foo.png
 */
function resourceOutputPath(raw: string): string {
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

function relativePath(
  fromFile: string,
  toFile: string
): string {
  return path
    .relative(path.dirname(fromFile), toFile)
    .split(path.sep)
    .join("/");
}

function localResourceHref(
  pageUrl: string,
  resourceUrl: string
): string {
  return relativePath(
    pageOutputPath(pageUrl),
    resourceOutputPath(resourceUrl)
  );
}

function localPageHref(
  pageUrl: string,
  targetUrl: string
): string {
  return relativePath(
    pageOutputPath(pageUrl),
    pageOutputPath(targetUrl)
  );
}

/**
 * Extract resource URLs from the rendered DOM.
 *
 * We intentionally do this from the DOM rather than relying on
 * Playwright response events. This catches resources that are present
 * in the page even if they were loaded before our listener was attached.
 */
async function collectResourceUrls(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const urls = new Set<string>();

    const add = (value: string | null) => {
      if (!value) return;

      try {
        const absolute = new URL(value, document.baseURI);

        if (
          absolute.protocol === "http:" ||
          absolute.protocol === "https:"
        ) {
          absolute.hash = "";
          absolute.search = "";

          urls.add(absolute.href);
        }
      } catch {
        // Ignore malformed URLs.
      }
    };

    // Stylesheets
    document
      .querySelectorAll<HTMLLinkElement>(
        'link[rel="stylesheet"], link[href]'
      )
      .forEach((el) => add(el.getAttribute("href")));

    // Images
    document
      .querySelectorAll<HTMLImageElement>("img[src]")
      .forEach((el) => add(el.getAttribute("src")));

    // Source elements
    document
      .querySelectorAll<HTMLSourceElement>("source[src], source[srcset]")
      .forEach((el) => {
        add(el.getAttribute("src"));

        const srcset = el.getAttribute("srcset");

        if (srcset) {
          for (const candidate of srcset.split(",")) {
            const url = candidate.trim().split(/\s+/)[0];
            add(url);
          }
        }
      });

    // Scripts
    document
      .querySelectorAll<HTMLScriptElement>("script[src]")
      .forEach((el) => add(el.getAttribute("src")));

    // Video/audio
    document
      .querySelectorAll<HTMLMediaElement>("video[src], audio[src]")
      .forEach((el) => add(el.getAttribute("src")));

    // Favicon and other link resources
    document
      .querySelectorAll<HTMLLinkElement>(
        "link[href]"
      )
      .forEach((el) => {
        const rel = (el.getAttribute("rel") ?? "").toLowerCase();

        if (
          rel.includes("icon") ||
          rel.includes("manifest") ||
          rel.includes("preload") ||
          rel.includes("prefetch") ||
          rel.includes("modulepreload")
        ) {
          add(el.getAttribute("href"));
        }
      });

    return [...urls];
  });
}

/**
 * Rewrite HTML URLs.
 *
 * Rules:
 *
 *   #foo
 *      stays #foo
 *
 *   https://example.com/foo
 *      stays external
 *
 *   https://orm.drizzle.team/docs/foo
 *      becomes local foo.html
 *
 *   /preferred.css
 *      becomes ../_assets/preferred.css
 *
 *   /_astro/foo.css
 *      becomes ../_assets/_astro/foo.css
 */
function rewriteHtml(
  html: string,
  pageUrl: string
): string {
  return html.replace(
    /\b(href|src|poster|action)=("([^"]*)"|'([^']*)')/gi,
    (match, attribute, quoted, doubleValue, singleValue) => {
      const rawValue = doubleValue ?? singleValue;

      if (!rawValue) {
        return match;
      }

      // Anchors
      if (rawValue.startsWith("#")) {
        return match;
      }

      // Non-HTTP protocols
      if (
        rawValue.startsWith("data:") ||
        rawValue.startsWith("mailto:") ||
        rawValue.startsWith("tel:") ||
        rawValue.startsWith("javascript:") ||
        rawValue.startsWith("blob:")
      ) {
        return match;
      }

      try {
        const absolute = new URL(rawValue, pageUrl);

        if (
          absolute.protocol !== "http:" &&
          absolute.protocol !== "https:"
        ) {
          return match;
        }

        const normalized = normalizeUrl(absolute.href);

        // Internal documentation page
        if (
          absolute.origin === start.origin &&
          inScope(normalized)
        ) {
          const local = localPageHref(
            pageUrl,
            normalized
          );

          return `${attribute}="${local}"`;
        }

        // Internal resource
        if (absolute.origin === start.origin) {
          const local = localResourceHref(
            pageUrl,
            normalized
          );

          return `${attribute}="${local}"`;
        }

        // External URL: preserve it.
        return match;
      } catch {
        return match;
      }
    }
  );
}

/**
 * Rewrite CSS url(...) references.
 *
 * Example:
 *
 *   url("/_astro/foo.webp")
 *
 * becomes something like:
 *
 *   url("../_astro/foo.webp")
 *
 * depending on where the CSS file lives.
 */
function rewriteCss(
  css: string,
  cssUrl: string
): string {
  const cssOutput = resourceOutputPath(cssUrl);

  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("#") ||
        rawUrl.startsWith("blob:")
      ) {
        return match;
      }

      try {
        const absolute = normalizeUrl(
          new URL(rawUrl, cssUrl).href
        );

        const localFile = resourceOutputPath(
          absolute
        );

        const relative = relativePath(
          cssOutput,
          localFile
        );

        return `url("${relative}")`;
      } catch {
        return match;
      }
    }
  );
}

/**
 * Download a resource with a fresh browser request.
 *
 * Using context.request rather than the page response listener
 * makes phase 2 deterministic and independent of page timing.
 */
async function downloadResource(
  context: Awaited<ReturnType<typeof browserContext>>,
  url: string
): Promise<Buffer | null> {
  try {
    const response = await context.request.get(url, {
      timeout: 60_000,
    });

    if (!response.ok()) {
      console.log(
        `  ! ${response.status()} ${url}`
      );

      return null;
    }

    return await response.body();
  } catch (error) {
    console.log(`  ! failed ${url}`);

    return null;
  }
}

/**
 * Small helper solely to make the type of downloadResource readable.
 */
function browserContext(
  browser: Awaited<ReturnType<typeof chromium.launch>>
) {
  return browser.newContext();
}

await fs.mkdir(outputDir, {
  recursive: true,
});

const browser = await chromium.launch();

const context = await browser.newContext({
  serviceWorkers: "allow",
});

const page = await context.newPage();

const queue: string[] = [
  normalizeUrl(start.href),
];

const queued = new Set(queue);
const visited = new Set<string>();

console.log("=== PHASE 1: CRAWL ===");

while (
  queue.length > 0 &&
  pages.size < maxPages
) {
  const requestedUrl = queue.shift()!;

  if (visited.has(requestedUrl)) {
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

    // Give lazy-loaded content/assets a chance to appear.
    await page.waitForTimeout(1000);

    const html = await page.content();

    const resourceUrls =
      await collectResourceUrls(page);

    for (const url of resourceUrls) {
      if (!isExternalNoise(url)) {
        resources.add(url);
      }
    }

    pages.set(finalUrl, {
      url: finalUrl,
      html,
      resourceUrls,
    });

    visited.add(requestedUrl);
    visited.add(finalUrl);

    console.log(
      `  captured ${resourceUrls.length} page resources`
    );

    // Discover internal documentation links.
    const links = await page.locator(
      "a[href]"
    ).evaluateAll(
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
        const url = new URL(
          href,
          finalUrl
        );

        if (
          url.protocol !== "http:" &&
          url.protocol !== "https:"
        ) {
          continue;
        }

        if (!inScope(url.href)) {
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
        // Ignore malformed links.
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

console.log();
console.log("=== PHASE 2: DOWNLOAD RESOURCES ===");

let downloaded = 0;

for (const resourceUrl of resources) {
  const destination =
    resourceOutputPath(resourceUrl);

  await fs.mkdir(
    path.dirname(destination),
    {
      recursive: true,
    }
  );

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
        `! ${response.status()} ${resourceUrl}`
      );
      continue;
    }

    const body =
      await response.body();

    await fs.writeFile(
      destination,
      body
    );

    downloaded++;

    console.log(
      `✓ ${resourceUrl}`
    );
  } catch (error) {
    console.log(
      `! failed ${resourceUrl}`
    );
  }
}

console.log();
console.log(
  `Downloaded ${downloaded} resources`
);

console.log();
console.log("=== REWRITE CSS ===");

/**
 * Rewrite every downloaded CSS file.
 *
 * We don't need to know which page referenced it.
 * CSS URLs are resolved relative to the CSS file itself.
 */
for (const resourceUrl of resources) {
  if (!resourceUrl.match(/\.css(?:$|\?)/i)) {
    continue;
  }

  const destination =
    resourceOutputPath(resourceUrl);

  try {
    const css =
      await fs.readFile(
        destination,
        "utf8"
      );

    const rewritten =
      rewriteCss(
        css,
        resourceUrl
      );

    await fs.writeFile(
      destination,
      rewritten
    );

    console.log(
      `✓ ${resourceUrl}`
    );
  } catch {
    // Resource may not have downloaded.
  }
}

console.log();
console.log("=== WRITE HTML ===");

for (const record of pages.values()) {
  const destination =
    pageOutputPath(record.url);

  await fs.mkdir(
    path.dirname(destination),
    {
      recursive: true,
    }
  );

  const rewritten =
    rewriteHtml(
      record.html,
      record.url
    );

  await fs.writeFile(
    destination,
    rewritten,
    "utf8"
  );

  console.log(
    `✓ ${record.url}`
  );
}

await context.close();
await browser.close();

console.log();
console.log("================================");
console.log("DONE");
console.log("================================");
console.log(
  `Pages:     ${pages.size}`
);
console.log(
  `Resources: ${downloaded}`
);
console.log(
  `Output:    ${path.resolve(outputDir)}`
);
