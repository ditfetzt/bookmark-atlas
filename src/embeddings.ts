import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasDataDir, type AtlasDatabase } from "./db.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SOURCE = join(REPO_ROOT, "scripts", "macos-embed.swift");
// Compiled into the user data directory, not the checkout: an installed package
// must not write into its own directory.
const BINARY = join(atlasDataDir(), "macos-embed");
const MAX_BATCH = 256;
const MAX_QUERY_BYTES = 512 * 1024 * 1024;

let resolved: string | null | undefined;

/**
 * Path to the compiled on-device embedding helper, compiling it once if needed.
 * Returns null when unavailable (non-macOS, no Swift toolchain, no source).
 */
export function embeddingBinary(): string | null {
  if (resolved !== undefined) return resolved;
  const override = process.env.BOOKMARK_ATLAS_EMBED_BIN;
  if (override) {
    resolved = existsSync(override) ? override : null;
    return resolved;
  }
  if (process.platform !== "darwin" || !existsSync(SOURCE)) {
    resolved = null;
    return resolved;
  }
  try {
    const fresh = existsSync(BINARY) && statSync(BINARY).mtimeMs >= statSync(SOURCE).mtimeMs;
    if (!fresh) {
      mkdirSync(dirname(BINARY), { recursive: true });
      const compiled = spawnSync("swiftc", ["-O", SOURCE, "-o", BINARY], { encoding: "utf8" });
      if (compiled.status !== 0) {
        resolved = null;
        return resolved;
      }
    }
    resolved = BINARY;
  } catch {
    resolved = null;
  }
  return resolved;
}

export function embeddingsAvailable(): boolean {
  return embeddingBinary() !== null;
}

export function embedTexts(texts: string[]): number[][] {
  if (texts.length === 0) return [];
  const binary = embeddingBinary();
  if (!binary) return [];
  const result = spawnSync(binary, [], {
    input: JSON.stringify(texts),
    encoding: "utf8",
    maxBuffer: MAX_QUERY_BYTES,
  });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as number[][];
  } catch {
    return [];
  }
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer as ArrayBuffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type BuildEmbeddingsResult = {
  available: boolean;
  selected: number;
  embedded: number;
  dim: number;
};

/** Embed chunks that do not have a vector yet. Incremental and resumable. */
export function buildEmbeddings(
  db: AtlasDatabase,
  options: { limit?: number; batchSize?: number } = {},
): BuildEmbeddingsResult {
  if (!embeddingsAvailable()) return { available: false, selected: 0, embedded: 0, dim: 0 };
  const limit = Math.max(1, options.limit ?? 100_000);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_BATCH, 1024));
  const rows = db
    .prepare(`
      SELECT c.id AS id, c.text AS text
      FROM chunks c
      LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id
      WHERE e.chunk_id IS NULL
      ORDER BY c.id
      LIMIT ?
    `)
    .all(limit) as Array<{ id: number; text: string }>;
  if (rows.length === 0) return { available: true, selected: 0, embedded: 0, dim: 0 };

  const insert = db.prepare(
    "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, dim, vector) VALUES (?, ?, ?)",
  );
  let embedded = 0;
  let dim = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const vectors = embedTexts(batch.map((row) => row.text));
    if (vectors.length !== batch.length) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      batch.forEach((row, index) => {
        const vector = vectors[index];
        if (!vector || vector.length === 0) return;
        dim = vector.length;
        insert.run(row.id, vector.length, toBlob(vector));
        embedded += 1;
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { available: true, selected: rows.length, embedded, dim };
}

/** Embed a query, cached by text hash so repeated queries cost nothing. */
export function embedQuery(db: AtlasDatabase, text: string): number[] | null {
  const hash = hashText(text);
  const cached = db.prepare("SELECT vector FROM embedding_cache WHERE hash = ?").get(hash) as
    | { vector: Uint8Array }
    | undefined;
  if (cached) return Array.from(fromBlob(cached.vector));

  const [vector] = embedTexts([text]);
  if (!vector || vector.length === 0) return null;
  db.prepare("INSERT OR REPLACE INTO embedding_cache (hash, dim, vector) VALUES (?, ?, ?)").run(
    hash,
    vector.length,
    toBlob(vector),
  );
  return vector;
}

export function embeddedChunkCount(db: AtlasDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM chunk_embeddings").get() as { c: number }).c;
}

export type VectorHit = { resourceId: number; score: number };

/** Resource ids ranked by cosine similarity to a query vector, best chunk per resource. */
export function vectorRank(db: AtlasDatabase, query: number[], limit: number): VectorHit[] {
  if (query.length === 0 || limit < 1) return [];
  const rows = db
    .prepare(`
      SELECT e.vector AS vector, cap.resource_id AS resourceId
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN captures cap ON cap.id = c.capture_id
      JOIN resources r ON r.id = cap.resource_id
      WHERE EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
    `)
    .all() as Array<{ vector: Uint8Array; resourceId: number }>;
  if (rows.length === 0) return [];

  const queryVector = new Float32Array(query);
  let queryNorm = 0;
  for (const value of queryVector) queryNorm += value * value;
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  const best = new Map<number, number>();
  for (const row of rows) {
    const vector = fromBlob(row.vector);
    if (vector.length !== queryVector.length) continue;
    let dot = 0;
    let norm = 0;
    for (let index = 0; index < vector.length; index += 1) {
      const value = vector[index] ?? 0;
      dot += value * (queryVector[index] ?? 0);
      norm += value * value;
    }
    if (norm === 0) continue;
    const score = dot / (queryNorm * Math.sqrt(norm));
    const previous = best.get(row.resourceId);
    if (previous === undefined || score > previous) best.set(row.resourceId, score);
  }

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([resourceId, score]) => ({ resourceId, score }));
}
