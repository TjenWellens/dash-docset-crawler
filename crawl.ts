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

/* -------------------------------------------------------------------------- */
/* Output paths                                                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* External noise                                                             */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* URL extraction from HTML                                                   */
/* -------------------------------------------------------------------------- */

function extractAttributeUrls(
  html: string,
  attribute: string
): string[] {
  const urls: string[] = [];

  const regex = new RegExp(
    `\\b${attribute}\\s*=\\s*["']([^"']+)["']`,
    "gi"
  );

  for (const match of html.matchAll(regex)) {
    urls.push(match[1]);
  }

  return urls;
}

function extractSrcsetUrls(
  html: string
): string[] {
  const urls: string[] = [];

  const regex =
    /\bsrcset\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(regex)) {
    const value = match[1];

    for (const item of value.split(",")) {
      const url = item.trim().split(/\s+/)[0];

      if (url) {
        urls.push(url);
      }
    }
  }

  return urls;
}

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
 * Find things that can represent resources:
 *
 *   href=
 *   src=
 *   poster=
 *   data=
 *   srcset=
 *
 * We intentionally collect all of them here.
 *
 * Later we classify them using Content-Type.
 */
function discoverResourceUrls(
  html: string,
  pageUrl: string
): Set<string> {
  const urls = new Set<string>();

  const attributes = [
    "href",
    "src",
    "poster",
    "data",
  ];

  for (const attribute of attributes) {
    for (const raw of extractAttributeUrls(
      html,
      attribute
    )) {
      const resolved =
        resolveUrl(raw, pageUrl);

      if (!resolved) {
        continue;
      }

      if (isExternalNoise(resolved)) {
        continue;
      }

      urls.add(resolved);
    }
  }

  for (const raw of extractSrcsetUrls(html)) {
    const resolved =
      resolveUrl(raw, pageUrl);

    if (!resolved) {
      continue;
    }

    if (isExternalNoise(resolved)) {
      continue;
    }

    urls.add(resolved);
  }

  /*
   * Inline style="background-image: url(...)"
   */
  const styleRegex =
    /\bstyle\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(styleRegex)) {
    const css = match[1];

    const urlRegex =
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

    for (const cssMatch of css.matchAll(urlRegex)) {
      const resolved =
        resolveUrl(
          cssMatch[2],
          pageUrl
        );

      if (!resolved) {
        continue;
      }

      if (isExternalNoise(resolved)) {
        continue;
      }

      urls.add(resolved);
    }
  }

  return urls;
}

/* -------------------------------------------------------------------------- */
/* CSS                                                                         */
/* -------------------------------------------------------------------------- */

function extractCssUrls(
  css: string,
  cssUrl: string
): string[] {
  const urls: string[] = [];

  const regex =
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

  for (const match of css.matchAll(regex)) {
    const raw = match[2];

    if (
      raw.startsWith("data:") ||
      raw.startsWith("#")
    ) {
      continue;
    }

    try {
      const resolved =
        normalizeUrl(
          new URL(raw, cssUrl).href
        );

      if (!isExternalNoise(resolved)) {
        urls.push(resolved);
      }
    } catch {
      // Ignore malformed CSS URLs.
    }
  }

  return urls;
}

function rewriteCss(
  css: string,
  cssUrl: string,
  assetMap: Map<string, string>
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
        const absolute =
          normalizeUrl(
            new URL(
              rawUrl,
              cssUrl
            ).href
          );

        const destination =
          assetMap.get(absolute);

        if (!destination) {
          return match;
        }

        const cssFile =
          assetOutputPath(cssUrl);

        const relative =
          path
            .relative(
              path.dirname(cssFile),
              destination
            )
            .split(path.sep)
            .join("/");

        return `url("${relative}")`;
      } catch {
        return match;
      }
    }
  );
}

/* -------------------------------------------------------------------------- */
/* HTML links                                                                  */
/* -------------------------------------------------------------------------- */

function discoverPageLinks(
  html: string,
  pageUrl: string
): string[] {
  const result: string[] = [];

  /*
   * Only <a href=""> links are navigation links.
   *
   * Don't treat every href as a page.
   */
  const regex =
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(regex)) {
    const raw = match[1];

    const resolved =
      resolveUrl(raw, pageUrl);

    if (!resolved) {
      continue;
    }

    if (inScope(resolved)) {
      result.push(resolved);
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* HTML rewriting                                                              */
/* -------------------------------------------------------------------------- */

function rewriteHtml(
  html: string,
  pageUrl: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, string>
): string {
  /*
   * Rewrite href/src/poster/data.
   */
  html = html.replace(
    /\b(href|src|poster|data)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attribute, quote, raw) => {
      /*
       * Preserve anchors.
       */
      if (raw.startsWith("#")) {
        return match;
      }

      /*
       * Preserve external URLs.
       */
      if (
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("//")
      ) {
        /*
         * But an absolute URL pointing at our
         * documentation site is internal.
         */
        try {
          const absolute =
            normalizeUrl(
              new URL(
                raw,
                pageUrl
              ).href
            );

          if (
            !inScope(absolute)
          ) {
            return match;
          }

          const pageDestination =
            pageMap.get(absolute);

          if (pageDestination) {
            const relative =
              path
                .relative(
                  path.dirname(
                    pageOutputPath(pageUrl)
                  ),
                  pageDestination
                )
                .split(path.sep)
                .join("/");

            return `${attribute}=${quote}${relative}${quote}`;
          }
        } catch {
          // Preserve malformed/external URL.
        }

        return match;
      }

      let absolute: string;

      try {
        absolute =
          normalizeUrl(
            new URL(
              raw,
              pageUrl
            ).href
          );
      } catch {
        return match;
      }

      /*
       * Internal page.
       */
      const pageDestination =
        pageMap.get(absolute);

      if (pageDestination) {
        const relative =
          path
            .relative(
              path.dirname(
                pageOutputPath(pageUrl)
              ),
              pageDestination
            )
            .split(path.sep)
            .join("/");

        return `${attribute}=${quote}${relative}${quote}`;
      }

      /*
       * Asset.
       */
      const assetDestination =
        assetMap.get(absolute);

      if (assetDestination) {
        const relative =
          path
            .relative(
              path.dirname(
                pageOutputPath(pageUrl)
              ),
              assetDestination
            )
            .split(path.sep)
            .join("/");

        return `${attribute}=${quote}${relative}${quote}`;
      }

      /*
       * Unknown URL.
       *
       * Leave it alone rather than breaking it.
       */
      return match;
    }
  );

  /*
   * srcset.
   */
  html = html.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (match, quote, rawValue) => {
      const rewritten =
        rawValue
          .split(",")
          .map((item: string) => {
            const parts =
              item.trim().split(/\s+/);

            if (!parts[0]) {
              return item;
            }

            try {
              const absolute =
                normalizeUrl(
                  new URL(
                    parts[0],
                    pageUrl
                  ).href
                );

              const destination =
                assetMap.get(absolute);

              if (!destination) {
                return item;
              }

              const relative =
                path
                  .relative(
                    path.dirname(
                      pageOutputPath(
                        pageUrl
                      )
                    ),
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

      return `srcset=${quote}${rewritten}${quote}`;
    }
  );

  return html;
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

type PageRecord = {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  resourceUrls: string[];
};

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

await fs.mkdir(
  outputDir,
  {
    recursive: true,
  }
);

const browser =
  await chromium.launch();

const page =
  await browser.newPage();

const queue: string[] = [
  normalizeUrl(start.href),
];

const queued =
  new Set(queue);

const pages =
  new Map<string, PageRecord>();

const allResourceUrls =
  new Set<string>();

/* ========================================================================== */
/* PHASE 1                                                                     */
/* ========================================================================== */

console.log("=== PHASE 1: CRAWL ===");

while (
  queue.length > 0 &&
  pages.size < maxPages
) {
  const requestedUrl =
    queue.shift()!;

  if (pages.has(requestedUrl)) {
    continue;
  }

  console.log(
    `→ ${requestedUrl}`
  );

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
      console.log(
        "  no response"
      );
      continue;
    }

    const finalUrl =
      normalizeUrl(
        page.url()
      );

    if (
      finalUrl !==
      requestedUrl
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
     * Give lazy-loaded content a moment.
     */
    await page.waitForTimeout(500);

    /*
     * Get the complete rendered HTML.
     */
    const html =
      await page.content();

    /*
     * Discover resources from HTML.
     */
    const resourceUrls =
      discoverResourceUrls(
        html,
        finalUrl
      );

    for (const url of resourceUrls) {
      allResourceUrls.add(url);
    }

    /*
     * Discover internal documentation pages.
     */
    const links =
      discoverPageLinks(
        html,
        finalUrl
      );

    let discovered = 0;

    for (const url of links) {
      if (
        !queued.has(url) &&
        !pages.has(url)
      ) {
        queue.push(url);
        queued.add(url);
        discovered++;
      }
    }

    const record: PageRecord = {
      requestedUrl,
      finalUrl,
      html,
      resourceUrls: [
        ...resourceUrls,
      ],
    };

    pages.set(
      finalUrl,
      record
    );

    /*
     * Also map the requested URL to the same
     * final page, which is useful for redirects.
     */
    pages.set(
      requestedUrl,
      record
    );

    console.log(
      `  captured ${resourceUrls.length} page resources`
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

/* ========================================================================== */
/* PAGE MAP                                                                     */
/* ========================================================================== */

const pageMap =
  new Map<string, string>();

for (const [url, record] of pages) {
  pageMap.set(
    url,
    pageOutputPath(
      record.finalUrl
    )
  );
}

/* ========================================================================== */
/* PHASE 2                                                                     */
/* ========================================================================== */

console.log();
console.log(
  "=== PHASE 2: DOWNLOAD RESOURCES ==="
);

const assetMap =
  new Map<string, string>();

const processedResources =
  new Set<string>();

/*
 * We process this as a queue because CSS can introduce
 * additional resources through url(...).
 */
const resourceQueue =
  [...allResourceUrls];

while (
  resourceQueue.length > 0
) {
  const url =
    resourceQueue.shift()!;

  if (
    processedResources.has(url)
  ) {
    continue;
  }

  processedResources.add(url);

  /*
   * Internal documentation pages are not assets.
   */
  if (
    inScope(url)
  ) {
    console.log(
      `  skipping page URL ${url}`
    );
    continue;
  }

  if (
    isExternalNoise(url)
  ) {
    continue;
  }

  const destination =
    assetOutputPath(url);

  try {
    console.log(
      `→ ${url}`
    );

    const response =
      await page.request.get(
        url,
        {
          timeout: 60_000,
        }
      );

    if (!response.ok()) {
      console.log(
        `  HTTP ${response.status()}, skipping`
      );
      continue;
    }

    const body =
      await response.body();

    const contentType =
      response
        .headers()
        ["content-type"] ?? "";

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
      url,
      destination
    );

    console.log(
      `  saved ${destination}`
    );

    /*
     * CSS may reference fonts/images/etc.
     */
    if (
      contentType.includes(
        "text/css"
      ) ||
      url.endsWith(".css")
    ) {
      const css =
        body.toString("utf8");

      const cssDependencies =
        extractCssUrls(
          css,
          url
        );

      for (
        const dependency
        of cssDependencies
      ) {
        if (
          !processedResources.has(
            dependency
          )
        ) {
          resourceQueue.push(
            dependency
          );
        }
      }
    }
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

/* ========================================================================== */
/* REWRITE CSS                                                                 */
/* ========================================================================== */

console.log();
console.log(
  "=== REWRITE CSS ==="
);

for (
  const [url, destination]
  of assetMap
) {
  if (
    !url.toLowerCase().endsWith(
      ".css"
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

    css =
      rewriteCss(
        css,
        url,
        assetMap
      );

    await fs.writeFile(
      destination,
      css
    );

    console.log(
      `→ ${url}`
    );
  } catch (error) {
    console.error(
      `  ERROR rewriting ${url}:`,
      error
    );
  }
}

/* ========================================================================== */
/* WRITE HTML                                                                  */
/* ========================================================================== */

console.log();
console.log(
  "=== WRITE HTML ==="
);

const written =
  new Set<string>();

for (
  const record
  of pages.values()
) {
  const finalUrl =
    record.finalUrl;

  if (
    written.has(finalUrl)
  ) {
    continue;
  }

  written.add(finalUrl);

  const destination =
    pageOutputPath(
      finalUrl
    );

  const html =
    rewriteHtml(
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

/* ========================================================================== */
/* DONE                                                                        */
/* ========================================================================== */

await browser.close();

console.log();
console.log(
  "================================"
);
console.log(
  "DONE"
);
console.log(
  "================================"
);
console.log(
  `Pages:     ${written.size}`
);
console.log(
  `Resources: ${assetMap.size}`
);
console.log(
  `Output:    ${path.resolve(outputDir)}`
);

if (
  written.size >= maxPages
) {
  console.log(
    `Stopped at MAX_PAGES=${maxPages}`
  );
}