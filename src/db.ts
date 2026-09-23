import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AtlasDatabase = DatabaseSync;

export function openDatabase(path: string): AtlasDatabase {
  const absolutePath = path === ":memory:" ? path : resolve(path);
  if (absolutePath !== ":memory:") {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  const db = new DatabaseSync(absolutePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: AtlasDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, account)
    );

    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY,
      canonical_url TEXT NOT NULL UNIQUE,
      resource_type TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      description TEXT,
      language TEXT,
      availability_status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saves (
      id INTEGER PRIMARY KEY,
      integration_id INTEGER NOT NULL REFERENCES integrations(id),
      provider_external_id TEXT NOT NULL,
      resource_id INTEGER NOT NULL REFERENCES resources(id),
      saved_at TEXT,
      unsaved_at TEXT,
      provider_metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(integration_id, provider_external_id)
    );

    CREATE TABLE IF NOT EXISTS github_repositories (
      resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      github_id INTEGER NOT NULL UNIQUE,
      node_id TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      license_spdx TEXT,
      stars INTEGER NOT NULL DEFAULT 0,
      forks INTEGER NOT NULL DEFAULT 0,
      open_issues INTEGER NOT NULL DEFAULT 0,
      topics TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      github_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS x_posts (
      resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      x_post_id TEXT NOT NULL UNIQUE,
      author_id TEXT,
      author_handle TEXT,
      author_name TEXT,
      post_created_at TEXT,
      conversation_id TEXT,
      media TEXT NOT NULL DEFAULT '[]',
      outbound_urls TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_media (
      resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT,
      article_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      thumbnail_url TEXT,
      width INTEGER,
      height INTEGER,
      duration_millis INTEGER,
      local_path TEXT,
      content_type TEXT,
      byte_size INTEGER,
      sha256 TEXT,
      download_state TEXT,
      PRIMARY KEY(resource_id, media_key)
    );

    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      integration_id INTEGER PRIMARY KEY REFERENCES integrations(id),
      etag TEXT,
      is_complete INTEGER NOT NULL DEFAULT 0,
      high_watermark TEXT,
      last_checked_at TEXT,
      last_success_at TEXT,
      last_reconciled_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      integration_id INTEGER NOT NULL REFERENCES integrations(id),
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      imported_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      removed_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY,
      resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      source_url TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      UNIQUE(resource_id, kind, content_hash)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(capture_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS resource_fetch_state (
      resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      etag TEXT,
      status TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      last_success_at TEXT,
      error_message TEXT,
      PRIMARY KEY(resource_id, kind)
    );

    CREATE TABLE IF NOT EXISTS resource_notes (
      resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      context TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmark_usage (
      resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      first_used_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_action TEXT
    );

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS resources_fts USING fts5(
      resource_id UNINDEXED,
      title,
      description,
      topics,
      language,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  const checkpointColumns = db
    .prepare("PRAGMA table_info(sync_checkpoints)")
    .all() as Array<{ name: string }>;
  if (!checkpointColumns.some((column) => column.name === "is_complete")) {
    db.exec("ALTER TABLE sync_checkpoints ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 0");
  }

  const ftsColumns = db
    .prepare("PRAGMA table_info(resources_fts)")
    .all() as Array<{ name: string }>;
  if (!ftsColumns.some((column) => column.name === "content")) {
    db.exec("DROP TABLE resources_fts");
    db.exec(`
      CREATE VIRTUAL TABLE resources_fts USING fts5(
        resource_id UNINDEXED,
        title,
        description,
        topics,
        language,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
    rebuildMissingFtsRows(db);
  }

  // Term document-frequency table for IDF weighting in recall.
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS resources_vocab USING fts5vocab(resources_fts, 'row')");

  // Chunk-level index (external content over `chunks`). Triggers keep it in
  // sync; the rebuild runs only the first time the table is created.
  const chunksFtsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'")
    .get();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content = 'chunks',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
    END;
  `);
  if (!chunksFtsExists) {
    db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild')");
  }
}

function rebuildMissingFtsRows(db: AtlasDatabase): void {
  const rows = db.prepare(`
    SELECT r.id
    FROM resources r
    LEFT JOIN resources_fts f ON f.resource_id = r.id
    WHERE f.resource_id IS NULL
  `).all() as Array<{ id: number }>;
  for (const row of rows) refreshResourceFts(db, row.id);
}

export function refreshResourceFts(db: AtlasDatabase, resourceId: number): void {
  const resource = db.prepare(`
    SELECT r.title, r.description, r.language,
           COALESCE(g.topics, '[]') AS topics,
           COALESCE(n.context, '') AS note,
           COALESCE((
             SELECT group_concat(part, char(10) || char(10))
             FROM (
               SELECT (
                 SELECT c2.normalized_content
                 FROM captures c2
                 WHERE c2.resource_id = r.id AND c2.kind = c.kind
                 ORDER BY c2.fetched_at DESC, c2.id DESC
                 LIMIT 1
               ) AS part
               FROM captures c
               WHERE c.resource_id = r.id
               GROUP BY c.kind
             )
             WHERE part IS NOT NULL AND length(trim(part)) > 0
           ), '') AS content
    FROM resources r
    LEFT JOIN github_repositories g ON g.resource_id = r.id
    LEFT JOIN resource_notes n ON n.resource_id = r.id
    WHERE r.id = ?
  `).get(resourceId) as
    | {
        title: string;
        description: string | null;
        language: string | null;
        topics: string;
        note: string;
        content: string;
      }
    | undefined;
  if (!resource) return;

  let topics = "";
  try {
    const parsed = JSON.parse(resource.topics) as unknown;
    topics = Array.isArray(parsed) ? parsed.join(" ") : "";
  } catch {
    topics = "";
  }

  db.prepare("DELETE FROM resources_fts WHERE resource_id = ?").run(resourceId);
  db.prepare(`
    INSERT INTO resources_fts (
      resource_id, title, description, topics, language, content
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    resourceId,
    resource.title,
    resource.description ?? "",
    topics,
    resource.language ?? "",
    [resource.note, resource.content].filter((part) => part.trim()).join("\n\n"),
  );
}

export type PruneResult = { pruned: number };

/**
 * Delete resources that no longer have an active save. Reconciliation removes a
 * bookmark by setting saves.unsaved_at and never deletes, so unstarred repos and
 * unbookmarked posts pile up as rows nothing can see. Everything hanging off the
 * resource cascades, but `saves` has no ON DELETE CASCADE and the full-text row
 * is not linked by foreign key at all, so both are cleared explicitly.
 */
export function pruneOrphanResources(db: AtlasDatabase, options: { dryRun?: boolean } = {}): PruneResult {
  const ids = (db.prepare(`
    SELECT r.id FROM resources r
    WHERE NOT EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
  `).all() as Array<{ id: number }>).map((row) => row.id);
  if (options.dryRun || ids.length === 0) return { pruned: ids.length };
  const deleteFts = db.prepare("DELETE FROM resources_fts WHERE resource_id = ?");
  const deleteSaves = db.prepare("DELETE FROM saves WHERE resource_id = ?");
  const deleteResource = db.prepare("DELETE FROM resources WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      deleteFts.run(id);
      deleteSaves.run(id);
      deleteResource.run(id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { pruned: ids.length };
}

export function databasePath(): string {
  return process.env.BOOKMARK_ATLAS_DB ?? "./data/bookmarks.db";
}
