import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.ts";
import { chunkMarkdown, enrichGitHubReadmes } from "../src/enrich.ts";

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
