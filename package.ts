import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

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
 * Convert a filesystem path into
 * a path relative to Documents.
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
 *     id: "select"
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
 * Remove HTML tags and decode the most
 * common HTML entities.
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
 * Create a reasonable Dash type for a page.
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
 * Create a reasonable Dash type for a heading.
 */
function headingType(
  level: number,
): string {
  switch (level) {
    case 1:
      return "Guide";

    case 2:
      return "Section";

    case 3:
      return "Section";

    default:
      return "Section";
  }
}

/**
 * Convert the site's name into a useful
 * Dash display name.
 *
 * "drizzle" -> "Drizzle"
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

console.log("=== PACKAGE DOCSET ===");
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
 * Always create a fresh docset so stale
 * files cannot survive between builds.
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
 * Copy everything except manifest.json.
 *
 * This gives Dash:
 *
 * Contents/
 *   Resources/
 *     Documents/
 *       pages/
 *       resources/
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
  /*
   * The manifest is packaging metadata,
   * not part of the website.
   */
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
 * CREATE SQLITE INDEX
 * ============================================================
 */

console.log(
  "=== CREATE INDEX ===",
);

let pageIndexCount = 0;
let headingIndexCount = 0;

try {
  console.log(
    `  Database: ${indexPath}`,
  );

  const db =
    new Database(
      indexPath,
    );

  console.log(
    "  SQLite database opened",
  );

  db.exec(`
    CREATE TABLE searchIndex (
      id INTEGER PRIMARY KEY,
      name TEXT,
      type TEXT,
      path TEXT
    );
  `);

  console.log(
    "  searchIndex table created",
  );

  db.exec(`
    CREATE UNIQUE INDEX anchor
      ON searchIndex (name, type, path);
  `);

  console.log(
    "  searchIndex index created",
  );

  const insert =
    db.prepare(`
      INSERT OR IGNORE INTO searchIndex
        (name, type, path)
      VALUES
        (?, ?, ?)
    `);

  const insertMany =
    db.transaction(
      (
        entries: Array<{
          name: string;
          type: string;
          path: string;
        }>,
      ) => {
        for (
          const entry of entries
          ) {
          insert.run(
            entry.name,
            entry.type,
            entry.path,
          );
        }
      },
    );

  const indexEntries: Array<{
    name: string;
    type: string;
    path: string;
  }> = [];

  /*
   * ----------------------------------------------------------
   * INDEX PAGES
   * ----------------------------------------------------------
   */

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
     * Page title.
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
     * Headings.
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
    `  Pages found:       ${pageIndexCount}`,
  );

  console.log(
    `  Headings found:    ${headingIndexCount}`,
  );

  console.log(
    `  Entries to insert: ${indexEntries.length}`,
  );

  insertMany(
    indexEntries,
  );

  console.log(
    "  Entries inserted",
  );

  const row =
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM searchIndex",
      )
      .get() as {
      count: number;
    };

  console.log(
    `  SQLite rows:       ${row.count}`,
  );

  db.close();

  console.log(
    "  SQLite database closed",
  );
} catch (error) {
  console.error();
  console.error(
    "ERROR: Failed to create Dash SQLite index.",
  );
  console.error();

  console.error(error);

  process.exit(1);
}

console.log();

/*
 * ============================================================
 * CREATE INFO.PLIST
 * ============================================================
 *
 * This is the metadata Dash uses to identify
 * the bundle as a docset.
 */

console.log(
  "=== CREATE INFO.PLIST ===",
);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
  <string>${escapeXml(siteName)}</string>

<key>CFBundleIdentifier</key>
<string>${escapeXml(
  bundleIdentifier(
    manifest.site.name,
  ),
)}</string>

<key>CFBundleName</key>
<string>${escapeXml(siteName)}</string>

<key>DocSetPlatformFamily</key>
<string>${escapeXml(
  manifest.site.name
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-",
    ),
)}</string>

<key>isDashDocset</key>
<true/>

<key>isJavaScriptEnabled</key>
<true/>

<key>DashDocSetFamily</key>
<string>dashtoc</string>

<key>DashDocSetKeyword</key>
<string>${escapeXml(
  manifest.site.name,
)}</string>

<key>DashDocSetFallbackURL</key>
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
  `  ${infoPlistPath}`,
);

console.log();

/*
 * ============================================================
 * WRITE PACKAGE METADATA
 * ============================================================
 *
 * This is not required by Dash, but is useful
 * for inspecting the generated package later.
 */

const packageMetadata = {
  version: 1,

  site: manifest.site,

  entry: manifest.entry,

  source: manifest.source,

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

/*
 * ============================================================
 * DONE
 * ============================================================
 */

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
  `Entry:      ${manifest.entry.path}`,
);

console.log(
  `Docset:     ${path.resolve(
  docsetDir,
)}`,
);

console.log();
