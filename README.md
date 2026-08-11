
(1) crawl raw pages
```shell
MAX_PAGES=5 npx tsx crawl.ts \
  https://orm.drizzle.team/docs/ \
  docs/drizzle/raw
```
(2) localize for offline use
```shell
npx tsx localize.ts \
  docs/drizzle/raw \
  docs/drizzle/local
```

inspect
```shell
open docs/drizzle/local/pages/orm.drizzle.team/docs/overview.html
```

(3) package into docset

## run the crawler (including url localizer)
run the crawler
```shell
rm -rf test-drizzle

MAX_PAGES=10 npx tsx crawl.ts \
  https://orm.drizzle.team/docs/ \
  ./test-drizzle
```

open crawled page in browser
```shell
open test-drizzle/orm.drizzle.team/docs/overview.html
```

## create docset from local html
copy crawled pages into docset folder structure
```shell
rm -rf test-drizzle.docset

mkdir -p test-drizzle.docset/Contents/Resources

cp -R test-drizzle/. \
  test-drizzle.docset/Contents/Resources/Documents
```

create plist
```shell
cat > test-drizzle.docset/Contents/Info.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd"\>
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>drizzle</string>

    <key>CFBundleName</key>
    <string>Drizzle ORM</string>

    <key>DocSetPlatformFamily</key>
    <string>drizzle</string>

    <key>DashDocSetFamily</key>
    <string>drizzle</string>

    <key>isDashDocset</key>
    <true/>

    <key>isJavaScriptEnabled</key>
    <true/>
</dict>
</plist>
EOF
```

populate db 
- [ ] todo: add more searchIndex
```shell
sqlite3 test-drizzle.docset/Contents/Resources/docSet.dsidx <<'SQL'                          
CREATE TABLE searchIndex (                 
    id INTEGER PRIMARY KEY,
    name TEXT,
    type TEXT,
    path TEXT
);

CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);

INSERT INTO searchIndex (name, type, path)
VALUES (
    'Drizzle ORM',
    'Guide',
    'orm.drizzle.team/docs/overview.html'
);
SQL
```

(optional) see in db current searchIndex
```shell
sqlite3 test-drizzle.docset/Contents/Resources/docSet.dsidx \
  'SELECT * FROM searchIndex;'
```

open in dash
```shell
open test-drizzle.docset
```
