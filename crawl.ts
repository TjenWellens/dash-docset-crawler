import {type BrowserContext, chromium, type Page, type Response,} from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const startUrl = process.argv[2];
const rawDir = process.argv[3];

const maxPages = Number(
  process.env.MAX_PAGES ?? 500,
);

if (!startUrl || !rawDir) {
  console.error(
    "Usage: npx tsx crawl.ts <url> <raw-dir>",
  );
  console.error();
  console.error(
    "Example:",
  );
  console.error(
    "  npx tsx crawl.ts https://orm.drizzle.team/docs/ docs/drizzle/raw",
  );
  process.exit(1);
}

const start = new URL(startUrl);
start.hash = "";
start.search = "";

const scopePath = start.pathname.endsWith("/")
  ? start.pathname
  : start.pathname + "/";

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

type PageStatus =
  | "queued"
  | "downloaded"
  | "failed";

type ResourceStatus =
  | "discovered"
  | "downloaded"
  | "failed";

interface PageRecord {
  path: string;
  status: PageStatus;
  scrapedAt?: string;
  error?: string;
}

interface ResourceRecord {
  path: string;
  status: ResourceStatus;
  contentType?: string;
  scrapedAt?: string;
  error?: string;
}

interface Manifest {
  version: 1;

  site: {
    name: string;
    startUrl: string;
  };

  icon?: {
    url: string;
  };

  scope: {
    origin: string;
    path: string;
  };

  scrape: {
    startedAt: string;
    lastUpdatedAt: string;
    completedAt: string | null;
    complete: boolean;
  };

  pages: Record<string, PageRecord>;

  resources: Record<
    string,
    ResourceRecord
  >;

  queue: string[];
}

/*
 * ============================================================
 * TIME / MANIFEST HELPERS
 * ============================================================
 */

function now(): string {
  return new Date().toISOString();
}

function siteNameFromDir(): string {
  return path.basename(
    path.dirname(
      path.resolve(rawDir),
    ),
  );
}

const manifestPath =
  path.join(
    rawDir,
    "manifest.json",
  );

async function saveManifest(
  manifest: Manifest,
): Promise<void> {
  manifest.scrape.lastUpdatedAt =
    now();

  const temporaryPath =
    manifestPath + ".tmp";

  await fs.writeFile(
    temporaryPath,
    JSON.stringify(
      manifest,
      null,
      2,
    ) + "\n",
    "utf8",
  );

  /*
   * Atomic-ish replacement:
   *
   * write .tmp first, then rename it over
   * the real manifest.
   */
  await fs.rename(
    temporaryPath,
    manifestPath,
  );
}

async function loadManifest(): Promise<
  Manifest | null
> {
  try {
    const contents =
      await fs.readFile(
        manifestPath,
        "utf8",
      );

    return JSON.parse(
      contents,
    ) as Manifest;
  } catch {
    return null;
  }
}

/*
 * ============================================================
 * URL HELPERS
 * ============================================================
 */

/**
 * Normalize a URL:
 *
 * - remove hash
 * - remove query string
 * - remove trailing slash except "/"
 */
function normalizeUrl(
  raw: string,
): string {
  const url = new URL(raw);

  url.hash = "";
  url.search = "";

  if (
    url.pathname !== "/" &&
    url.pathname.endsWith("/")
  ) {
    url.pathname =
      url.pathname.slice(
        0,
        -1,
      );
  }

  return url.href;
}

/**
 * Whether a URL belongs to the
 * documentation scope.
 */
function inScope(
  raw: string,
): boolean {
  const url = new URL(raw);

  return (
    url.origin === start.origin &&
    (
      url.pathname === start.pathname ||
      url.pathname.startsWith(
        scopePath,
      )
    )
  );
}

/**
 * Convert a page URL to a path
 * inside raw/pages/.
 */
function pageOutputPath(
  raw: string,
): string {
  const url = new URL(raw);

  let pathname =
    url.pathname;

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    pathname =
      "index.html";
  } else {
    pathname =
      pathname.replace(
        /^\/+/,
        "",
      );

    if (
      pathname.endsWith("/")
    ) {
      pathname +=
        "index.html";
    } else {
      pathname +=
        ".html";
    }
  }

  return path.join(
    "pages",
    url.hostname,
    pathname,
  );
}

/**
 * Convert a resource URL to a
 * path inside raw/resources/.
 */
function resourceOutputPath(
  raw: string,
): string {
  const url = new URL(raw);

  let pathname =
    url.pathname.replace(
      /^\/+/,
      "",
    );

  if (!pathname) {
    pathname = "index";
  }

  return path.join(
    "resources",
    url.hostname,
    pathname,
  );
}

/**
 * Turn a manifest-relative path into
 * an absolute filesystem path.
 */
function absoluteRawPath(
  relativePath: string,
): string {
  return path.join(
    rawDir,
    relativePath,
  );
}

/*
 * ============================================================
 * RESOURCE HELPERS
 * ============================================================
 */

function shouldCapture(
  response: Response,
): boolean {
  const url =
    response.url();

  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://")
  ) {
    return false;
  }

  const type =
    response
      .request()
      .resourceType();

  if (
    type === "stylesheet" ||
    type === "font" ||
    type === "image" ||
    type === "script"
  ) {
    return true;
  }

  const contentType =
    response
      .headers()
      ["content-type"] ?? "";

  if (
    contentType.includes(
      "text/css",
    ) ||
    contentType.startsWith(
      "font/",
    ) ||
    contentType.includes(
      "application/font",
    ) ||
    contentType.includes(
      "javascript",
    ) ||
    contentType.includes(
      "image/",
    )
  ) {
    return true;
  }

  return false;
}

function isExternalNoise(
  raw: string,
): boolean {
  const url =
    new URL(raw);

  const hostname =
    url.hostname;

  return (
    hostname.includes(
      "google-analytics",
    ) ||
    hostname.includes(
      "googletagmanager",
    ) ||
    hostname.includes(
      "analytics",
    ) ||
    hostname.includes(
      "ahrefs",
    ) ||
    hostname.includes(
      "algolia",
    ) ||
    hostname.includes(
      "onedollarstats",
    ) ||
    hostname.includes(
      "doubleclick",
    )
  );
}

/**
 * Add an absolute HTTP(S) URL to a set.
 */
function addResourceUrl(
  urls: Set<string>,
  value: string | null,
  baseUrl: string,
): void {
  if (!value) {
    return;
  }

  try {
    const absolute =
      new URL(
        value,
        baseUrl,
      );

    if (
      absolute.protocol !==
        "http:" &&
      absolute.protocol !==
        "https:"
    ) {
      return;
    }

    absolute.hash = "";
    absolute.search = "";

    urls.add(
      absolute.href,
    );
  } catch {
    // Ignore malformed URLs.
  }
}

/**
 * Find the site's favicon from the current page.
 *
 * We prefer:
 *
 *   <link rel="icon" href="...">
 *   <link rel="shortcut icon" href="...">
 *
 * The first valid icon found wins.
 */
async function findFaviconUrl(
  page: Page,
): Promise<string | null> {
  const baseUrl = page.url();

  const icons = page.locator(
    'link[rel~="icon"][href], link[rel~="shortcut"][href]',
  );

  const count =
    await icons.count();

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const href =
      await icons
        .nth(i)
        .getAttribute("href");

    if (!href) {
      continue;
    }

    try {
      const url =
        new URL(
          href,
          baseUrl,
        );

      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        continue;
      }

      url.hash = "";
      url.search = "";

      return url.href;
    } catch {
      // Ignore malformed icon URLs.
    }
  }

  /*
   * Fallback to the conventional
   * /favicon.ico location.
   */
  try {
    const url =
      new URL(baseUrl);

    url.pathname =
      "/favicon.ico";

    url.search = "";
    url.hash = "";

    return url.href;
  } catch {
    return null;
  }
}

/**
 * Collect resources referenced by
 * the current page.
 */
async function collectResourceUrls(
  page: Page,
): Promise<string[]> {
  const urls =
    new Set<string>();

  const baseUrl =
    page.url();

  /*
   * Stylesheets
   */
  const stylesheets =
    page.locator(
      'link[rel~="stylesheet"][href]',
    );

  const stylesheetCount =
    await stylesheets.count();

  for (
    let i = 0;
    i < stylesheetCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await stylesheets
        .nth(i)
        .getAttribute(
          "href",
        ),
      baseUrl,
    );
  }

  /*
   * Icons
   */
  const icons =
    page.locator(
      'link[rel~="icon"][href], link[rel~="shortcut icon"][href]',
    );

  const iconCount =
    await icons.count();

  for (
    let i = 0;
    i < iconCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await icons
        .nth(i)
        .getAttribute(
          "href",
        ),
      baseUrl,
    );
  }

  /*
   * preload / modulepreload
   */
  const preloads =
    page.locator(
      'link[rel~="preload"][href], link[rel~="modulepreload"][href]',
    );

  const preloadCount =
    await preloads.count();

  for (
    let i = 0;
    i < preloadCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await preloads
        .nth(i)
        .getAttribute(
          "href",
        ),
      baseUrl,
    );
  }

  /*
   * Images
   */
  const images =
    page.locator(
      "img",
    );

  const imageCount =
    await images.count();

  for (
    let i = 0;
    i < imageCount;
    i++
  ) {
    const image =
      images.nth(i);

    addResourceUrl(
      urls,
      await image.getAttribute(
        "src",
      ),
      baseUrl,
    );

    const srcset =
      await image.getAttribute(
        "srcset",
      );

    if (srcset) {
      for (
        const candidate of
          srcset.split(",")
      ) {
        const url =
          candidate
            .trim()
            .split(/\s+/)[0];

        addResourceUrl(
          urls,
          url,
          baseUrl,
        );
      }
    }
  }

  /*
   * <source>
   */
  const sources =
    page.locator(
      "source",
    );

  const sourceCount =
    await sources.count();

  for (
    let i = 0;
    i < sourceCount;
    i++
  ) {
    const source =
      sources.nth(i);

    addResourceUrl(
      urls,
      await source.getAttribute(
        "src",
      ),
      baseUrl,
    );

    const srcset =
      await source.getAttribute(
        "srcset",
      );

    if (srcset) {
      for (
        const candidate of
          srcset.split(",")
      ) {
        const url =
          candidate
            .trim()
            .split(/\s+/)[0];

        addResourceUrl(
          urls,
          url,
          baseUrl,
        );
      }
    }
  }

  /*
   * Scripts
   */
  const scripts =
    page.locator(
      "script[src]",
    );

  const scriptCount =
    await scripts.count();

  for (
    let i = 0;
    i < scriptCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await scripts
        .nth(i)
        .getAttribute(
          "src",
        ),
      baseUrl,
    );
  }

  /*
   * Video/audio
   */
  const media =
    page.locator(
      "video[src], audio[src]",
    );

  const mediaCount =
    await media.count();

  for (
    let i = 0;
    i < mediaCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await media
        .nth(i)
        .getAttribute(
          "src",
        ),
      baseUrl,
    );
  }

  /*
   * Video posters
   */
  const posters =
    page.locator(
      "video[poster]",
    );

  const posterCount =
    await posters.count();

  for (
    let i = 0;
    i < posterCount;
    i++
  ) {
    addResourceUrl(
      urls,
      await posters
        .nth(i)
        .getAttribute(
          "poster",
        ),
      baseUrl,
    );
  }

  return [
    ...urls,
  ];
}

/*
 * ============================================================
 * DOWNLOAD
 * ============================================================
 */

async function downloadResource(
  context: BrowserContext,
  resourceUrl: string,
): Promise<{
  body: Buffer;
  contentType: string;
} | null> {
  try {
    const response =
      await context.request.get(
        resourceUrl,
        {
          timeout: 60_000,
        },
      );

    if (!response.ok()) {
      console.log(
        `  resource ${response.status()}: ${resourceUrl}`,
      );

      return null;
    }

    return {
      body:
        await response.body(),

      contentType:
        response.headers()
          ["content-type"] ?? "",
    };
  } catch {
    console.log(
      `  failed resource: ${resourceUrl}`,
    );

    return null;
  }
}

/*
 * ============================================================
 * INITIALIZE / RESUME MANIFEST
 * ============================================================
 */

await fs.mkdir(
  rawDir,
  {
    recursive: true,
  },
);

let manifest =
  await loadManifest();

if (manifest) {
  console.log(
    "=== RESUMING EXISTING CRAWL ===",
  );

  console.log(
    `Started: ${manifest.scrape.startedAt}`,
  );

  console.log(
    `Last updated: ${manifest.scrape.lastUpdatedAt}`,
  );

  console.log(
    `Pages: ${Object.keys(manifest.pages).length}`,
  );

  console.log(
    `Resources: ${Object.keys(manifest.resources).length}`,
  );

  console.log(
    `Queue: ${manifest.queue.length}`,
  );

  if (manifest.scrape.complete) {
    console.log();
    console.log(
      "Crawl is already complete.",
    );
    console.log(
      "Delete the raw directory to start a fresh crawl.",
    );

    process.exit(0);
  }

  /*
   * Make sure the manifest's start URL
   * matches the command.
   */
  const normalizedStart =
    normalizeUrl(
      start.href,
    );

  if (
    normalizeUrl(
      manifest.site.startUrl,
    ) !== normalizedStart
  ) {
    console.error();
    console.error(
      "ERROR: Existing manifest belongs to a different start URL.",
    );
    console.error(
      `Manifest: ${manifest.site.startUrl}`,
    );
    console.error(
      `Command:  ${start.href}`,
    );
    console.error();
    console.error(
      "Use a different raw directory or remove the existing manifest.",
    );

    process.exit(1);
  }
} else {
  const timestamp =
    now();

  manifest = {
    version: 1,

    site: {
      name:
        siteNameFromDir(),

      startUrl:
        normalizeUrl(
          start.href,
        ),
    },

    scope: {
      origin:
        start.origin,

      path:
        start.pathname,
    },

    scrape: {
      startedAt:
        timestamp,

      lastUpdatedAt:
        timestamp,

      completedAt:
        null,

      complete:
        false,
    },

    pages: {},

    resources: {},

    queue: [
      normalizeUrl(
        start.href,
      ),
    ],
  };

  await saveManifest(
    manifest,
  );

  console.log(
    "=== STARTING NEW CRAWL ===",
  );

  console.log(
    `Started: ${timestamp}`,
  );
}

/*
 * ============================================================
 * BROWSER
 * ============================================================
 */

const browser =
  await chromium.launch();

const context =
  await browser.newContext();

const page =
  await context.newPage();

/*
 * ============================================================
 * PHASE 1: CRAWL
 * ============================================================
 */

console.log();
console.log(
  "=== PHASE 1: CRAWL ===",
);

let pagesThisRun = 0;

while (
  manifest.queue.length > 0 &&
  pagesThisRun < maxPages
) {
  const requestedUrl =
    manifest.queue.shift()!;

  /*
   * Don't crawl a page that was
   * already successfully downloaded.
   */
  const existing =
    manifest.pages[
      requestedUrl
    ];

  if (
    existing?.status ===
    "downloaded"
  ) {
    continue;
  }

  console.log(
    `→ ${requestedUrl}`,
  );

  try {
    const response =
      await page.goto(
        requestedUrl,
        {
          waitUntil:
            "networkidle",

          timeout:
            60_000,
        },
      );

    if (!response) {
      throw new Error(
        "No response",
      );
    }

    const finalUrl =
      normalizeUrl(
        page.url(),
      );

    if (
      finalUrl !==
      requestedUrl
    ) {
      console.log(
        `  redirect → ${finalUrl}`,
      );
    }

    if (
      !inScope(finalUrl)
    ) {
      console.log(
        "  outside scope, skipping",
      );

      continue;
    }

    if (!response.ok()) {
      throw new Error(
        `HTTP ${response.status()}`,
      );
    }

    /*
     * Allow lazy-loaded resources
     * to appear.
     */
    await page.waitForTimeout(
      1000,
    );

    /*
     * Save raw HTML.
     */
    const html =
      await page.content();

    const pageRelativePath =
      pageOutputPath(
        finalUrl,
      );

    const pagePath =
      absoluteRawPath(
        pageRelativePath,
      );

    await fs.mkdir(
      path.dirname(pagePath),
      {
        recursive: true,
      },
    );

    await fs.writeFile(
      pagePath,
      html,
      "utf8",
    );

    const scrapedAt =
      now();

    /*
     * Record final URL.
     */
    manifest.pages[
      finalUrl
    ] = {
      path:
        pageRelativePath,

      status:
        "downloaded",

      scrapedAt,
    };

    /*
     * If this was a redirect, make
     * the requested URL point at the
     * final page too.
     */
    if (
      requestedUrl !==
      finalUrl
    ) {
      manifest.pages[
        requestedUrl
      ] = {
        path:
          pageRelativePath,

        status:
          "downloaded",

        scrapedAt,
      };
    }

    /*
     * Discover favicon.
     *
     * Only set it once. The first page that
     * exposes a valid favicon becomes the
     * site's favicon.
     */
    if (!manifest.icon) {
      const faviconUrl =
        await findFaviconUrl(page);

      if (faviconUrl) {
        manifest.icon = {
          url: faviconUrl,
        };

        console.log(
          `  favicon: ${faviconUrl}`,
        );
      }
    }

    /*
     * Discover resources.
     */
    const resourceUrls =
      await collectResourceUrls(
        page,
      );

    let newResources = 0;

    for (
      const resourceUrl of
        resourceUrls
    ) {
      if (
        isExternalNoise(
          resourceUrl,
        )
      ) {
        continue;
      }

      const normalized =
        normalizeUrl(
          resourceUrl,
        );

      if (
        !manifest.resources[
          normalized
        ]
      ) {
        manifest.resources[
          normalized
        ] = {
          path:
            resourceOutputPath(
              normalized,
            ),

          status:
            "discovered",
        };

        newResources++;
      }
    }

    console.log(
      `  captured ${resourceUrls.length} page resources (${newResources} new)`,
    );

    /*
     * Discover internal pages.
     */
    const anchors =
      page.locator(
        "a[href]",
      );

    const anchorCount =
      await anchors.count();

    let discovered =
      0;

    for (
      let i = 0;
      i < anchorCount;
      i++
    ) {
      const href =
        await anchors
          .nth(i)
          .getAttribute(
            "href",
          );

      if (!href) {
        continue;
      }

      try {
        const url =
          new URL(
            href,
            finalUrl,
          );

        if (
          url.protocol !==
            "http:" &&
          url.protocol !==
            "https:"
        ) {
          continue;
        }

        /*
         * Same-page #anchor.
         */
        if (
          url.pathname ===
            new URL(
              finalUrl,
            ).pathname &&
          url.search === "" &&
          url.hash
        ) {
          continue;
        }

        if (
          !inScope(
            url.href,
          )
        ) {
          continue;
        }

        const normalized =
          normalizeUrl(
            url.href,
          );

        /*
         * Already downloaded?
         */
        if (
          manifest.pages[
            normalized
          ]?.status ===
          "downloaded"
        ) {
          continue;
        }

        /*
         * Already queued?
         */
        if (
          manifest.queue.includes(
            normalized,
          )
        ) {
          continue;
        }

        manifest.queue.push(
          normalized,
        );

        /*
         * Record queued page.
         */
        if (
          !manifest.pages[
            normalized
          ]
        ) {
          manifest.pages[
            normalized
          ] = {
            path:
              pageOutputPath(
                normalized,
              ),

            status:
              "queued",
          };
        }

        discovered++;
      } catch {
        // Ignore malformed URLs.
      }
    }

    console.log(
      `  discovered ${discovered} new pages`,
    );

    pagesThisRun++;

    /*
     * Persist after every page.
     *
     * This is what makes the crawler
     * safely resumable.
     */
    await saveManifest(
      manifest,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `  ERROR: ${message}`,
    );

    /*
     * Mark the requested page as
     * failed, but don't permanently
     * lose it.
     *
     * Put it back at the end of the
     * queue so a later resume can retry.
     */
    manifest.pages[
      requestedUrl
    ] = {
      path:
        pageOutputPath(
          requestedUrl,
        ),

      status:
        "failed",

      error:
        message,
    };

    manifest.queue.push(
      requestedUrl,
    );

    await saveManifest(
      manifest,
    );
  }
}

/*
 * ============================================================
 * END OF CRAWL / RESUME INFORMATION
 * ============================================================
 */

console.log();
console.log(
  "=== CRAWL STATUS ===",
);

console.log(
  `Pages processed this run: ${pagesThisRun}`,
);

console.log(
  `Pages downloaded: ${
  Object.values(
    manifest.pages,
  ).filter(
    page =>
      page.status ===
      "downloaded",
  ).length
}`,
);

console.log(
  `Pages remaining in queue: ${manifest.queue.length}`,
);

console.log(
  `Resources discovered: ${
  Object.keys(
    manifest.resources,
  ).length
}`,
);

if (
  manifest.queue.length === 0
) {
  manifest.scrape.complete =
    true;

  manifest.scrape.completedAt =
    now();

  await saveManifest(
    manifest,
  );

  console.log();
  console.log(
    "✓ Crawl completed: queue is empty.",
  );

  console.log(
    `Completed: ${manifest.scrape.completedAt}`,
  );
} else if (
  pagesThisRun >= maxPages
) {
  await saveManifest(
    manifest,
  );

  console.log();
  console.log(
    `⚠ Crawl paused because MAX_PAGES=${maxPages} was reached.`,
  );

  console.log(
    `  Pages remaining in queue: ${manifest.queue.length}`,
  );

  console.log();
  console.log(
    "Run the same command again to resume.",
  );
} else {
  await saveManifest(
    manifest,
  );

  console.log();
  console.log(
    "⚠ Crawl stopped before the queue was empty.",
  );

  console.log(
    `  Pages remaining in queue: ${manifest.queue.length}`,
  );
}

/*
 * ============================================================
 * PHASE 2: DOWNLOAD RESOURCES
 *
 * IMPORTANT:
 *
 * We download resources after page crawling,
 * but resource downloading is also resumable.
 *
 * A resource already marked "downloaded"
 * is skipped.
 * ============================================================
 */

console.log();
console.log(
  "=== PHASE 2: DOWNLOAD RESOURCES ===",
);

let resourcesDownloadedThisRun =
  0;

for (
  const [
    resourceUrl,
    record,
  ] of Object.entries(
    manifest.resources,
  )
) {
  if (
    record.status ===
    "downloaded"
  ) {
    continue;
  }

  if (
    isExternalNoise(
      resourceUrl,
    )
  ) {
    continue;
  }

  console.log(
    `→ ${resourceUrl}`,
  );

  try {
    const result =
      await downloadResource(
        context,
        resourceUrl,
      );

    if (!result) {
      throw new Error(
        "Download failed",
      );
    }

    const destination =
      absoluteRawPath(
        record.path,
      );

    await fs.mkdir(
      path.dirname(
        destination,
      ),
      {
        recursive: true,
      },
    );

    await fs.writeFile(
      destination,
      result.body,
    );

    record.status =
      "downloaded";

    record.contentType =
      result.contentType;

    record.scrapedAt =
      now();

    delete record.error;

    resourcesDownloadedThisRun++;

    await saveManifest(
      manifest,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `  ERROR: ${message}`,
    );

    record.status =
      "failed";

    record.error =
      message;

    await saveManifest(
      manifest,
    );
  }
}

console.log();
console.log(
  `Resources downloaded this run: ${resourcesDownloadedThisRun}`,
);

console.log(
  `Total resources: ${
  Object.keys(
    manifest.resources,
  ).length
}`,
);

console.log(
  `Resources successfully downloaded: ${
  Object.values(
    manifest.resources,
  ).filter(
    resource =>
      resource.status ===
      "downloaded",
  ).length
}`,
);

/*
 * ============================================================
 * FINISH
 * ============================================================
 */

await browser.close();

console.log();
console.log(
  "================================",
);
console.log(
  "DONE",
);
console.log(
  "================================",
);

console.log(
  `Raw snapshot: ${path.resolve(
  rawDir,
)}`,
);

console.log(
  `Manifest: ${path.resolve(
  manifestPath,
)}`,
);

console.log(
  `Started: ${manifest.scrape.startedAt}`,
);

console.log(
  `Last updated: ${manifest.scrape.lastUpdatedAt}`,
);

console.log(
  `Complete: ${manifest.scrape.complete}`,
);

if (
  manifest.scrape.completedAt
) {
  console.log(
    `Completed: ${manifest.scrape.completedAt}`,
  );
}

console.log(
  `Pages: ${Object.keys(
  manifest.pages,
).length}`,
);

console.log(
  `Resources: ${Object.keys(
  manifest.resources,
).length}`,
);

console.log(
  `Queue: ${manifest.queue.length}`,
);
