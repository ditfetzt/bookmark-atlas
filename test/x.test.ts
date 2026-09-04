import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.ts";
import { importXJson } from "../src/x.ts";

const nativeTweet = {
  rest_id: "1234567890",
  legacy: {
    full_text: "Useful local-first agent memory https://t.co/example",
    created_at: "Wed Sep 03 12:00:00 +0000 2026",
    conversation_id_str: "1234567890",
    lang: "en",
    entities: {
      urls: [{ url: "https://t.co/example", expanded_url: "https://example.com/article" }],
    },
  },
  core: {
    user_results: {
      result: { rest_id: "42", legacy: { screen_name: "builder", name: "Builder" } },
    },
  },
};

test("imports a Siftly native capture idempotently and indexes expanded URLs", () => {
  const db = openDatabase(":memory:");
  const input = { bookmarks: [nativeTweet], source: "bookmark" };

  const first = importXJson(db, input);
  const second = importXJson(db, input);

  assert.deepEqual(first, {
    format: "siftly-native",
    total: 1,
    imported: 1,
    updated: 0,
    skipped: 0,
    missingSavedAt: 1,
  });
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM x_posts").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM resources_fts WHERE resources_fts MATCH 'local' ").get() as { count: number }).count, 1);
  assert.match((db.prepare("SELECT normalized_content AS content FROM captures").get() as { content: string }).content, /example\.com\/article/);
  assert.equal((db.prepare("SELECT language FROM resources").get() as { language: string }).language, "en");
  assert.equal((db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { status: string }).status, "completed");
  db.close();
});

test("imports a normalized Siftly export with its import timestamp", () => {
  const db = openDatabase(":memory:");
  const result = importXJson(db, [{
    tweetId: "99",
    text: "Agent orchestration notes",
    authorHandle: "max",
    authorName: "Max",
    tweetCreatedAt: "2026-08-01T00:00:00Z",
    importedAt: "2026-09-01T00:00:00Z",
    mediaItems: [],
  }]);

  assert.equal(result.format, "siftly-export");
  assert.equal(result.missingSavedAt, 0);
  assert.equal((db.prepare("SELECT saved_at AS savedAt FROM saves").get() as { savedAt: string }).savedAt, "2026-09-01T00:00:00.000Z");
  db.close();
});

test("imports an X API v2 page and resolves included author data", () => {
  const db = openDatabase(":memory:");
  const result = importXJson(db, {
    data: [{ id: "77", text: "SQLite retrieval", author_id: "7", created_at: "2026-09-02T00:00:00Z" }],
    includes: { users: [{ id: "7", username: "sqlitefan", name: "SQLite Fan" }] },
  });

  assert.equal(result.format, "x-api-v2");
  assert.equal((db.prepare("SELECT author_handle AS handle FROM x_posts").get() as { handle: string }).handle, "sqlitefan");
  db.close();
});

test("skips malformed entries without discarding valid bookmarks", () => {
  const db = openDatabase(":memory:");
  const result = importXJson(db, { bookmarks: [{ nope: true }, nativeTweet] });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  db.close();
});

test("rejects unsupported JSON shapes", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => importXJson(db, { tweets: [] }), /Unsupported X bookmark JSON/);
  db.close();
});
