import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.ts";
import { importXJson, retitleXArticles } from "../src/x.ts";

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
    removed: 0,
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

test("reconciles removed bookmarks only when a full collection is imported", () => {
  const db = openDatabase(":memory:");
  const post = (id: string) => ({
    tweet_id: id,
    text: `post ${id}`,
    author_username: "reconciler",
    created_at: "2026-08-01T00:00:00Z",
    added_at: "2026-09-01T00:00:00Z",
    raw_json: JSON.stringify({ rest_id: id }),
  });

  const first = importXJson(db, [post("1"), post("2")], { account: "x", reconcile: true });
  assert.equal(first.removed, 0);

  const second = importXJson(db, [post("1")], { account: "x", reconcile: true });
  assert.equal(second.removed, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM saves WHERE unsaved_at IS NULL").get() as { count: number }).count,
    1,
  );

  const partial = importXJson(db, [post("2")], { account: "x" });
  assert.equal(partial.removed, 0);
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

test("imports a TweetXVault JSON export", () => {
  const db = openDatabase(":memory:");
  const result = importXJson(db, [{
    tweet_id: "88",
    text: "Local bookmark archive",
    author_id: "8",
    author_username: "archiver",
    author_display_name: "Archive Builder",
    created_at: "2026-08-01T00:00:00Z",
    added_at: "2026-09-01T00:00:00Z",
    conversation_id: "88",
    urls: [{ expanded_url: "https://example.com/archive" }],
    raw_json: JSON.stringify({ rest_id: "88", legacy: { full_text: "Local bookmark archive" } }),
  }]);

  assert.equal(result.format, "tweetxvault");
  assert.equal(result.imported, 1);
  assert.equal((db.prepare("SELECT author_handle AS handle FROM x_posts").get() as { handle: string }).handle, "archiver");
  assert.equal((db.prepare("SELECT saved_at AS savedAt FROM saves").get() as { savedAt: string }).savedAt, "2026-09-01T00:00:00.000Z");
  assert.match((db.prepare("SELECT outbound_urls AS urls FROM x_posts").get() as { urls: string }).urls, /example.com\/archive/);
  db.close();
});

test("persists media, article text, and link unfurls for a TweetXVault export", () => {
  const db = openDatabase(":memory:");
  const result = importXJson(
    db,
    [
      {
        tweet_id: "90",
        text: "See the writeup",
        author_username: "pipeline",
        created_at: "2026-08-01T00:00:00Z",
        added_at: "2026-09-01T00:00:00Z",
        article: {
          article_id: "a1",
          title: "Pipeline deep dive",
          summary_text: "How the media pipeline works",
          content_text: "Full article body about processing every bookmark",
        },
        media: [
          {
            media_key: "3_90",
            type: "photo",
            source: "article_media",
            position: 0,
            url: "https://pbs.twimg.com/media/x.jpg",
            download: {
              state: "done",
              local_path: "media/90/3_90.jpg",
              content_type: "image/jpeg",
              byte_size: 1234,
              sha256: "abc",
            },
          },
          {
            media_key: "13_90",
            type: "video",
            source: "tweet_media",
            position: 1,
            url: "https://video.twimg.com/x.mp4",
            download: { state: "pending", local_path: null, content_type: null },
          },
        ],
        urls: [
          {
            expanded_url: "https://example.com/guide",
            resolved: {
              canonical_url: "https://example.com/guide",
              title: "Guide",
              description: "A useful guide",
              site_name: "Example",
            },
          },
        ],
        raw_json: JSON.stringify({ rest_id: "90" }),
      },
    ],
    { tweetxvaultDir: "/tmp/tv" },
  );

  assert.equal(result.imported, 1);
  const media = (
    db.prepare("SELECT type, local_path AS path FROM x_media ORDER BY position").all() as Array<{
      type: string;
      path: string | null;
    }>
  ).map((row) => ({ type: row.type, path: row.path }));
  assert.deepEqual(media, [
    { type: "photo", path: "/tmp/tv/media/90/3_90.jpg" },
    { type: "video", path: null },
  ]);
  const kinds = db.prepare("SELECT kind FROM captures ORDER BY kind").all() as Array<{ kind: string }>;
  assert.deepEqual(kinds.map((row) => row.kind), ["x_article", "x_link", "x_post"]);
  assert.match(
    (db.prepare("SELECT normalized_content AS content FROM captures WHERE kind = 'x_link'").get() as { content: string }).content,
    /A useful guide/,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM resources_fts WHERE resources_fts MATCH 'pipeline'").get() as { count: number }).count,
    1,
  );
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

test("titles an article post with the article's own title", () => {
  const db = openDatabase(":memory:");
  importXJson(
    db,
    [
      {
        tweet_id: "91",
        text: "https://t.co/link",
        author_username: "pipeline",
        created_at: "2026-08-01T00:00:00Z",
        added_at: "2026-09-01T00:00:00Z",
        article: { article_id: "a1", title: "Pipeline deep dive", content_text: "Body text" },
      },
    ],
    { tweetxvaultDir: "/tmp/tv" },
  );
  assert.equal(
    (db.prepare("SELECT title FROM resources").get() as { title: string }).title,
    "Pipeline deep dive",
  );
  db.close();
});

test("retitles article bookmarks written before the rule existed", () => {
  const db = openDatabase(":memory:");
  importXJson(
    db,
    [
      {
        tweet_id: "92",
        text: "https://t.co/link",
        author_username: "pipeline",
        created_at: "2026-08-01T00:00:00Z",
        added_at: "2026-09-01T00:00:00Z",
        article: { article_id: "a2", title: "Pipeline deep dive", content_text: "Body text" },
        raw_json: JSON.stringify({
          article: { article_results: { result: { title: "Pipeline deep dive", content: "Body text" } } },
        }),
      },
    ],
    { tweetxvaultDir: "/tmp/tv" },
  );
  // Reproduce what the old rule wrote, then repair it out of the stored payload.
  db.prepare("UPDATE resources SET title = 'X post: https://t.co/link'").run();

  assert.deepEqual(retitleXArticles(db), { scanned: 1, retitled: 1 });
  assert.equal(
    (db.prepare("SELECT title FROM resources").get() as { title: string }).title,
    "Pipeline deep dive",
  );
  // The search index has to follow, or the row keeps ranking under its old title.
  assert.equal(
    (db.prepare("SELECT title FROM resources_fts").get() as { title: string }).title,
    "Pipeline deep dive",
  );
  db.close();
});

test("leaves posts without an article alone", () => {
  const db = openDatabase(":memory:");
  importXJson(db, { bookmarks: [nativeTweet] });
  assert.deepEqual(retitleXArticles(db), { scanned: 0, retitled: 0 });
  assert.match(
    (db.prepare("SELECT title FROM resources").get() as { title: string }).title,
    /local-first agent memory/,
  );
  db.close();
});
