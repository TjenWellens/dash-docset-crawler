import fs from "node:fs/promises";
import path from "node:path";

const rawDir = process.argv[2];

if (!rawDir) {
  console.error(
    "Usage: npx tsx localize.ts <raw-dir> [localized-dir]",
  );
  process.exit(1);
}

const localizedDir =
  process.argv[3] ??
  rawDir.replace(/\/raw$/, "/localized");

const manifestPath =
  path.join(rawDir, "manifest.json");

type ManifestPage = {
  path: string;
  status: string;
  scrapedAt?: string;
};

type ManifestResource = {
  path: string;
  status: string;
  contentType?: string;
  downloadedAt?: string;
};

type Manifest = {
  version: number;

  site: {
    name: string;
    startUrl: string;
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

  pages: Record<string, ManifestPage>;

  resources?: Record<string, ManifestResource>;
};

const manifestText =
  await fs.readFile(
    manifestPath,
    "utf8",
  );

const manifest =
  JSON.parse(manifestText) as Manifest;

const origin =
  manifest.scope.origin;

const scopePath =
  manifest.scope.path.endsWith("/")
    ? manifest.scope.path
    : manifest.scope.path + "/";

console.log("=== LOCALIZE ===");
console.log(`Raw:       ${path.resolve(rawDir)}`);
console.log(`Localized: ${path.resolve(localizedDir)}`);
console.log();

if (!manifest.resources) {
  console.log(
    "Warning: manifest has no resources section.",
  );
}

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  url.hash = "";
  url.search = "";

  if (
    url.pathname !== "/" &&
    url.pathname.endsWith("/")
  ) {
    url.pathname =
      url.pathname.slice(0, -1);
  }

  return url.href;
}

function inScope(raw: string): boolean {
  const url = new URL(raw);

  return (
    url.origin === origin &&
    (
      url.pathname === scopePath.slice(0, -1) ||
      url.pathname.startsWith(scopePath)
    )
  );
}

/**
 * Turn a manifest-relative page path into
 * an absolute path inside rawDir.
 */
function rawPath(relativePath: string): string {
  return path.join(
    rawDir,
    relativePath,
  );
}

/**
 * Turn a manifest-relative page path into
 * the corresponding path inside localizedDir.
 */
function localizedPath(
  relativePath: string,
): string {
  return path.join(
    localizedDir,
    relativePath,
  );
}

/**
 * Calculate a relative URL from one local file
 * to another.
 */
function relativeLocalPath(
  fromFile: string,
  toFile: string,
): string {
  return path
    .relative(
      path.dirname(fromFile),
      toFile,
    )
    .split(path.sep)
    .join("/");
}

/**
 * Determine whether a resource path has
 * a recognizable file extension.
 */
function hasExtension(
  filePath: string,
): boolean {
  const basename =
    path.basename(filePath);

  return /\.[^./]+$/.test(
    basename,
  );
}

/**
 * If a CSS resource has no extension,
 * localize it as .css.
 *
 * Example:
 *
 *   resources/.../@docsearch/css@3
 *
 * becomes:
 *
 *   resources/.../@docsearch/css@3.css
 */
function localizedResourcePath(
  resource: ManifestResource,
): string {
  let relativePath =
    resource.path;

  const contentType =
    resource.contentType ?? "";

  if (
    contentType.includes("text/css") &&
    !hasExtension(relativePath)
  ) {
    relativePath += ".css";
  }

  return path.join(
    localizedDir,
    relativePath,
  );
}

/**
 * Build a lookup of normalized resource URL
 * -> localized filesystem path.
 */
const resourceMap =
  new Map<string, string>();

if (manifest.resources) {
  for (
    const [resourceUrl, resource]
    of Object.entries(
      manifest.resources,
    )
  ) {
    if (
      resource.status !== "downloaded"
    ) {
      continue;
    }

    const normalized =
      normalizeUrl(resourceUrl);

    resourceMap.set(
      normalized,
      localizedResourcePath(resource),
    );
  }
}

/**
 * Build a lookup of normalized page URL
 * -> localized filesystem path.
 *
 * Only downloaded pages are included.
 */
const pageMap =
  new Map<string, string>();

for (
  const [pageUrl, page]
  of Object.entries(
    manifest.pages,
  )
) {
  if (
    page.status !== "downloaded"
  ) {
    continue;
  }

  pageMap.set(
    normalizeUrl(pageUrl),
    localizedPath(page.path),
  );
}

console.log(
  `Downloaded pages:     ${pageMap.size}`,
);

console.log(
  `Downloaded resources: ${resourceMap.size}`,
);

console.log();

/*
 * ============================================================
 * REWRITE CSS
 * ============================================================
 */

function rewriteCss(
  css: string,
  cssUrl: string,
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (
      match,
      _quote,
      rawUrl,
    ) => {
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      let absolute: URL;

      try {
        absolute =
          new URL(
            rawUrl,
            cssUrl,
          );
      } catch {
        return match;
      }

      if (
        absolute.protocol !== "http:" &&
        absolute.protocol !== "https:"
      ) {
        return match;
      }

      const normalized =
        normalizeUrl(
          absolute.href,
        );

      const destination =
        resourceMap.get(
          normalized,
        );

      if (!destination) {
        /*
         * Resource wasn't downloaded.
         *
         * Keep the original CSS reference.
         */
        return match;
      }

      /*
       * We need the localized CSS file's
       * location as the source of the
       * relative path.
       */
      const source =
        localizedCssSourcePath(
          cssUrl,
        );

      const relative =
        relativeLocalPath(
          source,
          destination,
        );

      return `url("${relative}")`;
    },
  );
}

/**
 * Find where a CSS resource lives in
 * localizedDir.
 */
function localizedCssSourcePath(
  cssUrl: string,
): string {
  const normalized =
    normalizeUrl(cssUrl);

  const destination =
    resourceMap.get(
      normalized,
    );

  if (destination) {
    return destination;
  }

  /*
   * This should normally never happen,
   * but gives us a deterministic fallback.
   */
  const resource =
    manifest.resources?.[normalized];

  if (resource) {
    return localizedResourcePath(
      resource,
    );
  }

  return path.join(
    localizedDir,
    "resources",
    new URL(cssUrl).hostname,
    new URL(cssUrl).pathname.replace(
      /^\/+/,
      "",
    ),
  );
}

/*
 * ============================================================
 * REWRITE HTML
 * ============================================================
 */

function rewriteHtml(
  html: string,
  pageUrl: string,
): string {
  const currentPagePath =
    pageMap.get(
      normalizeUrl(pageUrl),
    );

  if (!currentPagePath) {
    return html;
  }

  return html.replace(
    /(src|href|poster)=("([^"]+)"|'([^']+)')/gi,
    (
      match,
      attribute,
      _quoted,
      doubleUrl,
      singleUrl,
    ) => {
      const rawUrl =
        doubleUrl ??
        singleUrl;

      /*
       * Fragment-only anchors.
       */
      if (
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      /*
       * Non-HTTP URLs.
       */
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("mailto:") ||
        rawUrl.startsWith("javascript:") ||
        rawUrl.startsWith("tel:")
      ) {
        return match;
      }

      let absolute: URL;

      try {
        absolute =
          new URL(
            rawUrl,
            pageUrl,
          );
      } catch {
        return match;
      }

      /*
       * External links stay untouched.
       */
      if (
        absolute.origin !== origin
      ) {
        return match;
      }

      /*
       * Preserve #anchor.
       */
      const hash =
        absolute.hash;

      absolute.hash = "";

      const normalized =
        normalizeUrl(
          absolute.href,
        );

      /*
       * --------------------------------------------------------
       * INTERNAL PAGE
       * --------------------------------------------------------
       */

      const pageDestination =
        pageMap.get(
          normalized,
        );

      if (pageDestination) {
        let relative =
          relativeLocalPath(
            currentPagePath,
            pageDestination,
          );

        if (hash) {
          relative += hash;
        }

        return `${attribute}="${relative}"`;
      }

      /*
       * --------------------------------------------------------
       * LOCAL RESOURCE
       * --------------------------------------------------------
       */

      const resourceDestination =
        resourceMap.get(
          normalized,
        );

      if (resourceDestination) {
        let relative =
          relativeLocalPath(
            currentPagePath,
            resourceDestination,
          );

        if (hash) {
          relative += hash;
        }

        return `${attribute}="${relative}"`;
      }

      /*
       * --------------------------------------------------------
       * UNKNOWN INTERNAL URL
       * --------------------------------------------------------
       *
       * Don't guess.
       */
      return match;
    },
  );
}

/*
 * ============================================================
 * COPY + LOCALIZE RESOURCES
 * ============================================================
 */

console.log("=== RESOURCES ===");

let resourceCount = 0;

if (manifest.resources) {
  for (
    const [
      resourceUrl,
      resource,
    ]
    of Object.entries(
      manifest.resources,
    )
  ) {
    if (
      resource.status !==
      "downloaded"
    ) {
      continue;
    }

    const source =
      rawPath(
        resource.path,
      );

    const destination =
      localizedResourcePath(
        resource,
      );

    try {
      await fs.mkdir(
        path.dirname(
          destination,
        ),
        {
          recursive: true,
        },
      );

      /*
       * Read the raw resource.
       */
      let body =
        await fs.readFile(
          source,
        );

      /*
       * Rewrite CSS references.
       */
      if (
        (
          resource.contentType ??
          ""
        ).includes("text/css")
      ) {
        const css =
          body.toString(
            "utf8",
          );

        const rewritten =
          rewriteCss(
            css,
            resourceUrl,
          );

        body =
          Buffer.from(
            rewritten,
            "utf8",
          );
      }

      await fs.writeFile(
        destination,
        body,
      );

      resourceCount++;

      console.log(
        `  ${resourceUrl}`,
      );
    } catch (error) {
      console.error(
        `  FAILED ${resourceUrl}`,
      );
      console.error(
        `    ${error}`,
      );
    }
  }
}

console.log(
  `Localized resources: ${resourceCount}`,
);

console.log();

/*
 * ============================================================
 * COPY + LOCALIZE PAGES
 * ============================================================
 */

console.log("=== PAGES ===");

let pageCount = 0;

for (
  const [
    pageUrl,
    page,
  ]
  of Object.entries(
    manifest.pages,
  )
) {
  /*
   * This is the important part:
   *
   * only process pages that actually
   * exist in the raw crawl.
   */
  if (
    page.status !==
    "downloaded"
  ) {
    continue;
  }

  const source =
    rawPath(
      page.path,
    );

  const destination =
    localizedPath(
      page.path,
    );

  try {
    const original =
      await fs.readFile(
        source,
        "utf8",
      );

    const localized =
      rewriteHtml(
        original,
        pageUrl,
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
      localized,
      "utf8",
    );

    pageCount++;

    console.log(
      `  ${pageUrl}`,
    );
  } catch (error) {
    console.error(
      `  FAILED ${pageUrl}`,
    );

    console.error(
      `    ${error}`,
    );
  }
}

/*
 * ============================================================
 * DONE
 * ============================================================
 */

console.log();

console.log(
  "================================",
);

console.log(
  "LOCALIZATION COMPLETE",
);

console.log(
  "================================",
);

console.log(
  `Pages:     ${pageCount}`,
);

console.log(
  `Resources: ${resourceCount}`,
);

console.log(
  `Output:    ${path.resolve(
  localizedDir,
)}`,
);
