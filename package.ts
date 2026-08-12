import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import {fileURLToPath} from "node:url";
import sharp from "sharp";
import { decodeIco } from "icojs";

/*
 * ============================================================
 * PATH / MODULE HELPERS
 * ============================================================
 *
 * sql.js needs to locate sql-wasm.wasm at runtime.
 *
 * This works when running:
 *
 *   npx tsx package.ts ...
 *
 * and keeps the implementation platform-independent.
 */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/*
 * ============================================================
 * ARGUMENTS
 * ============================================================
 */

const localDir = process.argv[2];

if (!localDir) {
  console.error(
    "Usage: npx tsx package.ts <local-dir> <docset-dir>",
  );

  process.exit(1);
}

const docsetDir =
  process.argv[3] ??
  localDir.replace(
    /\/local$/,
    "/docset",
  );

const manifestPath =
  path.join(
    localDir,
    "manifest.json",
  );

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

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
 * READ MANIFEST
 * ============================================================
 */

const manifestText =
  await fs.readFile(
    manifestPath,
    "utf8",
  );

const manifest =
  JSON.parse(
    manifestText,
  ) as LocalManifest;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

/**
 * Escape a value for XML.
 */
function escapeXml(
  value: string,
): string {
  return value
    .replace(
      /&/g,
      "&amp;",
    )
    .replace(
      /</g,
      "&lt;",
    )
    .replace(
      />/g,
      "&gt;",
    )
    .replace(
      /"/g,
      "&quot;",
    )
    .replace(
      /'/g,
      "&apos;",
    );
}

/**
 * Convert a filesystem path into a
 * path relative to Documents.
 */
function documentsPath(
  relativePath: string,
): string {
  return relativePath
    .split(path.sep)
    .join("/");
}

/**
 * Extract the HTML <title>.
 */
function extractTitle(
  html: string,
): string | null {
  const match =
    html.match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i,
    );

  if (!match) {
    return null;
  }

  return cleanHtmlText(
    match[1],
  );
}

/**
 * Extract headings that have IDs.
 *
 * Example:
 *
 *   <h2 id="select">Select</h2>
 *
 * becomes:
 *
 *   {
 *     name: "Select",
 *     id: "select",
 *     level: 2
 *   }
 */
function extractHeadings(
  html: string,
): Array<{
  name: string;
  id: string;
  level: number;
}> {
  const headings: Array<{
    name: string;
    id: string;
    level: number;
  }> = [];

  const regex =
    /<h([1-6])\b([^>]*)\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h\1>/gi;

  let match: RegExpExecArray | null;

  while (
    (match = regex.exec(html)) !== null
  ) {
    const level =
      Number(match[1]);

    const id =
      match[3];

    const name =
      cleanHtmlText(
        match[4],
      );

    if (!name || !id) {
      continue;
    }

    headings.push({
      name,
      id,
      level,
    });
  }

  return headings;
}

/**
 * Remove HTML tags and decode common
 * HTML entities.
 */
function cleanHtmlText(
  value: string,
): string {
  return value
    .replace(
      /<[^>]+>/g,
      "",
    )
    .replace(
      /&nbsp;/gi,
      " ",
    )
    .replace(
      /&amp;/gi,
      "&",
    )
    .replace(
      /&lt;/gi,
      "<",
    )
    .replace(
      /&gt;/gi,
      ">",
    )
    .replace(
      /&quot;/gi,
      '"',
    )
    .replace(
      /&#39;/gi,
      "'",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

/**
 * Determine the Dash search type for a page.
 */
function pageType(
  url: string,
): string {
  const pathname =
    new URL(url).pathname;

  if (
    pathname.endsWith("/api") ||
    pathname.includes("/api/")
  ) {
    return "API";
  }

  return "Guide";
}

/**
 * Determine the Dash search type
 * for a heading.
 */
function headingType(
  level: number,
): string {
  switch (level) {
    case 1:
      return "Guide";

    case 2:
    case 3:
      return "Section";

    default:
      return "Section";
  }
}

/**
 * Convert the site's name into
 * a display name.
 *
 * drizzle -> Drizzle
 */
function displayName(
  name: string,
): string {
  if (!name) {
    return "Documentation";
  }

  return (
    name.charAt(0).toUpperCase() +
    name.slice(1)
  );
}

/**
 * Make a filesystem-safe docset name.
 */
function safeName(
  name: string,
): string {
  return name
    .replace(
      /[^a-zA-Z0-9._-]+/g,
      "-",
    )
    .replace(
      /^-+|-+$/g,
      "",
    );
}

/**
 * Make a stable Dash bundle identifier.
 *
 * Example:
 *
 *   com.dash.docset.drizzle
 */
function bundleIdentifier(
  name: string,
): string {
  const normalized =
    name
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        "",
      );

  return `com.dash.docset.${normalized}`;
}

/*
 * ============================================================
 * PATHS
 * ============================================================
 */

const siteName =
  displayName(
    manifest.site.name,
  );

const docsetName =
  safeName(
    siteName,
  );

const contentsDir =
  path.join(
    docsetDir,
    "Contents",
  );

const resourcesDir =
  path.join(
    contentsDir,
    "Resources",
  );

const documentsDir =
  path.join(
    resourcesDir,
    "Documents",
  );

const infoPlistPath =
  path.join(
    contentsDir,
    "Info.plist",
  );

const indexPath =
  path.join(
    resourcesDir,
    "docSet.dsidx",
  );

/*
 * ============================================================
 * START
 * ============================================================
 */

console.log(
  "=== PACKAGE DOCSET ===",
);

console.log();

console.log(
  `Local:   ${path.resolve(localDir)}`,
);

console.log(
  `Docset:  ${path.resolve(docsetDir)}`,
);

console.log(
  `Name:    ${siteName}`,
);

console.log(
  `Entry:   ${manifest.entry.path}`,
);

console.log();

/*
 * ============================================================
 * VALIDATE MANIFEST
 * ============================================================
 */

if (!manifest.entry) {
  console.error(
    "ERROR: local/manifest.json has no entry field.",
  );

  process.exit(1);
}

if (!manifest.entry.path) {
  console.error(
    "ERROR: manifest.entry.path is empty.",
  );

  process.exit(1);
}

/*
 * ============================================================
 * VALIDATE ENTRY
 * ============================================================
 */

const entrySource =
  path.join(
    localDir,
    manifest.entry.path,
  );

try {
  await fs.access(
    entrySource,
  );
} catch {
  console.error(
    `ERROR: Entry file does not exist: ${entrySource}`,
  );

  process.exit(1);
}

/*
 * ============================================================
 * CLEAN OUTPUT
 * ============================================================
 *
 * Always build a fresh docset.
 *
 * This prevents stale pages/resources/indexes
 * from previous builds from remaining in the
 * generated package.
 */

await fs.rm(
  docsetDir,
  {
    recursive: true,
    force: true,
  },
);

await fs.mkdir(
  documentsDir,
  {
    recursive: true,
  },
);

/*
 * ============================================================
 * COPY LOCALIZED WEBSITE
 * ============================================================
 *
 * The resulting layout is:
 *
 * Contents/
 *   Resources/
 *     Documents/
 *       pages/
 *       resources/
 *
 * manifest.json itself is intentionally not
 * copied into Documents.
 */

console.log(
  "=== COPY DOCUMENTS ===",
);

const localEntries =
  await fs.readdir(
    localDir,
    {
      withFileTypes: true,
    },
  );

for (
  const entry of localEntries
) {
  if (
    entry.name ===
    "manifest.json"
  ) {
    continue;
  }

  const source =
    path.join(
      localDir,
      entry.name,
    );

  const destination =
    path.join(
      documentsDir,
      entry.name,
    );

  await fs.cp(
    source,
    destination,
    {
      recursive: true,
    },
  );

  console.log(
    `  ${entry.name}`,
  );
}

console.log();

/*
 * ============================================================
 * CREATE DOCSET ICON
 * ============================================================
 */

console.log(
  "=== CREATE ICON ===",
);

if (manifest.icon) {
  const iconSource =
    path.join(
      localDir,
      manifest.icon.path,
    );

  /*
   * Dash expects icon.png at the
   * ROOT of the .docset bundle.
   *
   * NOT:
   *
   * Contents/Resources/icon.png
   */
  const iconDestination =
    path.join(
      docsetDir,
      "icon.png",
    );

  try {
    await fs.access(
      iconSource,
    );

    const input =
      await fs.readFile(
        iconSource,
      );

    let pngBuffer: Buffer;

    try {
      /*
       * Try Sharp first.
       */
      pngBuffer =
        await sharp(input)
          .resize(
            32,
            32,
            {
              fit: "contain",
            },
          )
          .png()
          .toBuffer();
    } catch {
      /*
       * Sharp couldn't decode the favicon.
       *
       * This commonly happens with ICO files.
       */
      const images =
        await decodeIco(
          input,
          "image/png",
        );

      if (
        images.length === 0
      ) {
        throw new Error(
          "ICO file contains no images",
        );
      }

      /*
       * Pick the largest icon available.
       */
      const image =
        images.reduce(
          (largest, current) =>
            current.width >
            largest.width
              ? current
              : largest,
        );

      pngBuffer =
        await sharp(
          Buffer.from(
            image.buffer,
          ),
        )
          .resize(
            32,
            32,
            {
              fit: "contain",
            },
          )
          .png()
          .toBuffer();
    }

    await fs.writeFile(
      iconDestination,
      pngBuffer,
    );

    console.log(
      `  Source: ${manifest.icon.url}`,
    );

    console.log(
      `  Created: ${iconDestination}`,
    );
  } catch (error) {
    console.warn(
      "  WARNING: Could not create icon.png",
    );

    console.warn(
      `    ${error}`,
    );
  }
} else {
  console.log(
    "  No icon configured",
  );
}

console.log();

/*
 * ============================================================
 * BUILD SEARCH INDEX DATA
 * ============================================================
 */

console.log(
  "=== BUILD SEARCH INDEX ===",
);

const indexEntries: Array<{
  name: string;
  type: string;
  path: string;
}> = [];

let pageIndexCount = 0;
let headingIndexCount = 0;

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
    "localized"
  ) {
    continue;
  }

  const pagePath =
    documentsPath(
      page.path,
    );

  const source =
    path.join(
      localDir,
      page.path,
    );

  let html: string;

  try {
    html =
      await fs.readFile(
        source,
        "utf8",
      );
  } catch (error) {
    console.warn(
      `  WARNING: Could not read ${page.path}`,
    );

    console.warn(
      `    ${error}`,
    );

    continue;
  }

  /*
   * ----------------------------------------------------------
   * PAGE
   * ----------------------------------------------------------
   */

  const title =
    extractTitle(
      html,
    ) ??
    pageUrl;

  indexEntries.push({
    name: title,
    type: pageType(
      pageUrl,
    ),
    path: pagePath,
  });

  pageIndexCount++;

  /*
   * ----------------------------------------------------------
   * HEADINGS
   * ----------------------------------------------------------
   *
   * Dash can navigate directly to:
   *
   *   page.html#heading-id
   */

  const headings =
    extractHeadings(
      html,
    );

  for (
    const heading of headings
  ) {
    indexEntries.push({
      name: heading.name,
      type: headingType(
        heading.level,
      ),
      path:
        `${pagePath}#${heading.id}`,
    });

    headingIndexCount++;
  }
}

console.log(
  `  Pages:    ${pageIndexCount}`,
);

console.log(
  `  Headings: ${headingIndexCount}`,
);

console.log(
  `  Entries:  ${indexEntries.length}`,
);

console.log();

/*
 * ============================================================
 * CREATE SQLITE DATABASE WITH SQL.JS
 * ============================================================
 *
 * sql.js is SQLite compiled to WebAssembly.
 *
 * This means:
 *
 *   - no native Node addon
 *   - no system sqlite3 dependency
 *   - no platform-specific compilation
 *   - works on macOS, Linux and Windows
 *
 * Dash only requires docSet.dsidx to be a valid
 * SQLite database with the searchIndex table.
 */

console.log(
  "=== CREATE SQLITE INDEX ===",
);

try {
  const SQL =
    await initSqlJs({
      locateFile: (
        file: string,
      ) =>
        path.join(
          __dirname,
          "node_modules",
          "sql.js",
          "dist",
          file,
        ),
    });

  console.log(
    "  sql.js initialized",
  );

  /*
   * Create an in-memory SQLite database.
   */
  const db =
    new SQL.Database();

  console.log(
    "  SQLite database created",
  );

  /*
   * Create the schema expected by Dash.
   */
  db.run(`
CREATE TABLE searchIndex (
  id INTEGER PRIMARY KEY,
  name TEXT,
  type TEXT,
  path TEXT
);

CREATE UNIQUE INDEX anchor
ON searchIndex (
  name,
  type,
  path
);
`);

  console.log(
    "  searchIndex table created",
  );

  /*
   * Prepare one INSERT statement and
   * reuse it for every entry.
   */
  const insert =
    db.prepare(`
INSERT OR IGNORE INTO searchIndex
(
  name,
  type,
  path
)
VALUES
(
  $name,
  $type,
  $path
);
`);

  /*
   * Insert all pages/headings.
   */
  for (
    const entry of indexEntries
  ) {
    insert.run({
      $name:
        entry.name,

      $type:
        entry.type,

      $path:
        entry.path,
    });
  }

  insert.free();

  console.log(
    `  ${indexEntries.length} entries inserted`,
  );

  /*
   * Verify the number of rows before
   * exporting the database.
   */
  const result =
    db.exec(
      `
SELECT COUNT(*)
FROM searchIndex;
`,
    );

  const rowCount =
    result[0]
      ?.values[0]
      ?.[0];

  console.log(
    `  SQLite rows: ${rowCount}`,
  );

  /*
   * Export the SQLite database to a
   * Uint8Array.
   */
  const database =
    db.export();

  /*
   * Write the actual Dash database.
   */
  await fs.writeFile(
    indexPath,
    Buffer.from(
      database,
    ),
  );

  db.close();

  console.log(
    `  Written: ${indexPath}`,
  );
} catch (error) {
  console.error();

  console.error(
    "ERROR: Failed to create SQLite index.",
  );

  console.error();

  console.error(
    error,
  );

  process.exit(1);
}

console.log();

/*
 * ============================================================
 * CREATE INFO.PLIST
 * ============================================================
 *
 * This tells Dash that the bundle is a
 * Dash docset and provides its metadata.
 */

console.log(
  "=== CREATE INFO.PLIST ===",
);

const platformFamily =
  manifest.site.name
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-",
    );

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
  <string>${escapeXml(
  siteName,
)}</string>

<key>CFBundleIdentifier</key>
<string>${escapeXml(
  bundleIdentifier(
    manifest.site.name,
  ),
)}</string>

<key>CFBundleName</key>
<string>${escapeXml(
  siteName,
)}</string>

<key>DocSetPlatformFamily</key>
<string>${escapeXml(
  platformFamily,
)}</string>

<key>isDashDocset</key>
<true/>

<key>isJavaScriptEnabled</key>
<true/>

<key>DashDocSetKeyword</key>
<string>${escapeXml(
  manifest.site.name,
)}</string>

<key>DashDocSetFallbackURL</key>
<string>${escapeXml(
  manifest.entry.path,
)}</string>

<key>dashIndexFilePath</key>
<string>${escapeXml(
  manifest.entry.path,
)}</string>
</dict>
</plist>
  `;

await fs.writeFile(
  infoPlistPath,
  infoPlist,
  "utf8",
);

console.log(
  `  Written: ${infoPlistPath}`,
);

console.log();

/*
 * ============================================================
 * PACKAGE METADATA
 * ============================================================
 *
 * This file isn't required by Dash.
 *
 * It is useful for debugging and lets us
 * trace which localized manifest produced
 * the docset.
 */

const packageMetadata = {
  version: 1,

  site:
    manifest.site,

  entry:
    manifest.entry,

  source:
    manifest.source,

  localizedAt:
    manifest.localizedAt,

  packagedAt:
    new Date().toISOString(),

  stats: {
    pages:
      pageIndexCount,

    headings:
      headingIndexCount,

    resources:
      manifest.stats.resources,

    indexEntries:
      indexEntries.length,
  },
};

await fs.writeFile(
  path.join(
    docsetDir,
    "package.json",
  ),
  JSON.stringify(
    packageMetadata,
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(
  "=== VERIFY DOCSET ===",
);

/*
 * ============================================================
 * VERIFY GENERATED FILES
 * ============================================================
 */

const requiredFiles = [
  infoPlistPath,
  indexPath,
  path.join(
    documentsDir,
    manifest.entry.path,
  ),
];

for (
  const file of requiredFiles
) {
  try {
    const stat =
      await fs.stat(
        file,
      );

    if (
      !stat.isFile()
    ) {
      throw new Error(
        "Not a regular file",
      );
    }

    console.log(
      `  OK ${file}`,
    );
  } catch (error) {
    console.error(
      `  MISSING ${file}`,
    );

    console.error(
      `    ${error}`,
    );

    process.exit(1);
  }
}

/*
 * ============================================================
 * VERIFY SQLITE HEADER
 * ============================================================
 *
 * SQLite databases start with:
 *
 *   SQLite format 3\0
 *
 * Check that the exported database is
 * actually a SQLite file before declaring
 * the docset complete.
 */

const indexBuffer =
  await fs.readFile(
    indexPath,
  );

const sqliteHeader =
  indexBuffer
    .subarray(
      0,
      16,
    )
    .toString(
      "ascii",
    );

if (
  sqliteHeader !==
  "SQLite format 3\u0000"
) {
  console.error(
    "ERROR: docSet.dsidx is not a valid SQLite database.",
  );

  process.exit(1);
}

console.log(
  `  OK SQLite database (${indexBuffer.length} bytes)`,
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
  "DOCSET CREATED",
);

console.log(
  "================================",
);

console.log(
  `Name:       ${siteName}`,
);

console.log(
  `Pages:      ${pageIndexCount}`,
);

console.log(
  `Headings:   ${headingIndexCount}`,
);

console.log(
  `Resources:  ${manifest.stats.resources}`,
);

console.log(
  `Entries:    ${indexEntries.length}`,
);

console.log(
  `Entry:      ${manifest.entry.path}`,
);

console.log(
  `Docset:     ${path.resolve(
  docsetDir,
)}`,
);

console.log();
