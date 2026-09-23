import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, refreshResourceFts, type AtlasDatabase } from "../src/db.ts";
import { collectProjectSignals, recall, relatedResources } from "../src/recall.ts";

function seed(db: AtlasDatabase): void {
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'github', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES
      (1, 'https://github.com/example/redis-client', 'github_repository', 'example/redis-client', 'example',
       'A fast Redis client with pipelining support', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (2, 'https://x.com/i/web/status/2', 'x_post', '@someone: unrelated note', 'someone',
       'Nothing to do with the task', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (3, 'https://github.com/example/unsaved-redis-client', 'github_repository', 'example/unsaved-redis-client', 'example',
       'Redis client but unstarred', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R1', 1, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
           (1, 'R2', 2, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO github_repositories (resource_id, github_id, node_id, owner, name, full_name, stars, topics, archived, pushed_at)
    VALUES (1, 11, 'N1', 'example', 'redis-client', 'example/redis-client', 500, '["redis","cache"]', 0, '2026-08-01T00:00:00Z'),
           (3, 13, 'N3', 'example', 'unsaved-redis-client', 'example/unsaved-redis-client', 10, '["redis"]', 0, '2026-08-01T00:00:00Z');
    INSERT INTO captures (id, resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES (1, 1, 'github_readme', 'https://github.com/example/redis-client', '2026-09-01T00:00:00Z', 'h1',
            'Redis client with connection pooling and pipelining.');
  `);
  db.prepare(
    "INSERT INTO chunks (capture_id, ordinal, text, token_count, content_hash) VALUES (1, 0, ?, 10, 'c1')",
  ).run("Pipelining batches many commands into one round trip, which reduces cache invalidation latency.");
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 2);
  refreshResourceFts(db, 3);
}

test("relates a bookmark tagged with the source's name when the source has no topics", () => {
  const db = openDatabase(":memory:");
  seed(db);
  // Resource 1 keeps "redis" in its title but declares no topics at all — the shape
  // tmux/tmux has. Resource 6 carries "redis" only as a topic, so the topic tag is
  // the sole link between them.
  db.exec(`
    UPDATE github_repositories SET topics = '[]' WHERE resource_id = 1;
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES (6, 'https://github.com/example/workspace-x', 'github_repository', 'example/workspace-x', 'other',
            'a workspace for terminals', 'Rust', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R6', 6, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO github_repositories (resource_id, github_id, node_id, owner, name, full_name, stars, topics, archived, pushed_at)
    VALUES (6, 16, 'N6', 'example', 'workspace-x', 'example/workspace-x', 5, '["redis"]', 0, '2026-08-01T00:00:00Z');
  `);
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 6);

  // Filler, so "redis" is a rare term rather than half the corpus. The term floor
  // is relative to the library size, exactly as it is in the real one.
  const insertResource = db.prepare(`
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES (?, ?, 'github_repository', ?, 'filler', 'an unrelated project', 'Go', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `);
  const insertSave = db.prepare(`
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, ?, ?, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `);
  const insertRepo = db.prepare(`
    INSERT INTO github_repositories (resource_id, github_id, node_id, owner, name, full_name, stars, topics, archived, pushed_at)
    VALUES (?, ?, ?, 'filler', ?, ?, 1, '["filler"]', 0, '2026-08-01T00:00:00Z')
  `);
  for (let index = 0; index < 20; index += 1) {
    const id = 100 + index;
    insertResource.run(id, `https://github.com/filler/project-${index}`, `filler/project-${index}`);
    insertSave.run(`F${index}`, id);
    insertRepo.run(id, 1000 + index, `NF${index}`, `project-${index}`, `filler/project-${index}`);
    refreshResourceFts(db, id);
  }

  const hits = relatedResources(db, 1, { limit: 5 });
  assert.ok(
    hits.some((hit) => hit.id === 6),
    "a bookmark tagged with the source's own name should count as related",
  );
  db.close();
});

test("relates saved bookmarks by shared topic and skips unsaved ones", () => {
  const db = openDatabase(":memory:");
  seed(db);
  db.exec(`
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES (4, 'https://github.com/example/cache-warmer', 'github_repository', 'example/cache-warmer', 'other',
            'Warms a Redis cache before traffic arrives', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R4', 4, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO github_repositories (resource_id, github_id, node_id, owner, name, full_name, stars, topics, archived, pushed_at)
    VALUES (4, 14, 'N4', 'example', 'cache-warmer', 'example/cache-warmer', 20, '["redis","cache"]', 0, '2026-08-01T00:00:00Z');
  `);
  refreshResourceFts(db, 4);

  const hits = relatedResources(db, 1, { limit: 5 });
  // Resource 3 also carries the "redis" topic but is unsaved, and resource 2 shares
  // nothing, so the shared-topic bookmark is the only relation.
  assert.deepEqual(hits.map((hit) => hit.id), [4]);
  assert.ok(hits[0]?.whyRelated.some((reason) => reason.startsWith("topic:")));
  db.close();
});

test("does not call two bookmarks related just because both are tagged cli", () => {
  const db = openDatabase(":memory:");
  seed(db);
  db.exec(`
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES (5, 'https://github.com/example/cli-tool', 'github_repository', 'example/cli-tool', 'other',
            'A command line tool', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R5', 5, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO github_repositories (resource_id, github_id, node_id, owner, name, full_name, stars, topics, archived, pushed_at)
    VALUES (5, 15, 'N5', 'example', 'cli-tool', 'example/cli-tool', 5, '["cli"]', 0, '2026-08-01T00:00:00Z');
    UPDATE github_repositories SET topics = '["redis","cli"]' WHERE resource_id = 1;
  `);
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 5);

  assert.deepEqual(relatedResources(db, 1, { limit: 5 }), []);
  db.close();
});

test("collects dependency and language signals from project manifests", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-signals-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
  );

  const signals = collectProjectSignals(dir);
  assert.equal(signals.language, "TypeScript");
  assert.ok(signals.dependencies.includes("react"));
  assert.ok(signals.dependencies.includes("vitest"));
  assert.deepEqual(signals.manifests, ["package.json"]);
});

test("does not treat a generic dependency name as a match by topic", () => {
  const db = openDatabase(":memory:");
  seed(db);
  const dir = mkdtempSync(join(tmpdir(), "atlas-generic-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { typescript: "^5" } }));

  const hits = recall(db, { task: "unrelated task text", repoPath: dir, limit: 5 });

  assert.equal(
    hits.some((hit) => hit.whyMatched.some((reason) => reason.startsWith("dependency:"))),
    false,
  );
  db.close();
});

test("recall ranks a dependency match first, returns a passage, and skips unsaved sources", () => {
  const db = openDatabase(":memory:");
  seed(db);
  const dir = mkdtempSync(join(tmpdir(), "atlas-recall-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "redis-client": "1.0.0" } }));

  const hits = recall(db, { task: "reduce cache invalidation latency", repoPath: dir, limit: 5 });

  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.id, 1);
  assert.ok(hits[0]?.whyMatched.some((reason) => reason.includes("dependency: redis-client")));
  assert.match(hits[0]?.passage ?? "", /[Pp]ipelining/);
  assert.equal(hits.some((hit) => hit.id === 3), false);
  db.close();
});

test("recall works from task text alone when no project path is given", () => {
  const db = openDatabase(":memory:");
  seed(db);

  const hits = recall(db, { task: "redis pipelining", limit: 5 });

  assert.equal(hits[0]?.id, 1);
  assert.ok(hits[0]?.whyMatched.includes("passage match") || hits[0]?.whyMatched.includes("text match"));
  db.close();
});

test("a vague task falls back to the project's own description", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'github', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES
      (1, 'https://github.com/example/vector-search', 'github_repository', 'example/vector-search', 'example',
       'Vector search and embeddings for local retrieval', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (2, 'https://github.com/example/fractal-garden', 'github_repository', 'example/fractal-garden', 'example',
       'Fractals and mathematical beauty', 'JavaScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R1', 1, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
           (1, 'R2', 2, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO captures (id, resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES (1, 1, 'github_readme', 'https://github.com/example/vector-search', '2026-09-01T00:00:00Z', 'h1',
            'Semantic retrieval with embeddings for a local knowledge base.');
  `);
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 2);

  const dir = mkdtempSync(join(tmpdir(), "atlas-context-"));
  writeFileSync(
    join(dir, "README.md"),
    "# Notes\n\nA local knowledge base with searchable notes and retrieval for coding agents.\n",
  );

  const hits = recall(db, { task: "is there anything that could help here?", repoPath: dir, limit: 5 });

  assert.ok(hits.some((hit) => hit.id === 1), "expected the vector-search repo to be recalled");
  assert.equal(hits.some((hit) => hit.id === 2), false, "unrelated fractal repo must not match");
  db.close();
});

test("a strong semantic match surfaces without keyword overlap", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'github', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES
      (1, 'https://github.com/example/vector-search', 'github_repository', 'example/vector-search', 'example',
       'Vector search and embeddings', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (2, 'https://github.com/example/sourdough', 'github_repository', 'example/sourdough', 'example',
       'Baking bread', 'JavaScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R1', 1, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
           (1, 'R2', 2, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO captures (id, resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES (1, 1, 'github_readme', 'https://github.com/example/vector-search', '2026-09-01T00:00:00Z', 'h1',
            'semantic search notes');
  `);
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 2);
  db.prepare(
    "INSERT INTO chunks (id, capture_id, ordinal, text, token_count, content_hash) VALUES (1, 1, 0, ?, 3, 'c1')",
  ).run("semantic search notes");
  const vector = new Float32Array(512);
  vector[0] = 1;
  db.prepare("INSERT INTO chunk_embeddings (chunk_id, dim, vector) VALUES (1, 512, ?)").run(
    Buffer.from(vector.buffer),
  );

  const hits = recall(db, { task: "zzz unrelated qqq", limit: 5, queryVector: Array.from(vector) });

  assert.ok(hits.some((hit) => hit.id === 1), "expected the semantically matching resource");
  assert.equal(hits.some((hit) => hit.id === 2), false);
  assert.ok(hits[0]?.whyMatched.some((reason) => reason.startsWith("semantic match")));
  db.close();
});

test("recall uses the stage as project context for a vague task", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO integrations (id, provider, account, created_at, updated_at)
    VALUES (1, 'github', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO resources (id, canonical_url, resource_type, title, author, description, language, created_at, updated_at)
    VALUES
      (1, 'https://github.com/example/vector-search', 'github_repository', 'example/vector-search', 'example',
       'Vector search and embeddings for local retrieval', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (2, 'https://github.com/example/bread', 'github_repository', 'example/bread', 'example',
       'Sourdough baking', 'JavaScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO saves (integration_id, provider_external_id, resource_id, saved_at, created_at, updated_at)
    VALUES (1, 'R1', 1, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
           (1, 'R2', 2, '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);
  refreshResourceFts(db, 1);
  refreshResourceFts(db, 2);

  const hits = recall(db, {
    task: "we are at this stage now",
    stage: "vector search embeddings retrieval",
    limit: 5,
  });

  assert.ok(hits.some((hit) => hit.id === 1), "expected the stage-relevant repo");
  assert.equal(hits.some((hit) => hit.id === 2), false);
  db.close();
});
