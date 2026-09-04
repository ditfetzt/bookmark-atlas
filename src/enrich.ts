import { createHash } from "node:crypto";
import { refreshResourceFts, type AtlasDatabase } from "./db.ts";
import { resolveGitHubToken } from "./github.ts";

type RepositoryTarget = {
  resourceId: number;
  owner: string;
  name: string;
  etag: string | null;
};

export type EnrichOptions = {
  limit?: number;
  concurrency?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  token?: string;
};

export type EnrichResult = {
  selected: number;
  enriched: number;
  unchanged: number;
  missing: number;
  failed: number;
};

const API_VERSION = "2026-03-10";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkMarkdown(content: string, maxChars = 4_000): string[] {
  const paragraphs = content
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      for (let start = 0; start < paragraph.length; start += maxChars) {
        chunks.push(paragraph.slice(start, start + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function targets(db: AtlasDatabase, limit: number): RepositoryTarget[] {
  return db.prepare(`
    SELECT g.resource_id AS resourceId, g.owner, g.name, f.etag
    FROM github_repositories g
    JOIN saves s ON s.resource_id = g.resource_id AND s.unsaved_at IS NULL
    LEFT JOIN resource_fetch_state f
      ON f.resource_id = g.resource_id AND f.kind = 'github_readme'
    GROUP BY g.resource_id
    ORDER BY
      CASE WHEN f.last_success_at IS NULL THEN 0 ELSE 1 END,
      MAX(s.saved_at) DESC
    LIMIT ?
  `).all(limit) as RepositoryTarget[];
}

function saveFetchState(
  db: AtlasDatabase,
  target: RepositoryTarget,
  values: {
    etag?: string | null;
    status: string;
    success?: boolean;
    error?: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resource_fetch_state (
      resource_id, kind, etag, status, last_checked_at,
      last_success_at, error_message
    ) VALUES (?, 'github_readme', ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, kind) DO UPDATE SET
      etag = COALESCE(excluded.etag, resource_fetch_state.etag),
      status = excluded.status,
      last_checked_at = excluded.last_checked_at,
      last_success_at = COALESCE(excluded.last_success_at, resource_fetch_state.last_success_at),
      error_message = excluded.error_message
  `).run(
    target.resourceId,
    values.etag ?? target.etag,
    values.status,
    now,
    values.success ? now : null,
    values.error ?? null,
  );
}

async function enrichOne(
  db: AtlasDatabase,
  target: RepositoryTarget,
  fetchImpl: typeof fetch,
  token: string,
  maxBytes: number,
): Promise<"enriched" | "unchanged" | "missing" | "failed"> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "bookmark-atlas/0.1",
  };
  if (target.etag) headers["If-None-Match"] = target.etag;
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/readme`;

  try {
    const response = await fetchImpl(url, { headers });
    if (response.status === 304) {
      saveFetchState(db, target, { status: "unchanged", success: true });
      return "unchanged";
    }
    if (response.status === 404) {
      saveFetchState(db, target, { status: "missing" });
      return "missing";
    }
    if (!response.ok) {
      throw new Error(`GitHub README API returned ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (declaredLength > maxBytes) {
      throw new Error(`GitHub README exceeds ${maxBytes} byte limit`);
    }

    const content = (await response.text()).replaceAll("\u0000", "").trim();
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new Error(`GitHub README exceeds ${maxBytes} byte limit`);
    }
    const contentHash = hash(content);
    const fetchedAt = new Date().toISOString();
    const sourceUrl = `https://github.com/${target.owner}/${target.name}#readme`;

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO captures (
          resource_id, kind, source_url, fetched_at, content_hash, normalized_content
        ) VALUES (?, 'github_readme', ?, ?, ?, ?)
        ON CONFLICT(resource_id, kind, content_hash) DO UPDATE SET
          fetched_at = excluded.fetched_at
      `).run(target.resourceId, sourceUrl, fetchedAt, contentHash, content);
      const capture = db.prepare(`
        SELECT id FROM captures
        WHERE resource_id = ? AND kind = 'github_readme' AND content_hash = ?
      `).get(target.resourceId, contentHash) as { id: number };

      db.prepare("DELETE FROM chunks WHERE capture_id = ?").run(capture.id);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (capture_id, ordinal, text, token_count, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [ordinal, chunk] of chunkMarkdown(content).entries()) {
        insertChunk.run(capture.id, ordinal, chunk, Math.ceil(chunk.length / 4), hash(chunk));
      }
      saveFetchState(db, target, {
        etag: response.headers.get("etag"),
        status: "available",
        success: true,
      });
      refreshResourceFts(db, target.resourceId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return "enriched";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveFetchState(db, target, { status: "failed", error: message });
    return "failed";
  }
}

export async function enrichGitHubReadmes(
  db: AtlasDatabase,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const limit = options.limit ?? 25;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const selected = targets(db, limit);
  const token = options.token ?? resolveGitHubToken();
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const outcomes: Array<"enriched" | "unchanged" | "missing" | "failed"> = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < selected.length) {
      const target = selected[next];
      next += 1;
      if (!target) break;
      outcomes.push(await enrichOne(db, target, fetchImpl, token, maxBytes));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    selected: selected.length,
    enriched: outcomes.filter((value) => value === "enriched").length,
    unchanged: outcomes.filter((value) => value === "unchanged").length,
    missing: outcomes.filter((value) => value === "missing").length,
    failed: outcomes.filter((value) => value === "failed").length,
  };
}
