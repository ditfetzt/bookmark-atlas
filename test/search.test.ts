import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, refreshResourceFts } from "../src/db.ts";
import { getResource, searchResources, toFtsQuery } from "../src/search.ts";

test("normalizes user input into a safe FTS query", () => {
  assert.equal(toFtsQuery("Next.js OAuth"), '"Next" OR "js" OR "OAuth"');
  assert.equal(toFtsQuery("search for the local knowledge base"), '"search" OR "local" OR "knowledge" OR "base"');
  assert.equal(toFtsQuery("   "), "");
});

test("finds indexed repository metadata without network or LLM", () => {
  const db = openDatabase(":memory:");
  seed(db);

  const results = searchResources(db, "local first agent", 5);

  assert.equal(results.length, 1);
  const first = results[0];
  assert.ok(first);
  assert.equal(first.title, "example/local-agent");
  assert.match(first.snippet, /local/i);
  assert.equal(first.trust, "untrusted_external_content");
  db.close();
});

test("returns a note as context and indexes it for search", () => {
  const db = openDatabase(":memory:");
  seed(db);
  db.prepare(
    "INSERT INTO resource_notes (resource_id, context, updated_at) VALUES (1, ?, ?)",
  ).run("The canonical blueprint for this project", "2026-01-01T00:00:00Z");
  refreshResourceFts(db, 1);

  const resource = getResource(db, 1);
  assert.equal(resource?.context, "The canonical blueprint for this project");
  assert.ok(searchResources(db, "canonical blueprint", 5).some((hit) => hit.id === 1));
  db.close();
});

test("returns resource metadata with an explicit trust boundary", () => {
  const db = openDatabase(":memory:");
  seed(db);

  const resource = getResource(db, 1);

  assert.equal(resource?.title, "example/local-agent");
  assert.equal(resource?.trust, "untrusted_external_content");
  assert.equal(resource?.capture, null);
  db.close();
});

test("reads the article body rather than the bare link that shares its bookmark", () => {
  const db = openDatabase(":memory:");
  seed(db);
  // An X article post carries both captures; the x_post one is just a t.co link,
  // and it is newer, so only a kind preference can pick the body.
  db.exec(`
    INSERT INTO resources (
      id, canonical_url, resource_type, title, author, description,
      language, created_at, updated_at
    ) VALUES (
      2, 'https://x.com/i/web/status/2099837130927427989', 'x_post',
      'X post: https://t.co/nF3ZDklT3R', 'someone', NULL,
      NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
    );
    INSERT INTO captures (resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES
      (2, 'x_post', 'https://x.com/i/web/status/2099837130927427989',
       '2026-01-02T00:00:02Z', 'hash-post', 'https://t.co/nF3ZDklT3R'),
      (2, 'x_article', 'https://x.com/i/web/status/2099837130927427989',
       '2026-01-02T00:00:01Z', 'hash-article', 'A long article body worth keeping');
  `);

  const resource = getResource(db, 2, true);
  assert.equal(resource?.capture?.content, "A long article body worth keeping");
  assert.equal(resource?.capture?.contentHash, "hash-article");
  db.close();
});

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO resources (
      id, canonical_url, resource_type, title, author, description,
      language, created_at, updated_at
    ) VALUES (
      1, 'https://github.com/example/local-agent', 'github_repository',
      'example/local-agent', 'example',
      'A local first coding agent with searchable memory',
      'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    INSERT INTO resources_fts (resource_id, title, description, topics, language)
    VALUES (
      1, 'example/local-agent',
      'A local first coding agent with searchable memory',
      'agents knowledge-base', 'TypeScript'
    );
  `);
}
