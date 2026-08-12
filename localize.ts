import fs from "node:fs/promises";
import path from "node:path";

const rawDir = process.argv[2];

if (!rawDir) {
  console.error(
    "Usage: npx tsx localize.ts <raw-dir> <local-dir>",
  );
  process.exit(1);
}

const localDir =
  process.argv[3] ??
  rawDir.replace(/\/raw$/, "/local");

const manifestPath =
  path.join(rawDir, "manifest.json");

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

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
  scrapedAt?: string;
};

type Manifest = {
  version: number;

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

  pages: Record<string, ManifestPage>;

  resources?: Record<
    string,
    ManifestResource
  >;
};

type LocalManifestPage = {
  path: string;
  sourcePath: string;
  status: "localized";
};

type LocalManifestResource = {
  path: string;
  sourcePath: string;
  status: "localized";
  contentType?: string;
};

type LocalManifest = {
  version: number;

  site: {
    name: string;
    startUrl: string;
  };

  icon?: {
    url: string;
    path: string;
  };

  scope: {
    origin: string;
    path: string;
  };

  entry: {
    url: string;
    path: string;
  };

  source: {
    manifest: string;
    scrapedAt: string | null;
    complete: boolean;
  };

  localizedAt: string;

  pages: Record<
    string,
    LocalManifestPage
  >;

  resources: Record<
    string,
    LocalManifestResource
  >;

  stats: {
    pages: number;
    resources: number;
  };
};

/*
 * ============================================================
 * READ RAW MANIFEST
 * ============================================================
 */

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
console.log(
  `Raw:   ${path.resolve(rawDir)}`,
);
console.log(
  `Local: ${path.resolve(localDir)}`,
);
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
      url.pathname ===
        scopePath.slice(0, -1) ||
      url.pathname.startsWith(scopePath)
    )
  );
}

/**
 * Turn a manifest-relative path into
 * an absolute path inside rawDir.
 */
function rawPath(
  relativePath: string,
): string {
  return path.join(
    rawDir,
    relativePath,
  );
}

/**
 * Turn a manifest-relative path into
 * an absolute path inside localDir.
 */
function localPath(
  relativePath: string,
): string {
  return path.join(
    localDir,
    relativePath,
  );
}

/**
 * Calculate a relative URL/path from one
 * local file to another.
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
 * Determine whether a path has a recognizable
 * file extension.
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
 * CSS resources such as:
 *
 *   @docsearch/css@3
 *
 * don't necessarily have a file extension.
 *
 * Give CSS files a .css extension in
 * the localized package.
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
    localDir,
    relativePath,
  );
}

/*
 * ============================================================
 * BUILD PAGE LOOKUP
 * ============================================================
 */

/**
 * Normalized page URL
 * ->
 * localized filesystem path.
 *
 * Only downloaded pages are included.
 */
const pageMap =
  new Map<string, string>();

for (
  const [
    pageUrl,
    page,
  ] of Object.entries(
    manifest.pages,
  )
) {
  if (
    page.status !==
    "downloaded"
  ) {
    continue;
  }

  pageMap.set(
    normalizeUrl(pageUrl),
    localPath(page.path),
  );
}

/*
 * ============================================================
 * BUILD RESOURCE LOOKUPS
 * ============================================================
 */

/**
 * Normalized resource URL
 * ->
 * localized filesystem path.
 */
const resourceMap =
  new Map<string, string>();

let localizedIcon:
  | {
  url: string;
  path: string;
}
  | undefined;

if (manifest.icon) {
  const iconResource =
    manifest.resources?.[
      manifest.icon.url
      ];

  if (
    iconResource &&
    iconResource.status ===
    "downloaded"
  ) {
    localizedIcon = {
      url: manifest.icon.url,
      path: iconResource.path,
    };
  } else {
    console.warn(
      `Warning: icon ${manifest.icon.url} was not downloaded.`,
    );
  }
}

/**
 * Normalized resource URL
 * ->
 * original manifest resource.
 *
 * This is separate from resourceMap because
 * normalizeUrl() may change the manifest key.
 */
const resourceEntryMap =
  new Map<
    string,
    {
      url: string;
      resource: ManifestResource;
    }
  >();

if (manifest.resources) {
  for (
    const [
      resourceUrl,
      resource,
    ] of Object.entries(
      manifest.resources,
    )
  ) {
    if (
      resource.status !==
      "downloaded"
    ) {
      continue;
    }

    const normalized =
      normalizeUrl(resourceUrl);

    const destination =
      localizedResourcePath(
        resource,
      );

    resourceMap.set(
      normalized,
      destination,
    );

    resourceEntryMap.set(
      normalized,
      {
        url: resourceUrl,
        resource,
      },
    );
  }
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
 * DETERMINE ENTRY PAGE
 * ============================================================
 *
 * The crawler's startUrl is:
 *
 *   https://orm.drizzle.team/docs
 *
 * In the raw manifest this maps to:
 *
 *   pages/orm.drizzle.team/docs/overview.html
 *
 * We preserve that mapping explicitly in the
 * localized manifest so package.ts doesn't have
 * to rediscover it.
 */

const entryUrl =
  manifest.site.startUrl;

const entryNormalized =
  normalizeUrl(entryUrl);

const entryPath =
  pageMap.get(
    entryNormalized,
  );

if (!entryPath) {
  console.error(
    `ERROR: Entry page was not downloaded: ${entryUrl}`,
  );

  process.exit(1);
}

const entryRelativePath =
  path.relative(
    localDir,
    entryPath,
  )
    .split(path.sep)
    .join("/");

console.log(
  `Entry: ${entryUrl}`,
);

console.log(
  `Entry file: ${entryRelativePath}`,
);

console.log();

/*
 * ============================================================
 * CREATE LOCALIZED MANIFEST
 * ============================================================
 */

const localManifest: LocalManifest = {
  version: 1,

  site: {
    name: manifest.site.name,
    startUrl: manifest.site.startUrl,
  },

  ...(localizedIcon
    ? {
      icon: localizedIcon,
    }
    : {}),

  scope: {
    origin: manifest.scope.origin,
    path: manifest.scope.path,
  },

  entry: {
    url: entryUrl,
    path: entryRelativePath,
  },

  source: {
    manifest: path.relative(
      localDir,
      manifestPath,
    ),

    scrapedAt:
      manifest.scrape.completedAt ??
      manifest.scrape.lastUpdatedAt ??
      null,

    complete:
      manifest.scrape.complete,
  },

  localizedAt:
    new Date().toISOString(),

  pages: {},

  resources: {},

  stats: {
    pages: 0,
    resources: 0,
  },
};

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
      /*
       * Data URLs and fragments are not
       * filesystem resources.
       */
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

      /*
       * Only HTTP(S) resources can have
       * been downloaded by the crawler.
       */
      if (
        absolute.protocol !==
          "http:" &&
        absolute.protocol !==
          "https:"
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

      /*
       * Resource wasn't downloaded.
       *
       * Keep the original reference rather
       * than guessing.
       */
      if (!destination) {
        return match;
      }

      const source =
        localCssSourcePath(
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
 * Find where a CSS resource lives
 * inside localDir.
 */
function localCssSourcePath(
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

  const entry =
    resourceEntryMap.get(
      normalized,
    );

  if (entry) {
    return localizedResourcePath(
      entry.resource,
    );
  }

  /*
   * Deterministic fallback.
   */
  const url =
    new URL(cssUrl);

  return path.join(
    localDir,
    "resources",
    url.hostname,
    url.pathname.replace(
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
       * UNKNOWN SAME-ORIGIN URL
       * --------------------------------------------------------
       *
       * This is a real online page on the same
       * site, but outside the crawl scope.
       *
       * Example:
       *
       *   /packages
       *
       * becomes:
       *
       *   https://svelte.dev/packages
       *
       * rather than remaining:
       *
       *   /packages
       *
       * which Dash would resolve against its
       * local HTTP server.
       */
      let onlineUrl =
        absolute.href;

      if (hash) {
        onlineUrl += hash;
      }

      return `${attribute}="${onlineUrl}"`;
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
    ] of Object.entries(
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
       * Read raw resource.
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

      /*
       * Add successfully localized
       * resource to local manifest.
       */
      localManifest.resources[
        resourceUrl
      ] = {
        path: path.relative(
          localDir,
          destination,
        ),

        sourcePath:
          resource.path,

        status: "localized",

        ...(resource.contentType
          ? {
              contentType:
                resource.contentType,
            }
          : {}),
      };

      localManifest.stats.resources++;

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
  ] of Object.entries(
    manifest.pages,
  )
) {
  /*
   * Only process pages that actually
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
    localPath(
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

    /*
     * Add successfully localized
     * page to local manifest.
     */
    localManifest.pages[
      pageUrl
    ] = {
      path: path.relative(
        localDir,
        destination,
      ),

      sourcePath:
        page.path,

      status: "localized",
    };

    localManifest.stats.pages++;

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
 * WRITE LOCAL MANIFEST
 * ============================================================
 */

const localManifestPath =
  path.join(
    localDir,
    "manifest.json",
  );

await fs.mkdir(
  localDir,
  {
    recursive: true,
  },
);

await fs.writeFile(
  localManifestPath,
  JSON.stringify(
    localManifest,
    null,
    2,
  ) + "\n",
  "utf8",
);

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
  `Output:    ${path.resolve(localDir)}`,
);

console.log(
  `Manifest:  ${path.resolve(
  localManifestPath,
)}`,
);
