# Dash Docset Crawler
Creates a docset from a webpage by crawling all child pages.

## (1) crawl raw pages

run crawler

- can run multiple times to fetch the next x pages (aka resume crawling)

```shell
MAX_PAGES=5 npx tsx crawl.ts \
  https://orm.drizzle.team/docs/ \
  docs/drizzle/raw
```

## (2) localize for offline use

run localizer
- make pages and assets refer to local files
- use relative paths (`/assets/foo.css` -> `../../assets/foo.css`)

```shell
npx tsx localize.ts \
  docs/drizzle/raw \
  docs/drizzle/local
```

(optional) inspect local website

```shell
open docs/drizzle/local/pages/orm.drizzle.team/docs/overview.html
```

## (3) package into docset

build the docset

```shell
npx tsx package.ts \
  docs/drizzle/local \
  docs/drizzle/drizzle.docset
```

(optional) inspect searchIndex

```shell
sqlite3 docs/drizzle/drizzle.docset/Contents/Resources/docSet.dsidx \
  'SELECT * FROM searchIndex;'
```

open in dash

- opens automatically in dash if the foldername is `xxx.docset`

```shell
open docs/drizzle/drizzle.docset
```

# Known bugs
- open online page uses wrong url
- links to pages on the same domain, but not crawled, have broken links