import fs from "node:fs/promises";
import path from "node:path";

const rawRoot =
  path.resolve(process.argv[2] ?? "docs/drizzle/raw");

const localRoot =
  path.resolve(process.argv[3] ?? rawRoot.replace(/\/raw$/, "/local"));

const manifestFile =
  path.join(rawRoot, "manifest.json");

type Manifest = {
  [key: string]: unknown;
};

type ResourceMap = Map<string, string>;

type PageMap = Map<string, string>;

async function main() {
  console.log("=== LOCALIZE ===");
  console.log();
  console.log(`Raw:   ${rawRoot}`);
  console.log(`Local: ${localRoot}`);
  console.log();

  const manifest = await loadManifest();

  const pageMap = await buildPageMap();
  const resourceMap = await buildResourceMap();

  console.log(
    `Pages:     ${pageMap.size}`,
  );

  console.log(
    `Resources: ${resourceMap.size}`,
  );

  await fs.mkdir(
    localRoot,
    { recursive: true },
  );

  /*
   * Copy the manifest.
   *
   * The raw manifest is metadata about the crawl.
   * We don't mutate it.
   */
  await writeLocalManifest(manifest);

  /*
   * Copy resources first.
   *
   * We will rewrite CSS in-place in the LOCAL copy.
   */
  await copyResources(resourceMap);

  /*
   * Rewrite CSS after all resources have their
   * final local paths.
   */
  await rewriteCssFiles(resourceMap);

  /*
   * Finally copy and rewrite HTML.
   */
  await localizePages(
    pageMap,
    resourceMap,
  );

  console.log();
  console.log("================================");
  console.log("DONE");
  console.log("================================");

  console.log(
    `Pages:     ${pageMap.size}`,
  );

  console.log(
    `Resources: ${resourceMap.size}`,
  );

  console.log(
    `Output:    ${localRoot}`,
  );
}

/**
 * Read the crawl manifest if one exists.
 *
 * We don't actually depend on the manifest for the
 * URL/path mapping because the raw filesystem itself
 * is authoritative.
 */
async function loadManifest(): Promise<Manifest | null> {
  try {
    const text =
      await fs.readFile(
        manifestFile,
        "utf8",
      );

    return JSON.parse(text);
  } catch {
    console.log(
      "No manifest.json found; continuing from filesystem.",
    );

    return null;
  }
}

/**
 * Build:
 *
 *   https://orm.drizzle.team/docs/overview
 *
 * ->
 *
 *   raw/pages/orm.drizzle.team/docs/overview.html
 *
 * We infer the URL from the filesystem structure.
 *
 * This is intentionally kept compatible with the crawler's
 * output layout.
 */
async function buildPageMap(): Promise<PageMap> {
  const result: PageMap = new Map();

  const files =
    await walkFiles(
      path.join(
        rawRoot,
        "pages",
      ),
    );

  for (
    const file of files
  ) {
    if (
      !file.endsWith(".html")
    ) {
      continue;
    }

    const relative =
      path.relative(
        path.join(
          rawRoot,
          "pages",
        ),
        file,
      );

    const parts =
      relative.split(
        path.sep,
      );

    if (
      parts.length < 2
    ) {
      continue;
    }

    const hostname =
      parts.shift()!;

    let pathname =
      parts.join("/");

    if (
      pathname === "index.html"
    ) {
      pathname = "/";
    } else if (
      pathname.endsWith(".html")
    ) {
      pathname =
        pathname.slice(
          0,
          -".html".length,
        );
    }

    /*
     * The crawler normalizes trailing slashes.
     */
    const url =
      `https://${hostname}${pathname}`;

  result.set(
    normalizeUrl(url),
    file,
  );
}

return result;
}

/**
 * Build:
 *
 *   https://orm.drizzle.team/_astro/foo.css
 *
 * ->
 *
 *   raw/resources/orm.drizzle.team/_astro/foo.css
 */
async function buildResourceMap(): Promise<ResourceMap> {
  const result: ResourceMap = new Map();

  const files =
    await walkFiles(
      path.join(
        rawRoot,
        "resources",
      ),
    );

  for (
    const file of files
    ) {
    const relative =
      path.relative(
        path.join(
          rawRoot,
          "resources",
        ),
        file,
      );

    const parts =
      relative.split(
        path.sep,
      );

    if (
      parts.length < 2
    ) {
      continue;
    }

    const hostname =
      parts.shift()!;

    const pathname =
      "/" +
      parts.join("/");

    const url =
      `https://${hostname}${pathname}`;

    result.set(
      normalizeUrl(url),
      file,
    );
  }

  return result;
}

/**
 * Normalize URL in the same way as crawl.ts:
 *
 * - remove hash
 * - remove query
 * - remove trailing slash except root
 */
function normalizeUrl(
  raw: string,
): string {
  const url =
    new URL(raw);

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
 * Walk a directory recursively.
 */
async function walkFiles(
  directory: string,
): Promise<string[]> {
  const result: string[] = [];

  let entries;

  try {
    entries =
      await fs.readdir(
        directory,
        {
          withFileTypes: true,
        },
      );
  } catch {
    return result;
  }

  for (
    const entry of entries
    ) {
    const fullPath =
      path.join(
        directory,
        entry.name,
      );

    if (
      entry.isDirectory()
    ) {
      result.push(
        ...await walkFiles(
          fullPath,
        ),
      );
    } else {
      result.push(
        fullPath,
      );
    }
  }

  return result;
}

/**
 * Copy every raw resource to the local tree.
 */
async function copyResources(
  resourceMap: ResourceMap,
): Promise<void> {
  console.log();
  console.log("=== COPY RESOURCES ===");

  for (
    const [
      _url,
      source,
    ] of resourceMap
    ) {
    const relative =
      path.relative(
        path.join(
          rawRoot,
          "resources",
        ),
        source,
      );

    const destination =
      path.join(
        localRoot,
        "resources",
        relative,
      );

    await fs.mkdir(
      path.dirname(
        destination,
      ),
      {
        recursive: true,
      },
    );

    await fs.copyFile(
      source,
      destination,
    );
  }

  console.log(
    `Copied ${resourceMap.size} resources`,
  );
}

/**
 * Rewrite every CSS file in the LOCAL copy.
 *
 * Raw CSS is never modified.
 */
async function rewriteCssFiles(
  resourceMap: ResourceMap,
): Promise<void> {
  console.log();
  console.log("=== REWRITE CSS ===");

  for (
    const [
      resourceUrl,
      rawFile,
    ] of resourceMap
    ) {
    if (
      !isCssFile(rawFile)
    ) {
      continue;
    }

    const relative =
      path.relative(
        path.join(
          rawRoot,
          "resources",
        ),
        rawFile,
      );

    const localFile =
      path.join(
        localRoot,
        "resources",
        relative,
      );

    try {
      let css =
        await fs.readFile(
          localFile,
          "utf8",
        );

      css =
        rewriteCss(
          css,
          resourceUrl,
          resourceMap,
        );

      await fs.writeFile(
        localFile,
        css,
      );

      console.log(
        `  ${resourceUrl}`,
      );
    } catch (error) {
      console.log(
        `  failed: ${resourceUrl}`,
      );

      console.log(
        `    ${error}`,
      );
    }
  }
}

/**
 * Detect CSS.
 *
 * We use both extension and content where possible.
 */
function isCssFile(
  file: string,
): boolean {
  return (
    file.endsWith(".css") ||
    path.basename(file).includes("css@")
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
 *   url("../orm.drizzle.team/_astro/foo.webp")
 *
 * depending on the CSS file's location.
 */
function rewriteCss(
  css: string,
  cssUrl: string,
  resourceMap: ResourceMap,
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (
      match,
      _quote,
      rawUrl,
    ) => {
      /*
       * Data URLs and fragments are already local.
       */
      if (
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      /*
       * CSS variables / unusual values.
       */
      if (
        rawUrl.startsWith("--")
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
       * External CSS assets remain external
       * unless the crawler actually downloaded them.
       */
      const normalized =
        normalizeUrl(
          absolute.href,
        );

      const destination =
        resourceMap.get(
          normalized,
        );

      if (!destination) {
        return match;
      }

      const cssRawFile =
        resourceMap.get(
          normalizeUrl(cssUrl),
        );

      if (!cssRawFile) {
        return match;
      }

      const cssLocalFile =
        path.join(
          localRoot,
          "resources",
          path.relative(
            path.join(
              rawRoot,
              "resources",
            ),
            cssRawFile,
          ),
        );

      const resourceLocalFile =
        path.join(
          localRoot,
          "resources",
          path.relative(
            path.join(
              rawRoot,
              "resources",
            ),
            destination,
          ),
        );

      let relative =
        path.relative(
          path.dirname(
            cssLocalFile,
          ),
          resourceLocalFile,
        );

      relative =
        relative
          .split(path.sep)
          .join("/");

      return `url("${relative}")`;
    },
  );
}

/**
 * Localize every HTML page.
 *
 * The raw HTML is copied to local/pages and rewritten.
 */
async function localizePages(
  pageMap: PageMap,
  resourceMap: ResourceMap,
): Promise<void> {
  console.log();
  console.log("=== LOCALIZE HTML ===");

  for (
    const [
      pageUrl,
      rawFile,
    ] of pageMap
    ) {
    const relative =
      path.relative(
        path.join(
          rawRoot,
          "pages",
        ),
        rawFile,
      );

    const localFile =
      path.join(
        localRoot,
        "pages",
        relative,
      );

    let html =
      await fs.readFile(
        rawFile,
        "utf8",
      );

    html =
      rewriteHtml(
        html,
        pageUrl,
        pageMap,
        resourceMap,
      );

    await fs.mkdir(
      path.dirname(
        localFile,
      ),
      {
        recursive: true,
      },
    );

    await fs.writeFile(
      localFile,
      html,
    );

    console.log(
      `  ${pageUrl}`,
    );
  }
}

/**
 * Rewrite HTML links/resources.
 *
 * Rules:
 *
 * #foo
 *   -> unchanged
 *
 * https://external.example
 *   -> unchanged
 *
 * /docs/gotchas
 *   -> local pages/gotchas.html
 *
 * /_astro/foo.css
 *   -> local resources/_astro/foo.css
 *
 * ../../something.png
 *   -> local resource if it was crawled
 */
function rewriteHtml(
  html: string,
  pageUrl: string,
  pageMap: PageMap,
  resourceMap: ResourceMap,
): string {
  /*
   * src / href / poster
   */
  html =
    html.replace(
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

        const rewritten =
          localizeUrl(
            rawUrl,
            pageUrl,
            pageMap,
            resourceMap,
          );

        if (
          rewritten === null
        ) {
          return match;
        }

        return `${attribute}="${rewritten}"`;
      },
    );

  /*
   * srcset.
   */
  html =
    html.replace(
      /(srcset)=("([^"]+)"|'([^']+)')/gi,
      (
        match,
        attribute,
        _quoted,
        doubleValue,
        singleValue,
      ) => {
        const rawValue =
          doubleValue ??
          singleValue;

        const rewritten =
          rewriteSrcset(
            rawValue,
            pageUrl,
            pageMap,
            resourceMap,
          );

        return `${attribute}="${rewritten}"`;
      },
    );

  return html;
}

/**
 * Rewrite one URL found in HTML.
 */
function localizeUrl(
  rawUrl: string,
  pageUrl: string,
  pageMap: PageMap,
  resourceMap: ResourceMap,
): string | null {
  /*
   * Empty / fragment-only URLs.
   */
  if (
    !rawUrl ||
    rawUrl.startsWith("#")
  ) {
    return null;
  }

  /*
   * Non-web schemes.
   */
  if (
    rawUrl.startsWith("data:") ||
    rawUrl.startsWith("mailto:") ||
    rawUrl.startsWith("javascript:") ||
    rawUrl.startsWith("tel:") ||
    rawUrl.startsWith("blob:")
  ) {
    return null;
  }

  let absolute: URL;

  try {
    absolute =
      new URL(
        rawUrl,
        pageUrl,
      );
  } catch {
    return null;
  }

  /*
   * External links remain external.
   */
  if (
    absolute.protocol !== "http:" &&
    absolute.protocol !== "https:"
  ) {
    return null;
  }

  /*
   * Preserve the fragment.
   */
  const hash =
    absolute.hash;

  /*
   * Normalize without losing the fragment.
   */
  const normalized =
    normalizeUrl(
      absolute.href,
    );

  /*
   * ------------------------------------------------------------
   * PAGE FIRST
   *
   * This is important.
   *
   * /docs/sustainability must be recognized as a PAGE,
   * not as an asset.
   * ------------------------------------------------------------
   */
  const pageFile =
    pageMap.get(
      normalized,
    );

  if (pageFile) {
    const localPageFile =
      path.join(
        localRoot,
        "pages",
        path.relative(
          path.join(
            rawRoot,
            "pages",
          ),
          pageFile,
        ),
      );

    const currentPageRawFile =
      pageMap.get(
        normalizeUrl(pageUrl),
      );

    if (!currentPageRawFile) {
      return null;
    }

    const currentLocalPageFile =
      path.join(
        localRoot,
        "pages",
        path.relative(
          path.join(
            rawRoot,
            "pages",
          ),
          currentPageRawFile,
        ),
      );

    let relative =
      path.relative(
        path.dirname(
          currentLocalPageFile,
        ),
        localPageFile,
      );

    relative =
      relative
        .split(path.sep)
        .join("/");

    if (
      hash
    ) {
      relative += hash;
    }

    return relative;
  }

  /*
   * ------------------------------------------------------------
   * RESOURCE
   * ------------------------------------------------------------
   */
  const resourceFile =
    resourceMap.get(
      normalized,
    );

  if (resourceFile) {
    const localResourceFile =
      path.join(
        localRoot,
        "resources",
        path.relative(
          path.join(
            rawRoot,
            "resources",
          ),
          resourceFile,
        ),
      );

    const currentPageRawFile =
      pageMap.get(
        normalizeUrl(pageUrl),
      );

    if (!currentPageRawFile) {
      return null;
    }

    const currentLocalPageFile =
      path.join(
        localRoot,
        "pages",
        path.relative(
          path.join(
            rawRoot,
            "pages",
          ),
          currentPageRawFile,
        ),
      );

    let relative =
      path.relative(
        path.dirname(
          currentLocalPageFile,
        ),
        localResourceFile,
      );

    relative =
      relative
        .split(path.sep)
        .join("/");

    return relative;
  }

  /*
   * Unknown external/internal URL:
   *
   * leave it alone rather than guessing.
   */
  return null;
}

/**
 * Rewrite srcset while preserving descriptors.
 *
 * Example:
 *
 *   /image.webp 1x, /image@2x.webp 2x
 *
 * becomes:
 *
 *   ../resources/.../image.webp 1x, ...
 */
function rewriteSrcset(
  value: string,
  pageUrl: string,
  pageMap: PageMap,
  resourceMap: ResourceMap,
): string {
  return value
    .split(",")
    .map(
      (candidate) => {
        const trimmed =
          candidate.trim();

        if (!trimmed) {
          return trimmed;
        }

        const parts =
          trimmed.split(
            /\s+/,
          );

        const url =
          parts.shift()!;

        const rewritten =
          localizeUrl(
            url,
            pageUrl,
            pageMap,
            resourceMap,
          );

        if (
          rewritten === null
        ) {
          return trimmed;
        }

        return [
          rewritten,
          ...parts,
        ].join(" ");
      },
    )
    .join(", ");
}

/**
 * Copy the raw manifest into local/.
 *
 * This does not mutate the original manifest.
 */
async function writeLocalManifest(
  manifest: Manifest | null,
): Promise<void> {
  if (!manifest) {
    return;
  }

  const destination =
    path.join(
      localRoot,
      "manifest.json",
    );

  await fs.writeFile(
    destination,
    JSON.stringify(
      {
        ...manifest,
        localizedAt:
          new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
