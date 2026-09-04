import type { AtlasDatabase } from "./db.ts";

export type SearchResult = {
  id: number;
  title: string;
  url: string;
  description: string | null;
  language: string | null;
  savedAt: string | null;
  score: number;
  snippet: string;
  trust: "untrusted_external_content";
};

export type ResourceResult = {
  id: number;
  title: string;
  url: string;
  author: string | null;
  description: string | null;
  language: string | null;
  savedAt: string | null;
  topics: string[];
  license: string | null;
  archived: boolean;
  trust: "untrusted_external_content";
  capture: null | {
    fetchedAt: string;
    contentHash: string;
    content?: string;
  };
};

export function toFtsQuery(input: string): string {
  const stopWords = new Set([
    "a", "an", "and", "for", "from", "in", "into", "of", "on", "or", "over", "the", "to", "with",
    "das", "der", "die", "ein", "eine", "für", "im", "in", "mit", "oder", "und", "von", "zu",
  ]);
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const meaningful = tokens.filter((token) => !stopWords.has(token.toLocaleLowerCase()));
  return meaningful.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchResources(
  db: AtlasDatabase,
  query: string,
  limit = 10,
): SearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = db.prepare(`
    SELECT
      r.id,
      r.title,
      r.canonical_url AS url,
      r.description,
      r.language,
      (
        SELECT MAX(s.saved_at)
        FROM saves s
        WHERE s.resource_id = r.id AND s.unsaved_at IS NULL
      ) AS savedAt,
      bm25(resources_fts, 0.0, 10.0, 5.0, 3.0, 1.0, 2.0) AS score,
      snippet(resources_fts, -1, '[', ']', ' … ', 24) AS snippet
    FROM resources_fts
    JOIN resources r ON r.id = resources_fts.resource_id
    WHERE resources_fts MATCH ?
    ORDER BY score ASC, savedAt DESC
    LIMIT ?
  `).all(ftsQuery, limit) as Array<Omit<SearchResult, "trust">>;
  return rows.map((row) => ({ ...row, trust: "untrusted_external_content" }));
}

export function getResource(
  db: AtlasDatabase,
  id: number,
  includeContent = false,
): ResourceResult | null {
  const row = db.prepare(`
    SELECT r.id, r.title, r.canonical_url AS url, r.author, r.description,
           r.language, MAX(s.saved_at) AS savedAt,
           COALESCE(g.topics, '[]') AS topics,
           g.license_spdx AS license,
           COALESCE(g.archived, 0) AS archived,
           c.fetched_at AS fetchedAt,
           c.content_hash AS contentHash,
           c.normalized_content AS content
    FROM resources r
    LEFT JOIN saves s ON s.resource_id = r.id AND s.unsaved_at IS NULL
    LEFT JOIN github_repositories g ON g.resource_id = r.id
    LEFT JOIN captures c ON c.id = (
      SELECT c2.id FROM captures c2
      WHERE c2.resource_id = r.id
      ORDER BY c2.fetched_at DESC, c2.id DESC LIMIT 1
    )
    WHERE r.id = ?
    GROUP BY r.id
  `).get(id) as
    | {
        id: number;
        title: string;
        url: string;
        author: string | null;
        description: string | null;
        language: string | null;
        savedAt: string | null;
        topics: string;
        license: string | null;
        archived: number;
        fetchedAt: string | null;
        contentHash: string | null;
        content: string | null;
      }
    | undefined;
  if (!row) return null;

  let topics: string[] = [];
  try {
    const parsed = JSON.parse(row.topics) as unknown;
    if (Array.isArray(parsed)) topics = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    topics = [];
  }

  return {
    id: row.id,
    title: row.title,
    url: row.url,
    author: row.author,
    description: row.description,
    language: row.language,
    savedAt: row.savedAt,
    topics,
    license: row.license,
    archived: row.archived === 1,
    trust: "untrusted_external_content",
    capture:
      row.fetchedAt && row.contentHash
        ? {
            fetchedAt: row.fetchedAt,
            contentHash: row.contentHash,
            ...(includeContent && row.content !== null ? { content: row.content } : {}),
          }
        : null,
  };
}
