import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalBookmarkUrl,
  parseXmlPlist,
  readChromiumBookmarks,
  readFirefoxBookmarks,
  readSafariBookmarks,
  syncBrowserBookmarks,
  type BrowserSource,
  type PlistValue,
} from "../src/browsers.ts";
import { openDatabase, type AtlasDatabase } from "../src/db.ts";
import { searchResources } from "../src/search.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "atlas-browsers-"));
}

function activeSaves(db: AtlasDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM saves WHERE unsaved_at IS NULL").get() as {
    c: number;
  };
  return Number(row.c);
}

function firstSource(result: { sources: Array<{ error?: string }> }): { error?: string } {
  const [source] = result.sources;
  assert.ok(source, "expected at least one source result");
  return source;
}

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------

// 13344473600000000 microseconds after 1601-01-01 is 1700000000 seconds after
// 1970-01-01, so this is a fixed, checkable reference point rather than a value
// computed with the same formula the reader uses.
const CHROMIUM_FIXTURE = {
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        {
          type: "url",
          id: "1",
          guid: "guid-atlas",
          name: "Atlas",
          url: "https://example.com/atlas?utm_source=news&page=2",
          date_added: "13344473600000000",
        },
        {
          type: "folder",
          name: "Dev",
          children: [
            {
              type: "url",
              id: "2",
              guid: "guid-docs",
              name: "Docs",
              url: "https://example.com/docs#install",
            },
          ],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other bookmarks",
      children: [
        { type: "url", id: "3", guid: "guid-local", name: "Local", url: "file:///tmp/notes.md" },
      ],
    },
  },
};

test("readChromiumBookmarks walks every root and builds folder paths", () => {
  const dir = workspace();
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, JSON.stringify(CHROMIUM_FIXTURE));
    const bookmarks = readChromiumBookmarks(file);

    assert.equal(bookmarks.length, 3);
    const atlas = bookmarks.find((bookmark) => bookmark.externalId === "guid-atlas");
    assert.ok(atlas);
    assert.deepEqual(atlas.folderPath, ["Bookmarks bar"]);
    assert.equal(atlas.addedAt, "2023-11-14T22:13:20.000Z");

    const docs = bookmarks.find((bookmark) => bookmark.externalId === "guid-docs");
    assert.ok(docs);
    assert.deepEqual(docs.folderPath, ["Bookmarks bar", "Dev"]);
    assert.equal(docs.addedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readChromiumBookmarks rejects a file that is not a bookmarks document", () => {
  const dir = workspace();
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, "{ not json");
    assert.throws(() => readChromiumBookmarks(file), /Unable to read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// URL canonicalisation
// ---------------------------------------------------------------------------

test("canonicalBookmarkUrl strips tracking parameters and keeps the fragment", () => {
  assert.equal(
    canonicalBookmarkUrl("https://example.com/atlas?utm_source=news&page=2"),
    "https://example.com/atlas?page=2",
  );
  assert.equal(
    canonicalBookmarkUrl("https://Example.COM/docs#install"),
    "https://example.com/docs#install",
  );
  // Not a URL we can parse: passed through rather than dropped.
  assert.equal(canonicalBookmarkUrl("not a url"), "not a url");
});

test("the same page bookmarked twice canonicalises to one key", () => {
  assert.equal(
    canonicalBookmarkUrl("https://example.com/x?fbclid=abc"),
    canonicalBookmarkUrl("https://example.com/x"),
  );
});

// ---------------------------------------------------------------------------
// Safari plist
// ---------------------------------------------------------------------------

const SAFARI_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Children</key>
  <array>
    <dict>
      <key>Title</key><string>BookmarksBar</string>
      <key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key>
      <array>
        <dict>
          <key>URLString</key><string>https://example.com/a&amp;b</string>
          <key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>
          <key>WebBookmarkUUID</key><string>SAFARI-1</string>
          <key>URIDictionary</key>
          <dict><key>title</key><string>Docs &amp; more</string></dict>
          <key>previewText</key><string>A captured preview</string>
        </dict>
        <dict>
          <key>Title</key><string>Deep</string>
          <key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
          <key>Children</key>
          <array>
            <dict>
              <key>URLString</key><string>https://example.com/nested</string>
              <key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>
              <key>URIDictionary</key><dict><key>title</key><string>Nested</string></dict>
            </dict>
          </array>
        </dict>
      </array>
    </dict>
    <dict>
      <key>Title</key><string>History</string>
      <key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key>
      <array>
        <dict>
          <key>URLString</key><string>https://example.com/browsing-history</string>
          <key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>
          <key>URIDictionary</key><dict><key>title</key><string>History entry</string></dict>
        </dict>
      </array>
    </dict>
  </array>
</dict>
</plist>`;

test("parseXmlPlist reads every element type a plist uses", () => {
  const parsed = parseXmlPlist(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>str</key><string>plain &amp; entity</string>
  <key>int</key><integer>42</integer>
  <key>real</key><real>1.5</real>
  <key>yes</key><true/>
  <key>no</key><false/>
  <key>data</key><data>aGVsbG8=</data>
  <key>date</key><date>2026-01-15T00:00:00Z</date>
  <key>list</key><array><string>a</string><integer>2</integer></array>
  <key>nested</key><dict><key>inner</key><string>deep</string></dict>
  <key>empty</key><string></string>
</dict>
</plist>`);

  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  const record = parsed as Record<string, PlistValue>;
  assert.equal(record.str, "plain & entity");
  assert.equal(record.int, 42);
  assert.equal(record.real, 1.5);
  assert.equal(record.yes, true);
  assert.equal(record.no, false);
  assert.equal(record.data, "aGVsbG8=");
  assert.equal(record.date, "2026-01-15T00:00:00Z");
  assert.deepEqual(record.list, ["a", 2]);
  assert.deepEqual(record.nested, { inner: "deep" });
  assert.equal(record.empty, "");
});

test(
  "readSafariBookmarks labels its folders, keeps previewText and drops History",
  { skip: process.platform !== "darwin" ? "plutil is macOS only" : false },
  () => {
    const dir = workspace();
    try {
      const file = join(dir, "Bookmarks.plist");
      writeFileSync(file, SAFARI_FIXTURE);
      const bookmarks = readSafariBookmarks(file);

      const urls = bookmarks.map((bookmark) => bookmark.url);
      assert.deepEqual(urls.sort(), [
        "https://example.com/a&b",
        "https://example.com/nested",
      ]);

      const main = bookmarks.find((bookmark) => bookmark.externalId === "SAFARI-1");
      assert.ok(main);
      assert.equal(main.title, "Docs & more");
      assert.equal(main.description, "A captured preview");
      assert.deepEqual(main.folderPath, ["Bookmarks bar"]);

      const nested = bookmarks.find((bookmark) => bookmark.title === "Nested");
      assert.ok(nested);
      assert.deepEqual(nested.folderPath, ["Bookmarks bar", "Deep"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

function writeFirefoxFixture(dir: string): string {
  const file = join(dir, "places.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (
        id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER,
        position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT
      );
      INSERT INTO moz_places (id, url) VALUES
        (1, 'https://example.com/rust'),
        (2, 'https://example.com/tools'),
        (3, 'place:type=6&sort=14');
      -- Firefox creates its roots as ids 1-4 with no titles, so a realistic
      -- fixture keeps user folders above them rather than reusing an id.
      INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES
        (1, 2, NULL, 0, 0, NULL,       0, 'root'),
        (2, 2, NULL, 1, 0, NULL,       0, 'menu'),
        (3, 2, NULL, 1, 1, NULL,       0, 'toolbar'),
        (7, 2, NULL, 2, 0, 'Rust',     0, 'folder-a'),
        (8, 1, 1,    7, 0, 'The Book', 1700000000000000, 'ff-a'),
        (9, 1, 2,    7, 1, 'Tools',    1700000000000000, 'ff-b'),
        (10, 1, 3,   3, 0, 'In toolbar', 1700000000000000, 'ff-c');
    `);
  } finally {
    db.close();
  }
  return file;
}

test("readFirefoxBookmarks resolves folder paths from parent ids", () => {
  const dir = workspace();
  try {
    const bookmarks = readFirefoxBookmarks(writeFirefoxFixture(dir));
    assert.equal(bookmarks.length, 3);

    const book = bookmarks.find((bookmark) => bookmark.externalId === "ff-a");
    assert.ok(book);
    assert.equal(book.title, "The Book");
    assert.deepEqual(book.folderPath, ["Bookmarks menu", "Rust"]);
    assert.equal(book.addedAt, "2023-11-14T22:13:20.000Z");

    // A bookmark sitting directly in a built-in root gets that root's name.
    const inToolbar = bookmarks.find((bookmark) => bookmark.externalId === "ff-c");
    assert.ok(inToolbar);
    assert.deepEqual(inToolbar.folderPath, ["Bookmarks toolbar"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function chromiumSource(file: string): BrowserSource {
  return { provider: "chrome", kind: "chromium", profile: "Default", path: file };
}

test("syncBrowserBookmarks imports http bookmarks, skips the rest, then only updates", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, JSON.stringify(CHROMIUM_FIXTURE));
    const sources = [chromiumSource(file)];

    const first = syncBrowserBookmarks(db, { sources });
    assert.equal(first.imported, 2, "the file:// bookmark is not a resource");
    assert.equal(first.skipped, 1);
    assert.equal(first.updated, 0);

    const second = syncBrowserBookmarks(db, { sources });
    assert.equal(second.imported, 0);
    assert.equal(second.updated, 2);
    assert.equal(activeSaves(db), 2);

    // The tracking parameter was stripped, so this is the stored key.
    const row = db
      .prepare("SELECT canonical_url AS url FROM resources ORDER BY id LIMIT 1")
      .get() as { url: string };
    assert.equal(row.url, "https://example.com/atlas?page=2");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bookmark removed from the browser is marked removed, not deleted", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, JSON.stringify(CHROMIUM_FIXTURE));
    const sources = [chromiumSource(file)];
    syncBrowserBookmarks(db, { sources });
    assert.equal(activeSaves(db), 2);

    const trimmed = structuredClone(CHROMIUM_FIXTURE);
    trimmed.roots.bookmark_bar.children.pop();
    writeFileSync(file, JSON.stringify(trimmed));

    const result = syncBrowserBookmarks(db, { sources });
    assert.equal(result.removed, 1);
    assert.equal(activeSaves(db), 1);
    // The row survives so `prune` stays an explicit, reversible step.
    const total = db.prepare("SELECT COUNT(*) AS c FROM saves").get() as { c: number };
    assert.equal(Number(total.c), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source that cannot be read does not mark its bookmarks removed", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, JSON.stringify(CHROMIUM_FIXTURE));
    syncBrowserBookmarks(db, { sources: [chromiumSource(file)] });
    assert.equal(activeSaves(db), 2);

    // Same integration, unreadable file — this is the Safari-without-Full-Disk-
    // Access case, where reconciling would wipe the collection.
    const broken = syncBrowserBookmarks(db, { sources: [chromiumSource(join(dir, "missing"))] });
    assert.ok(firstSource(broken).error, "the failure is reported, not thrown");
    assert.equal(broken.removed, 0);
    assert.equal(activeSaves(db), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a limited sync does not treat unseen bookmarks as deleted", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const file = join(dir, "Bookmarks");
    writeFileSync(file, JSON.stringify(CHROMIUM_FIXTURE));
    const sources = [chromiumSource(file)];
    syncBrowserBookmarks(db, { sources });

    const limited = syncBrowserBookmarks(db, { sources, limit: 1 });
    assert.equal(limited.imported, 0);
    assert.equal(limited.removed, 0, "the bookmark we did not read is not a bookmark that went away");
    assert.equal(activeSaves(db), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser bookmark and a starred repository share one resource", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    // A GitHub star already owns this URL; the bookmark must attach to it rather
    // than creating a second resource for the same page.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO resources (canonical_url, resource_type, title, created_at, updated_at)
      VALUES ('https://github.com/example/atlas', 'github_repository', 'example/atlas', ?, ?)
    `).run(now, now);

    const file = join(dir, "Bookmarks");
    writeFileSync(
      file,
      JSON.stringify({
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            children: [
              {
                type: "url",
                guid: "shared",
                name: "Atlas on GitHub",
                url: "https://github.com/example/atlas",
              },
            ],
          },
        },
      }),
    );

    const result = syncBrowserBookmarks(db, { sources: [chromiumSource(file)] });
    assert.equal(result.imported, 1);
    const resources = db.prepare("SELECT COUNT(*) AS c FROM resources").get() as { c: number };
    assert.equal(Number(resources.c), 1, "one page is one resource, however it was saved");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Choosing which browsers to import from
// ---------------------------------------------------------------------------

/** Two browsers with one bookmark each, so a selection has something to hide. */
function twoBrowsers(dir: string): BrowserSource[] {
  const write = (name: string, guid: string, title: string, url: string): string => {
    const file = join(dir, name);
    writeFileSync(
      file,
      JSON.stringify({
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            children: [{ type: "url", guid, name: title, url }],
          },
        },
      }),
    );
    return file;
  };
  return [
    {
      provider: "chrome",
      kind: "chromium",
      profile: "Default",
      path: write("chrome.json", "c1", "Chrome page", "https://example.com/from-chrome"),
    },
    {
      provider: "brave",
      kind: "chromium",
      profile: "Default",
      path: write("brave.json", "b1", "Brave page", "https://example.com/from-brave"),
    },
  ];
}

test("only the enabled browsers are imported, and the rest are hidden", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const sources = twoBrowsers(dir);
    assert.equal(syncBrowserBookmarks(db, { sources, enabled: null }).imported, 2);
    assert.equal(searchResources(db, "from-brave", 10).length, 1);

    const narrowed = syncBrowserBookmarks(db, { sources, enabled: ["chrome"] });
    assert.equal(narrowed.imported, 0);
    assert.equal(narrowed.updated, 1, "chrome still syncs");
    assert.equal(narrowed.removed, 1, "brave is switched off");
    assert.deepEqual(narrowed.excluded, [{ provider: "brave", removed: 1 }]);
    assert.equal(activeSaves(db), 1);

    // The point of the whole feature: a browser switched off leaves search.
    assert.equal(searchResources(db, "from-brave", 10).length, 0);
    assert.equal(searchResources(db, "from-chrome", 10).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching a browser back on brings its bookmarks back", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const sources = twoBrowsers(dir);
    syncBrowserBookmarks(db, { sources, enabled: null });
    syncBrowserBookmarks(db, { sources, enabled: ["chrome"] });
    assert.equal(activeSaves(db), 1);

    syncBrowserBookmarks(db, { sources, enabled: null });
    assert.equal(activeSaves(db), 2, "the rows were hidden, never deleted");
    assert.equal(searchResources(db, "from-brave", 10).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching every browser off hides everything without deleting it", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const sources = twoBrowsers(dir);
    syncBrowserBookmarks(db, { sources, enabled: null });

    const none = syncBrowserBookmarks(db, { sources, enabled: [] });
    assert.equal(none.removed, 2);
    assert.equal(activeSaves(db), 0);
    assert.equal(searchResources(db, "from-chrome", 10).length, 0);

    // An empty selection is not the same as the default: it is a real choice.
    const total = db.prepare("SELECT COUNT(*) AS c FROM saves").get() as { c: number };
    assert.equal(Number(total.c), 2, "prune is what deletes, and it stays a separate step");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run scoped to one browser says nothing about the others", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const sources = twoBrowsers(dir);
    syncBrowserBookmarks(db, { sources, enabled: null });

    // --browser chrome is a question about chrome, not a statement that brave
    // should be switched off, so nothing may be hidden by it.
    const scoped = syncBrowserBookmarks(db, { sources, enabled: ["chrome"], provider: "chrome" });
    assert.equal(scoped.removed, 0);
    assert.deepEqual(scoped.excluded, []);
    assert.equal(activeSaves(db), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default selection hides nothing", () => {
  const dir = workspace();
  const db = openDatabase(":memory:");
  try {
    const sources = twoBrowsers(dir);
    syncBrowserBookmarks(db, { sources, enabled: null });
    const again = syncBrowserBookmarks(db, { sources, enabled: null });
    assert.equal(again.removed, 0);
    assert.deepEqual(again.excluded, []);
    assert.equal(activeSaves(db), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
