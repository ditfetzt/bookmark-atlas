import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openDatabase } from "../src/db.ts";
import {
  chunkMarkdown,
  decodeEntities,
  enrichGitHubReadmes,
  enrichWebPages,
  extractPage,
  pageImageUrl,
  readmeImageUrl,
} from "../src/enrich.ts";

// Preview images are written next to the database, so point that somewhere
// disposable before anything asks for it. Each test file has its own process.
const dataDir = mkdtempSync(join(tmpdir(), "atlas-enrich-"));
process.env.BOOKMARK_ATLAS_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

function seedRepository(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'github', 'test', '2026-01-01', '2026-01-01');
    INSERT INTO resources (
      id, canonical_url, resource_type, title, author, description,
      language, created_at, updated_at
    ) VALUES (
      1, 'https://github.com/example/atlas', 'github_repository',
      'example/atlas', 'example', 'Bookmark search', 'TypeScript',
      '2026-01-01', '2026-01-01'
    );
    INSERT INTO saves (
      integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at
    ) VALUES (1, 'R_1', 1, '2026-01-01', '2026-01-01', '2026-01-01');
    INSERT INTO github_repositories (
      resource_id, github_id, node_id, owner, name, full_name, topics
    ) VALUES (1, 1, 'R_1', 'example', 'atlas', 'example/atlas', '["bookmarks"]');
  `);
  return db;
}

test("chunks markdown deterministically", () => {
  const chunks = chunkMarkdown("# One\n\nFirst paragraph.\n\n## Two\n\nSecond paragraph.", 30);
  assert.deepEqual(chunks, ["# One\n\nFirst paragraph.", "## Two\n\nSecond paragraph."]);
});

test("stores README captures, chunks, ETag, and FTS content", async () => {
  const db = seedRepository();
  const mockFetch: typeof fetch = async () =>
    new Response("# Atlas\n\nA local-first knowledge base for coding agents.", {
      status: 200,
      headers: { etag: '"readme-1"', "content-type": "text/plain" },
    });

  const result = await enrichGitHubReadmes(db, {
    limit: 1,
    concurrency: 1,
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(result.enriched, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare("SELECT etag FROM resource_fetch_state").get() as { etag: string }).etag,
    '"readme-1"',
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM resources_fts WHERE resources_fts MATCH 'knowledge'").get() as { count: number }).count,
    1,
  );
  db.close();
});

test("handles an unchanged README without creating another capture", async () => {
  const db = seedRepository();
  let calls = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response("# Atlas", { status: 200, headers: { etag: '"readme-1"' } });
    }
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"readme-1"');
    return new Response(null, { status: 304 });
  };

  await enrichGitHubReadmes(db, { limit: 1, token: "test-token", fetchImpl: mockFetch });
  const result = await enrichGitHubReadmes(db, {
    limit: 1,
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(result.unchanged, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count,
    1,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

// Long enough to clear MIN_USEFUL_CHARS, which is what keeps a JavaScript shell
// or a consent wall out of the index.
const PAGE_BODY = `Included in the Creators Suite and built for teams that ship quickly, this
paragraph exists to carry enough readable text past the usefulness check, because a page
that yields only a sentence or two is almost always a shell that builds itself in
JavaScript rather than something worth indexing.`;

const PAGE_HTML = `<!doctype html><html><head>
<title>Tenzen &mdash; Studio</title>
<meta name="description" content="An editor and a motion tool.">
<script>console.log("should never be indexed");</script>
<style>.a { color: red; }</style>
</head><body>
<!-- a comment that is not text -->
<h1>Tenzen Studio</h1>
<p>${PAGE_BODY}</p>
</body></html>`;

function seedPages(count = 1): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'brave', 'Default', '2026-01-01', '2026-01-01');
  `);
  for (let index = 1; index <= count; index += 1) {
    db.prepare(`
      INSERT INTO resources (id, canonical_url, resource_type, title, created_at, updated_at)
      VALUES (?, ?, 'web_page', ?, '2026-01-01', '2026-01-01')
    `).run(index, `https://example.com/${index}`, `Page ${index}`);
    db.prepare(`
      INSERT INTO saves (
        integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at
      ) VALUES (1, ?, ?, '2026-01-01', '2026-01-01', '2026-01-01')
    `).run(`page-${index}`, index);
  }
  return db;
}

function htmlResponse(body: string, etag?: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(etag ? { etag } : {}),
    },
  });
}

test("extractPage keeps the readable text and drops the rest", () => {
  const page = extractPage(PAGE_HTML);
  assert.equal(page.title, "Tenzen — Studio");
  assert.equal(page.description, "An editor and a motion tool.");
  assert.match(page.text, /Creators Suite/);
  assert.ok(
    !/should never be indexed|color: red|a comment that is not text/.test(page.text),
    "script, style and comments are not text",
  );
  assert.ok(page.text.includes("\n"), "block elements become line breaks");
});

test("decodeEntities handles numeric, hex, named and unknown entities", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
  assert.equal(decodeEntities("&#8212;&#x2014;&nbsp;"), "—— ");
  assert.equal(decodeEntities("&hellip;"), "…");
  // An entity we do not know survives as written rather than vanishing.
  assert.equal(decodeEntities("&unknown;"), "&unknown;");
});

test("stores page text as a capture, with chunks and searchable content", async () => {
  const db = seedPages();
  const result = await enrichWebPages(db, {
    limit: 1,
    concurrency: 1,
    fetchImpl: async () => htmlResponse(PAGE_HTML, '"page-1"'),
  });

  assert.equal(result.enriched, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM captures WHERE kind = 'web_page'").get() as { c: number }).c,
    1,
  );
  assert.ok(
    (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c > 0,
    "chunks are what recall ranks passages from",
  );
  // The whole point: a phrase that exists only in the body is now searchable.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM resources_fts WHERE resources_fts MATCH 'Creators'").get() as { c: number }).c,
    1,
  );
  db.close();
});

test("an unchanged page is not fetched again", async () => {
  const db = seedPages();
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) return htmlResponse(PAGE_HTML, '"page-1"');
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"page-1"');
    return new Response(null, { status: 304 });
  };

  await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });
  const second = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });

  assert.equal(second.unchanged, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM captures").get() as { c: number }).c,
    1,
  );
  db.close();
});

test("a page with nothing readable is reported, not stored as content", async () => {
  const db = seedPages();
  // A JavaScript shell: the markup arrives, the text does not.
  const result = await enrichWebPages(db, {
    limit: 1,
    concurrency: 1,
    fetchImpl: async () => htmlResponse("<html><body><div id=root></div></body></html>"),
  });

  assert.equal(result.empty, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM captures").get() as { c: number }).c,
    0,
    "an empty shell must not tell search there is content on the page",
  );
  db.close();
});

test("a PDF or an image is not treated as a page", async () => {
  const db = seedPages();
  const result = await enrichWebPages(db, {
    limit: 1,
    concurrency: 1,
    fetchImpl: async () =>
      new Response("%PDF-1.7 not html at all", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
  });
  assert.equal(result.empty, 1);
  db.close();
});

test("a blocked page falls back to the Wayback Machine", async () => {
  const db = seedPages();
  const snapshot = "https://web.archive.org/web/20260101000000/https://example.com/1";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://archive.org/wayback/available")) {
      return Response.json({ archived_snapshots: { closest: { available: true, url: snapshot } } });
    }
    if (url === snapshot) return htmlResponse(PAGE_HTML);
    return new Response("Just a moment...", { status: 403 });
  };

  const result = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });

  assert.equal(result.enriched, 1, "the archived copy is indexed");
  assert.equal(
    (db.prepare("SELECT source_url FROM captures WHERE kind = 'web_page'").get() as { source_url: string })
      .source_url,
    snapshot,
    "the text is credited to where it came from",
  );
  assert.equal(
    (db.prepare("SELECT status FROM resource_fetch_state WHERE kind = 'web_page'").get() as { status: string })
      .status,
    "archived",
  );
  db.close();
});

test("a page with no archive snapshot still reports the original failure", async () => {
  const db = seedPages();
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://archive.org/wayback/available")) {
      return Response.json({ archived_snapshots: {} });
    }
    return new Response("nope", { status: 403 });
  };

  const result = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });

  assert.equal(result.failed, 1);
  const row = db
    .prepare("SELECT error_message FROM resource_fetch_state WHERE kind = 'web_page'")
    .get() as { error_message: string };
  assert.match(row.error_message, /HTTP 403/);
  db.close();
});

test("a failed fetch does not block the next batch", async () => {
  // This is the whole reason batching works. A failure records no success, so
  // ordering on success would retry it at the front of every batch and never
  // reach the pages behind it.
  const db = seedPages(3);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/1")) throw new Error("network down");
    return htmlResponse(PAGE_HTML);
  };

  const first = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });
  assert.equal(first.failed, 1);

  const second = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });
  assert.equal(second.enriched, 1, "the next batch moves on");
  assert.equal(second.failed, 0, "and does not retry the failure first");
  db.close();
});

// ---------------------------------------------------------------------------
// Preview images
// ---------------------------------------------------------------------------

const PAGE_HTML_WITH_IMAGE = `<html><head>
<meta property="og:title" content="Tenzen">
<meta property="og:image" content="/static/preview.png">
</head><body><p>${PAGE_BODY}</p></body></html>`;

function pngResponse(): Response {
  // A 1x1 PNG, so the bytes are a real image rather than a placeholder.
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
}

test("a page's preview image comes from og:image, resolved against the page", () => {
  assert.equal(
    pageImageUrl(PAGE_HTML_WITH_IMAGE, "https://example.com/blog/post"),
    "https://example.com/static/preview.png",
  );
  // An SVG is a logo far more often than it is a preview, and nothing can draw one.
  assert.equal(pageImageUrl(`<meta property="og:image" content="/logo.svg">`, "https://a.com"), null);
  assert.equal(pageImageUrl(`<meta name="twitter:image" content="https://a.com/x.jpg">`, "https://a.com"), "https://a.com/x.jpg");
  assert.equal(pageImageUrl("<html></html>", "https://a.com"), null);
});

test("a README's preview image skips the badge row", () => {
  const readme = [
    "# Atlas",
    "",
    "[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example.com)",
    "[![coverage](https://codecov.io/gh/example/atlas/branch/main/graph/badge.svg)](https://codecov.io)",
    "![screenshot](./docs/screenshot.png)",
    "![second](./docs/other.png)",
  ].join("\n");

  assert.equal(
    readmeImageUrl(readme, "example", "atlas"),
    "https://raw.githubusercontent.com/example/atlas/HEAD/docs/screenshot.png",
    "the first real illustration wins, not the first image",
  );
  assert.equal(readmeImageUrl("# Nothing here", "example", "atlas"), null);
});

test("the preview image is downloaded and recorded, and never fails the page", async () => {
  const db = seedPages();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("preview.png")) return pngResponse();
    return htmlResponse(PAGE_HTML_WITH_IMAGE);
  };

  const result = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });
  assert.equal(result.enriched, 1);

  const stored = db
    .prepare("SELECT source_url, local_path, content_type FROM resource_images WHERE resource_id = 1")
    .get() as { source_url: string; local_path: string; content_type: string };
  assert.equal(stored.source_url, "https://example.com/static/preview.png");
  assert.equal(stored.content_type, "image/png");
  assert.ok(existsSync(stored.local_path), "the bytes are on disk where the palette can read them");
  db.close();
});

test("an image URL that is not an image is not stored as a preview", async () => {
  const db = seedPages();
  // A tracker, a hotlink blocker, or a page that answers every URL with HTML.
  const fetchImpl: typeof fetch = async (input) =>
    String(input).endsWith("preview.png") ? htmlResponse("<html>not an image</html>") : htmlResponse(PAGE_HTML_WITH_IMAGE);

  await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM resource_images").get() as { c: number }).c,
    0,
    "a row would make the palette try to draw a file that is not a picture",
  );
  db.close();
});

test("--refresh fetches a body again that the ETag would have skipped", async () => {
  // The reason the flag exists: a page read before preview images existed has an
  // ETag and no image, and a 304 would never reveal one.
  const db = seedPages();
  let conditional = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("preview.png")) return pngResponse();
    if ((init?.headers as Record<string, string>)["If-None-Match"]) conditional += 1;
    return htmlResponse(PAGE_HTML_WITH_IMAGE, '"page-1"');
  };

  await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl });
  const again = await enrichWebPages(db, { limit: 1, concurrency: 1, fetchImpl, refresh: true });

  assert.equal(again.enriched, 1, "the body is read again rather than answered with a 304");
  assert.equal(conditional, 0, "--refresh sends no If-None-Match at all");
  db.close();
});
