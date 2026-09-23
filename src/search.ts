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
  contentStatus: "full" | "partial";
  archived: boolean;
  stars: number | null;
  lastPushedAt: string | null;
  /** User-authored note explaining why this bookmark matters. */
  context: string | null;
  trust: "untrusted_external_content";
};

/**
 * Which capture carries the real content for a resource type, in order of
 * preference. An X article post also carries an x_post capture, but that is
 * either a bare t.co link or a scraped dump of the same article, so the body
 * of the article is what a reader wants.
 */
const PRIMARY_CAPTURE_KINDS: Record<string, string[]> = {
  x_post: ["x_article", "x_post"],
  github_repository: ["github_readme"],
};

export type MediaResult = {
  key: string;
  type: string;
  source: string | null;
  url: string | null;
  path: string | null;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMillis: number | null;
  downloadState: string | null;
};

export type ContentCapture = {
  kind: string;
  fetchedAt: string;
  contentHash: string;
  content: string;
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
  context: string | null;
  trust: "untrusted_external_content";
  capture: null | {
    fetchedAt: string;
    contentHash: string;
    content?: string;
  };
  media: MediaResult[];
  contents?: ContentCapture[];
};

const STOP_WORDS = new Set([
  "a", "an", "and", "for", "from", "in", "into", "of", "on", "or", "over", "the", "to", "with",
  "is", "are", "was", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them", "their",
  "do", "does", "did", "can", "could", "should", "would", "will", "shall", "may", "might",
  "what", "which", "who", "whom", "how", "when", "where", "why", "there", "here", "any", "some",
  "das", "der", "die", "ein", "eine", "für", "im", "mit", "oder", "und", "von", "zu",
  // Conversational filler that should never drive a search.
  "ok", "okay", "nice", "cool", "yeah", "yep", "thanks", "thank", "please", "just",
  "really", "maybe", "sure", "hello", "hey", "hi", "so", "well", "actually", "basically",
]);

export function tokenize(input: string): string[] {
  // Match FTS5's unicode61 tokenizer: hyphens and underscores are separators.
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((token) => !STOP_WORDS.has(token.toLocaleLowerCase()));
}

export function toFtsQuery(input: string): string {
  return tokenize(input)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
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
      snippet(resources_fts, -1, '[', ']', ' … ', 24) AS snippet,
      CASE WHEN EXISTS (
        SELECT 1 FROM captures c
        WHERE c.resource_id = r.id AND length(trim(c.normalized_content)) > 0
      ) THEN 'full' ELSE 'partial' END AS contentStatus,
      COALESCE(g.archived, 0) AS archived,
      g.stars AS stars,
      g.pushed_at AS lastPushedAt,
      n.context AS context
    FROM resources_fts
    JOIN resources r ON r.id = resources_fts.resource_id
    LEFT JOIN github_repositories g ON g.resource_id = r.id
    LEFT JOIN resource_notes n ON n.resource_id = r.id
    WHERE resources_fts MATCH ?
    ORDER BY score ASC, savedAt DESC
    LIMIT ?
  `).all(ftsQuery, limit) as Array<{
    id: number;
    title: string;
    url: string;
    description: string | null;
    language: string | null;
    savedAt: string | null;
    score: number;
    snippet: string;
    contentStatus: "full" | "partial";
    archived: number;
    stars: number | null;
    lastPushedAt: string | null;
    context: string | null;
  }>;
  return rows.map((row) => ({
    ...row,
    archived: row.archived === 1,
    trust: "untrusted_external_content" as const,
  }));
}

export function getResource(
  db: AtlasDatabase,
  id: number,
  includeContent = false,
): ResourceResult | null {
  const row = db.prepare(`
    SELECT r.id, r.title, r.canonical_url AS url, r.author, r.description,
           r.language, r.resource_type AS resourceType, MAX(s.saved_at) AS savedAt,
           COALESCE(g.topics, '[]') AS topics,
           g.license_spdx AS license,
           COALESCE(g.archived, 0) AS archived,
           n.context AS context
    FROM resources r
    LEFT JOIN saves s ON s.resource_id = r.id AND s.unsaved_at IS NULL
    LEFT JOIN github_repositories g ON g.resource_id = r.id
    LEFT JOIN resource_notes n ON n.resource_id = r.id
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
        resourceType: string;
        savedAt: string | null;
        topics: string;
        license: string | null;
        archived: number;
        context: string | null;
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

  const captures = db.prepare(`
    SELECT kind, fetched_at AS fetchedAt, content_hash AS contentHash, normalized_content AS content
    FROM captures WHERE resource_id = ? ORDER BY fetched_at DESC, id DESC
  `).all(id) as Array<{ kind: string; fetchedAt: string; contentHash: string; content: string }>;
  const chosen =
    (PRIMARY_CAPTURE_KINDS[row.resourceType] ?? [])
      .map((kind) => captures.find((capture) => capture.kind === kind))
      .find((capture) => capture !== undefined) ??
    captures.find((capture) => capture.content.trim()) ??
    captures[0];
  const primary = chosen
    ? { fetchedAt: chosen.fetchedAt, contentHash: chosen.contentHash, content: chosen.content }
    : undefined;

  const media = db.prepare(`
    SELECT media_key AS key, type, source, url, local_path AS path,
           content_type AS contentType, byte_size AS byteSize,
           width, height, duration_millis AS durationMillis, download_state AS downloadState
    FROM x_media WHERE resource_id = ? ORDER BY position, media_key
  `).all(id) as MediaResult[];

  const contents = includeContent
    ? (db.prepare(`
        SELECT kind, fetched_at AS fetchedAt, content_hash AS contentHash,
               normalized_content AS content
        FROM captures WHERE resource_id = ?
        ORDER BY fetched_at DESC, id DESC
      `).all(id) as ContentCapture[])
    : undefined;

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
    context: row.context,
    trust: "untrusted_external_content",
    capture: primary
      ? {
          fetchedAt: primary.fetchedAt,
          contentHash: primary.contentHash,
          ...(includeContent ? { content: primary.content } : {}),
        }
      : null,
    media,
    ...(contents ? { contents } : {}),
  };
}
