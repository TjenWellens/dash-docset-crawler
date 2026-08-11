import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type ManifestPage = {
  path: string;
  status: "queued" | "downloaded" | "failed" | string;
  scrapedAt?: string;
  contentType?: string;
};

type ManifestResource = {
  path: string;
  status: "queued" | "downloaded" | "failed" | string;
  contentType?: string;
  scrapedAt?: string;
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
    startedAt?: string;
    lastUpdatedAt?: string;
    completedAt?: string | null;
    complete: boolean;
  };

  pages: Record<string, ManifestPage>;
  resources: Record<string, ManifestResource>;
};

type SearchIndexEntry = {
  name: string;
  type: string;
  path: string;
};

const siteName = process.argv[2] ?? "drizzle";

const docsDir = path.resolve("docs", siteName);
const rawDir = path.join(docsDir, "raw");
const manifestPath = path.join(rawDir, "manifest.json");

const docsetDir = path.join(docsDir, `${siteName}.docset`);
const contentsDir = path.join(docsetDir, "Contents");
const resourcesDir = path.join(contentsDir, "Resources");

const pagesDir = path.join(resourcesDir, "pages");
const siteResourcesDir = path.join(resourcesDir, "resources");

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Manifest not found: ${manifestPath}`);
}

const manifest: Manifest = JSON.parse(
  fs.readFileSync(manifestPath, "utf8"),
);

console.log(`Packaging ${manifest.site.name}`);
console.log(`Manifest: ${manifestPath}`);

if (!manifest.scrape.complete) {
  const queued = Object.values(manifest.pages).filter(
    (page) => page.status === "queued",
  ).length;

  console.warn("");
  console.warn("WARNING: crawl is incomplete.");
  console.warn(`Queued pages: ${queued}`);
  console.warn("");
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir: string) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
  });
}

function copyFileFromRaw(relativePath: string, destinationRoot: string) {
  const source = path.join(rawDir, relativePath);
  const destination = path.join(destinationRoot, relativePath);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing crawled file: ${source}`);
  }

  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (!match) {
    return null;
  }

  return match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractH1(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  if (!match) {
    return null;
  }

  return match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPageName(
  url: string,
  relativePath: string,
  html: string,
): string {
  const h1 = extractH1(html);

  if (h1) {
    return h1;
  }

  const title = extractTitle(html);

  if (title) {
    return title
      .replace(/\s*[|–-]\s*Drizzle.*$/i, "")
      .trim();
  }

  const parsed = new URL(url);

  if (parsed.pathname === "/docs" || parsed.pathname === "/docs/") {
    return "Drizzle ORM";
  }

  const filename = path.basename(relativePath, ".html");

  return filename
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// -----------------------------------------------------------------------------
// 1. Recreate docset
// -----------------------------------------------------------------------------

console.log("Cleaning existing docset...");

removeDir(docsetDir);

ensureDir(resourcesDir);

// -----------------------------------------------------------------------------
// 2. Copy downloaded pages
// -----------------------------------------------------------------------------

console.log("Copying downloaded pages...");

const downloadedPages = Object.entries(manifest.pages).filter(
  ([, page]) => page.status === "downloaded",
);

const copiedPagePaths = new Set<string>();

for (const [url, page] of downloadedPages) {
  if (copiedPagePaths.has(page.path)) {
    continue;
  }

  copyFileFromRaw(page.path, resourcesDir);

  copiedPagePaths.add(page.path);

  console.log(`  page  ${url}`);
}

console.log(`Copied ${copiedPagePaths.size} pages.`);

// -----------------------------------------------------------------------------
// 3. Copy downloaded resources
// -----------------------------------------------------------------------------

console.log("Copying downloaded resources...");

const downloadedResources = Object.entries(manifest.resources).filter(
  ([, resource]) => resource.status === "downloaded",
);

const copiedResourcePaths = new Set<string>();

for (const [url, resource] of downloadedResources) {
  if (copiedResourcePaths.has(resource.path)) {
    continue;
  }

  copyFileFromRaw(resource.path, resourcesDir);

  copiedResourcePaths.add(resource.path);

  console.log(`  resource  ${url}`);
}

console.log(`Copied ${copiedResourcePaths.size} resources.`);

// -----------------------------------------------------------------------------
// 4. Generate Info.plist
// -----------------------------------------------------------------------------

console.log("Generating Info.plist...");

const displayName = manifest.site.name
  .split(/[-_]/g)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

const bundleIdentifier = manifest.site.name
  .toLowerCase()
  .replace(/[^a-z0-9.-]/g, "-");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
  <string>${escapeXml(bundleIdentifier)}</string>

<key>CFBundleName</key>
<string>${escapeXml(displayName)}</string>

<key>DocSetPlatformFamily</key>
<string>${escapeXml(bundleIdentifier)}</string>

<key>DashDocSetFamily</key>
<string>${escapeXml(bundleIdentifier)}</string>

<key>isDashDocset</key>
<true/>

<key>isJavaScriptEnabled</key>
<true/>
</dict>
</plist>
  `;

fs.writeFileSync(
  path.join(contentsDir, "Info.plist"),
  plist,
);

// -----------------------------------------------------------------------------
// 5. Build Dash search index
// -----------------------------------------------------------------------------

console.log("Building search index...");

const searchEntries: SearchIndexEntry[] = [];

const indexedPaths = new Set<string>();

for (const [url, page] of downloadedPages) {
  if (indexedPaths.has(page.path)) {
    continue;
  }

  const htmlPath = path.join(resourcesDir, page.path);

  if (!fs.existsSync(htmlPath)) {
    continue;
  }

  const html = fs.readFileSync(htmlPath, "utf8");

  const name = getPageName(url, page.path, html);

  searchEntries.push({
    name,
    type: "Guide",
    path: page.path,
  });

  indexedPaths.add(page.path);
}

// Make the main documentation page the first result.
searchEntries.sort((a, b) => {
  if (a.path.endsWith("/overview.html")) {
    return -1;
  }

  if (b.path.endsWith("/overview.html")) {
    return 1;
  }

  return a.name.localeCompare(b.name);
});

console.log(`Search entries: ${searchEntries.length}`);

// -----------------------------------------------------------------------------
// 6. Create docSet.dsidx
// -----------------------------------------------------------------------------

const dbPath = path.join(resourcesDir, "docSet.dsidx");

if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const createSql = `
CREATE TABLE searchIndex (
  id INTEGER PRIMARY KEY,
  name TEXT,
  type TEXT,
  path TEXT
);

CREATE UNIQUE INDEX anchor
ON searchIndex (name, type, path);
`;

execFileSync("sqlite3", [dbPath], {
  input: createSql,
  encoding: "utf8",
});

for (const entry of searchEntries) {
  const sql = `
INSERT INTO searchIndex (name, type, path)
VALUES (
  ${JSON.stringify(entry.name)},
${JSON.stringify(entry.type)},
${JSON.stringify(entry.path)}
);
`;

  execFileSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });
}

// -----------------------------------------------------------------------------
// 7. Generate optimizedIndex.dsidx
// -----------------------------------------------------------------------------

console.log("Generating optimizedIndex.dsidx...");

const optimizedDbPath = path.join(
  resourcesDir,
  "optimizedIndex.dsidx",
);

if (fs.existsSync(optimizedDbPath)) {
  fs.unlinkSync(optimizedDbPath);
}

execFileSync("sqlite3", [optimizedDbPath], {
  input: `
CREATE TABLE searchIndex (
  id INTEGER PRIMARY KEY,
  name TEXT,
  type TEXT,
  path TEXT
);

CREATE UNIQUE INDEX anchor
ON searchIndex (name, type, path);
`,
  encoding: "utf8",
});

for (const entry of searchEntries) {
  const sql = `
INSERT INTO searchIndex (name, type, path)
VALUES (
  ${JSON.stringify(entry.name)},
${JSON.stringify(entry.type)},
${JSON.stringify(entry.path)}
);
`;

  execFileSync("sqlite3", [optimizedDbPath], {
    input: sql,
    encoding: "utf8",
  });
}

// -----------------------------------------------------------------------------
// 8. Summary
// -----------------------------------------------------------------------------

console.log("");
console.log("Docset created successfully.");
console.log("");
console.log(`  Site:       ${manifest.site.name}`);
console.log(`  Pages:      ${copiedPagePaths.size}`);
console.log(`  Resources:  ${copiedResourcePaths.size}`);
console.log(`  Index:      ${searchEntries.length}`);
console.log(`  Output:     ${docsetDir}`);
console.log("");
console.log(`Open with:`);
console.log(`  open "${docsetDir}"`);
