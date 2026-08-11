
## (1) crawl raw pages
```shell
MAX_PAGES=5 npx tsx crawl.ts \
  https://orm.drizzle.team/docs/ \
  docs/drizzle/raw
```
## (2) localize for offline use
```shell
npx tsx localize.ts \
  docs/drizzle/raw \
  docs/drizzle/local
```

inspect
```shell
open docs/drizzle/local/pages/orm.drizzle.team/docs/overview.html
```

## (3) package into docset
```shell
npx tsx package.ts drizzle
```
