import fs from "node:fs/promises";
import path from "node:path";

type ManifestResource = {
  url: string;
  contentType?: string;
};

type ManifestPage = {
  url: string;
  path: string;
};

type Manifest = {
  pages?: ManifestPage[];
  resources?: ManifestResource[];
};

const rawDir = process.argv[2];
const outputDir = process.argv[3];

if (!rawDir || !outputDir) {
  console.error(
    "Usage: npx tsx localize.ts <raw-dir> <output-dir>",
  );
  process.exit(1);
}

const manifestPath =
  path.join(rawDir, "manifest.json");

const manifest: Manifest =
  JSON.parse(
    await fs.readFile(
      manifestPath,
      "utf8",
    ),
  );

const pages =
  manifest.pages ?? [];

const resources =
  manifest.resources ?? [];

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

function pageOutputPath(
  urlString: string,
): string {
  const url =
    new URL(urlString);

  let pathname =
    url.pathname;

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    pathname = "index.html";
  } else {
    pathname =
      pathname.replace(/^\/+/, "");

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
    outputDir,
    "pages",
    url.hostname,
    pathname,
  );
}

function rawPagePath(
  page: ManifestPage,
): string {
  return path.join(
    rawDir,
    page.path,
  );
}

function rawResourcePath(
  resourceUrl: string,
): string {
  const url =
    new URL(resourceUrl);

  let pathname =
    url.pathname.replace(
      /^\/+/,
      "",
    );

  if (!pathname) {
    pathname = "index";
  }

  return path.join(
    rawDir,
    "resources",
    url.hostname,
    pathname,
  );
}

/**
 * Decide whether a resource should have
 * an extension added.
 *
 * Most importantly:
 *
 *   text/css + no .css
 *     -> .css
 */
function localizedResourcePath(
  rawPath: string,
  contentType: string,
): string {
  const type =
    contentType
      .split(";", 1)[0]
      .trim()
      .toLowerCase();

  if (
    type === "text/css" &&
    !rawPath
      .toLowerCase()
      .endsWith(".css")
  ) {
    return `${rawPath}.css`;
  }

  return rawPath;
}

function relativePath(
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
 * Build page URL -> local path.
 */
const pageMap =
  new Map<string, string>();

for (const page of pages) {
  pageMap.set(
    normalizeUrl(page.url),
    pageOutputPath(page.url),
  );
}

/**
 * Build resource URL -> local path.
 *
 * This is where extensionless CSS becomes
 * extensionful CSS.
 */
const resourceMap =
  new Map<string, string>();

for (const resource of resources) {
  const normalized =
    normalizeUrl(resource.url);

  const rawPath =
    rawResourcePath(
      resource.url,
    );

  const localPath =
    localizedResourcePath(
      rawPath,
      resource.contentType ?? "",
    );

  resourceMap.set(
    normalized,
    localPath,
  );
}

console.log("=== LOCALIZE ===");
console.log(
  `Pages:     ${pageMap.size}`,
);
console.log(
  `Resources: ${resourceMap.size}`,
);

/**
 * Rewrite url(...) references inside CSS.
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

      try {
        const absolute =
          normalizeUrl(
            new URL(
              rawUrl,
              cssUrl,
            ).href,
          );

        const destination =
          resourceMap.get(
            absolute,
          );

        if (!destination) {
          return match;
        }

        /*
         * CSS files themselves may have had
         * ".css" appended during localization,
         * so calculate the relative path from
         * the localized CSS file.
         */
        const cssLocalPath =
          resourceMap.get(
            normalizeUrl(cssUrl),
          );

        if (!cssLocalPath) {
          return match;
        }

        const relative =
          relativePath(
            cssLocalPath,
            destination,
          );

        return `url("${relative}")`;
      } catch {
        return match;
      }
    },
  );
}

/**
 * Rewrite HTML attributes.
 */
function rewriteHtml(
  html: string,
  pageUrl: string,
): string {
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
       * Preserve fragment-only links.
       */
      if (
        rawUrl.startsWith("#")
      ) {
        return match;
      }

      /*
       * Preserve non-HTTP URLs.
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
       * External URLs remain untouched.
       */
      if (
        absolute.origin !==
        new URL(pageUrl).origin
      ) {
        return match;
      }

      const hash =
        absolute.hash;

      absolute.hash = "";

      const normalized =
        normalizeUrl(
          absolute.href,
        );

      /*
       * --------------------------------------------------------
       * Internal page
       * --------------------------------------------------------
       */
      const pageDestination =
        pageMap.get(
          normalized,
        );

      if (pageDestination) {
        let relative =
          relativePath(
            pageOutputPath(
              pageUrl,
            ),
            pageDestination,
          );

        if (hash) {
          relative += hash;
        }

        return `${attribute}="${relative}"`;
      }

      /*
       * --------------------------------------------------------
       * Resource
       * --------------------------------------------------------
       */
      const resourceDestination =
        resourceMap.get(
          normalized,
        );

      if (
        resourceDestination
      ) {
        const relative =
          relativePath(
            pageOutputPath(
              pageUrl,
            ),
            resourceDestination,
          );

        return `${attribute}="${relative}"`;
      }

      /*
       * Unknown internal URL:
       *
       * Don't guess.
       */
      return match;
    },
  );
}

/**
 * Make sure a directory exists.
 */
async function ensureParent(
  filename: string,
): Promise<void> {
  await fs.mkdir(
    path.dirname(filename),
    {
      recursive: true,
    },
  );
}

/**
 * ------------------------------------------------------------
 * COPY + REWRITE RESOURCES
 * ------------------------------------------------------------
 */

let copiedResources = 0;
let rewrittenCss = 0;

for (const resource of resources) {
  const normalized =
    normalizeUrl(resource.url);

  const destination =
    resourceMap.get(
      normalized,
    );

  if (!destination) {
    continue;
  }

  const source =
    rawResourcePath(
      resource.url,
    );

  try {
    const body =
      await fs.readFile(
        source,
      );

    await ensureParent(
      destination,
    );

    const contentType =
      resource.contentType ??
      "";

    if (
      contentType
        .toLowerCase()
        .includes("text/css")
    ) {
      const css =
        rewriteCss(
          body.toString("utf8"),
          resource.url,
        );

      await fs.writeFile(
        destination,
        css,
        "utf8",
      );

      rewrittenCss++;

      console.log(
        `  CSS  ${destination}`,
      );
    } else {
      await fs.writeFile(
        destination,
        body,
      );

      console.log(
        `  COPY ${destination}`,
      );
    }

    copiedResources++;
  } catch (error) {
    console.error(
      `  FAILED ${source}`,
      error,
    );
  }
}

/**
 * ------------------------------------------------------------
 * COPY + REWRITE PAGES
 * ------------------------------------------------------------
 */

let localizedPages = 0;

for (const page of pages) {
  const source =
    rawPagePath(page);

  const destination =
    pageOutputPath(
      page.url,
    );

  try {
    const html =
      await fs.readFile(
        source,
        "utf8",
      );

    const localized =
      rewriteHtml(
        html,
        page.url,
      );

    await ensureParent(
      destination,
    );

    await fs.writeFile(
      destination,
      localized,
      "utf8",
    );

    localizedPages++;

    console.log(
      `  PAGE ${destination}`,
    );
  } catch (error) {
    console.error(
      `  FAILED ${source}`,
      error,
    );
  }
}

console.log();
console.log(
  "================================",
);
console.log("DONE");
console.log(
  "================================",
);
console.log(
  `Pages:          ${localizedPages}`,
);
console.log(
  `Resources:      ${copiedResources}`,
);
console.log(
  `CSS rewritten:   ${rewrittenCss}`,
);
console.log(
  `Output:          ${path.resolve(outputDir)}`,
);
