import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { refreshResourceFts, type AtlasDatabase } from "./db.ts";
import { chunkMarkdown } from "./enrich.ts";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type XImportOptions = {
  account?: string;
  maxFileBytes?: number;
};

export type XImportResult = {
  format: "siftly-native" | "siftly-export" | "tweetxvault" | "x-api-v2";
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  missingSavedAt: number;
};

type NormalizedPost = {
  id: string;
  text: string;
  authorId: string | null;
  authorHandle: string | null;
  authorName: string | null;
  language: string | null;
  postCreatedAt: string | null;
  savedAt: string | null;
  conversationId: string | null;
  media: JsonObject[];
  outboundUrls: string[];
  raw: JsonObject;
};

type ParsedImport = {
  format: XImportResult["format"];
  source: string;
  posts: Array<NormalizedPost | null>;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nested(root: unknown, ...keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    const value = object(current);
    if (!value) return undefined;
    current = value[key];
  }
  return current;
}

function validDate(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/&#39;|&apos;/g, "'");
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(string).filter((value): value is string => value !== null))];
}

function jsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function entityUrls(tweet: JsonObject): string[] {
  const candidates = nested(tweet, "legacy", "entities", "urls");
  if (!Array.isArray(candidates)) return [];
  return uniqueStrings(
    candidates.flatMap((candidate) => {
      const url = object(candidate);
      return url ? [url.expanded_url, url.unwound_url] : [];
    }),
  );
}

function expandEntityUrls(text: string, tweet: JsonObject): string {
  const candidates = nested(tweet, "legacy", "entities", "urls");
  if (!Array.isArray(candidates)) return text;
  let expanded = text;
  for (const candidate of candidates) {
    const url = object(candidate);
    const short = string(url?.url);
    const long = string(url?.unwound_url) ?? string(url?.expanded_url);
    if (short && long) expanded = expanded.replaceAll(short, long);
  }
  return expanded;
}

function nativeText(tweet: JsonObject): string {
  const note = string(nested(tweet, "note_tweet", "note_tweet_results", "result", "text"));
  if (note) return decodeEntities(expandEntityUrls(note, tweet));

  const article = object(nested(tweet, "article", "article_results", "result"));
  if (article) {
    const parts = [string(article.title), string(article.content)].filter(
      (value): value is string => value !== null,
    );
    const blocks = nested(article, "content_state", "blocks");
    if (parts.length < 2 && Array.isArray(blocks)) {
      const blockText = blocks
        .map((block) => string(object(block)?.text))
        .filter((value): value is string => value !== null)
        .join("\n\n");
      if (blockText) parts.push(blockText);
    }
    if (parts.length) return decodeEntities(parts.join("\n\n"));
  }

  return decodeEntities(
    expandEntityUrls(string(nested(tweet, "legacy", "full_text")) ?? "", tweet),
  );
}

function nativeMedia(tweet: JsonObject): JsonObject[] {
  const extended = nested(tweet, "legacy", "extended_entities", "media");
  const basic = nested(tweet, "legacy", "entities", "media");
  const media = Array.isArray(extended) ? extended : Array.isArray(basic) ? basic : [];
  return media.map(object).filter((value): value is JsonObject => value !== null);
}

function unwrapNative(value: unknown): JsonObject | null {
  const tweet = object(value);
  if (!tweet) return null;
  if (tweet.__typename === "TweetWithVisibilityResults") return object(tweet.tweet);
  return tweet;
}

function normalizeNative(value: unknown): NormalizedPost | null {
  const tweet = unwrapNative(value);
  if (!tweet) return null;
  const id = string(tweet.rest_id);
  if (!id) return null;
  const user = object(nested(tweet, "core", "user_results", "result"));
  const legacyUser = object(user?.legacy);
  const coreUser = object(user?.core);
  return {
    id,
    text: nativeText(tweet),
    authorId: string(user?.rest_id),
    authorHandle: string(legacyUser?.screen_name) ?? string(coreUser?.screen_name),
    authorName: string(legacyUser?.name) ?? string(coreUser?.name),
    language: string(nested(tweet, "legacy", "lang")),
    postCreatedAt: validDate(nested(tweet, "legacy", "created_at")),
    savedAt: null,
    conversationId: string(nested(tweet, "legacy", "conversation_id_str")),
    media: nativeMedia(tweet),
    outboundUrls: entityUrls(tweet),
    raw: tweet,
  };
}

function normalizeSiftlyExport(value: unknown): NormalizedPost | null {
  const bookmark = object(value);
  if (!bookmark) return null;
  const id = string(bookmark.tweetId);
  if (!id) return null;
  const media = Array.isArray(bookmark.mediaItems)
    ? bookmark.mediaItems.map(object).filter((item): item is JsonObject => item !== null)
    : [];
  return {
    id,
    text: string(bookmark.text) ?? "",
    authorId: null,
    authorHandle: string(bookmark.authorHandle),
    authorName: string(bookmark.authorName),
    language: string(bookmark.language),
    postCreatedAt: validDate(bookmark.tweetCreatedAt),
    savedAt: validDate(bookmark.importedAt),
    conversationId: null,
    media,
    outboundUrls: [],
    raw: bookmark,
  };
}

function normalizeTweetXVault(value: unknown): NormalizedPost | null {
  const bookmark = object(value);
  if (!bookmark) return null;
  const id = string(bookmark.tweet_id) ?? string(bookmark.tweetId);
  if (!id) return null;
  const mediaValue = bookmark.media ?? bookmark.media_items ?? bookmark.mediaItems;
  const media = Array.isArray(mediaValue)
    ? mediaValue.map(object).filter((item): item is JsonObject => item !== null)
    : [];
  const raw = jsonObject(bookmark.raw_json) ?? bookmark;
  const urlValues = [bookmark.urls, bookmark.outbound_urls, bookmark.outboundUrls]
    .flatMap((value) => Array.isArray(value) ? value : [value]);
  const outboundUrls = uniqueStrings(urlValues.flatMap((value) => {
    const item = object(value);
    return item ? [item.expanded_url, item.unwound_url, item.url] : [value];
  }));
  return {
    id,
    text: string(bookmark.text) ?? string(bookmark.full_text) ?? string(bookmark.content) ?? "",
    authorId: string(bookmark.author_id) ?? string(bookmark.authorId),
    authorHandle: string(bookmark.author_username) ?? string(bookmark.author_handle) ?? string(bookmark.authorHandle),
    authorName: string(bookmark.author_display_name) ?? string(bookmark.author_name) ?? string(bookmark.authorName),
    language: string(bookmark.lang) ?? string(bookmark.language),
    postCreatedAt: validDate(bookmark.created_at) ?? validDate(bookmark.post_created_at) ?? validDate(bookmark.tweetCreatedAt),
    savedAt: validDate(bookmark.added_at) ?? validDate(bookmark.captured_at) ?? validDate(bookmark.saved_at) ?? validDate(bookmark.importedAt),
    conversationId: string(bookmark.conversation_id) ?? string(bookmark.conversationId),
    media,
    outboundUrls,
    raw,
  };
}

function normalizeApiV2(value: unknown, users: Map<string, JsonObject>, media: Map<string, JsonObject>): NormalizedPost | null {
  const tweet = object(value);
  if (!tweet) return null;
  const id = string(tweet.id);
  if (!id) return null;
  const authorId = string(tweet.author_id);
  const user = authorId ? users.get(authorId) : undefined;
  const mediaKeys = nested(tweet, "attachments", "media_keys");
  const mediaItems = Array.isArray(mediaKeys)
    ? mediaKeys.map(string).filter((key): key is string => key !== null).map((key) => media.get(key)).filter((item): item is JsonObject => item !== undefined)
    : [];
  return {
    id,
    text: string(tweet.text) ?? "",
    authorId,
    authorHandle: string(user?.username),
    authorName: string(user?.name),
    language: string(tweet.lang),
    postCreatedAt: validDate(tweet.created_at),
    savedAt: null,
    conversationId: string(tweet.conversation_id),
    media: mediaItems,
    outboundUrls: [],
    raw: tweet,
  };
}

function parseInput(input: unknown): ParsedImport {
  const root = object(input);
  const tweetxvaultEntries = root && Array.isArray(root.bookmarks)
    ? root.bookmarks
    : Array.isArray(input) && input.some((value) => {
        const item = object(value);
        return item && ("tweet_id" in item || "author_username" in item || "raw_json" in item);
      })
      ? input
      : null;
  if (tweetxvaultEntries) {
    const isTweetXVault = tweetxvaultEntries.some((value) => {
      const item = object(value);
      return item && ("tweet_id" in item || "author_username" in item || "raw_json" in item);
    });
    if (isTweetXVault) {
      return {
        format: "tweetxvault",
        source: string(root?.source) ?? "tweetxvault",
        posts: tweetxvaultEntries.map(normalizeTweetXVault),
      };
    }
  }
  if (root && Array.isArray(root.bookmarks)) {
    return {
      format: "siftly-native",
      source: string(root.source) ?? "bookmark",
      posts: root.bookmarks.map(normalizeNative),
    };
  }

  if (root && Array.isArray(root.data)) {
    const users = new Map<string, JsonObject>();
    const includedUsers = nested(root, "includes", "users");
    if (Array.isArray(includedUsers)) {
      for (const candidate of includedUsers) {
        const user = object(candidate);
        const id = string(user?.id);
        if (user && id) users.set(id, user);
      }
    }
    const media = new Map<string, JsonObject>();
    const includedMedia = nested(root, "includes", "media");
    if (Array.isArray(includedMedia)) {
      for (const candidate of includedMedia) {
        const item = object(candidate);
        const key = string(item?.media_key);
        if (item && key) media.set(key, item);
      }
    }
    return {
      format: "x-api-v2",
      source: "bookmark",
      posts: root.data.map((post) => normalizeApiV2(post, users, media)),
    };
  }

  if (Array.isArray(input)) {
    return { format: "siftly-export", source: "bookmark", posts: input.map(normalizeSiftlyExport) };
  }

  throw new Error("Unsupported X bookmark JSON. Expected a Siftly capture, Siftly export, or X API v2 response.");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ensureIntegration(db: AtlasDatabase, account: string): number {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integrations (provider, account, created_at, updated_at)
    VALUES ('x', ?, ?, ?)
    ON CONFLICT(provider, account) DO UPDATE SET updated_at = excluded.updated_at
  `).run(account, now, now);
  return (db.prepare("SELECT id FROM integrations WHERE provider = 'x' AND account = ?").get(account) as { id: number }).id;
}

function title(post: NormalizedPost): string {
  const oneLine = post.text.replace(/\s+/g, " ").trim();
  const prefix = post.authorHandle ? `@${post.authorHandle}: ` : "X post: ";
  return `${prefix}${oneLine || post.id}`.slice(0, 240);
}

function canonicalUrl(post: NormalizedPost): string {
  return `https://x.com/i/web/status/${post.id}`;
}

function importPost(db: AtlasDatabase, integrationId: number, post: NormalizedPost, source: string): "imported" | "updated" {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT resource_id AS resourceId FROM x_posts WHERE x_post_id = ?").get(post.id) as { resourceId: number } | undefined;
  const url = canonicalUrl(post);
  const existingUrl = existing
    ? undefined
    : db.prepare("SELECT id AS resourceId FROM resources WHERE canonical_url = ?").get(url) as { resourceId: number } | undefined;
  const resourceId = existing?.resourceId ?? existingUrl?.resourceId;

  if (resourceId) {
    db.prepare(`
      UPDATE resources SET canonical_url = ?, title = ?, author = ?, description = ?,
        language = ?, availability_status = 'available', updated_at = ? WHERE id = ?
    `).run(url, title(post), post.authorHandle ?? post.authorName, post.text.slice(0, 2_000), post.language, now, resourceId);
  } else {
    db.prepare(`
      INSERT INTO resources (
        canonical_url, resource_type, title, author, description, language,
        availability_status, created_at, updated_at
      ) VALUES (?, 'x_post', ?, ?, ?, ?, 'available', ?, ?)
    `).run(url, title(post), post.authorHandle ?? post.authorName, post.text.slice(0, 2_000), post.language, now, now);
  }

  const resource = resourceId ?? (db.prepare("SELECT id FROM resources WHERE canonical_url = ?").get(url) as { id: number }).id;
  db.prepare(`
    INSERT INTO saves (
      integration_id, provider_external_id, resource_id, saved_at,
      provider_metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, provider_external_id) DO UPDATE SET
      resource_id = excluded.resource_id,
      saved_at = COALESCE(excluded.saved_at, saves.saved_at),
      unsaved_at = NULL,
      provider_metadata = excluded.provider_metadata,
      updated_at = excluded.updated_at
  `).run(integrationId, post.id, resource, post.savedAt, JSON.stringify({ source }), now, now);
  db.prepare(`
    INSERT INTO x_posts (
      resource_id, x_post_id, author_id, author_handle, author_name,
      post_created_at, conversation_id, media, outbound_urls, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET
      x_post_id = excluded.x_post_id,
      author_id = excluded.author_id,
      author_handle = excluded.author_handle,
      author_name = excluded.author_name,
      post_created_at = excluded.post_created_at,
      conversation_id = excluded.conversation_id,
      media = excluded.media,
      outbound_urls = excluded.outbound_urls,
      raw_json = excluded.raw_json
  `).run(resource, post.id, post.authorId, post.authorHandle, post.authorName, post.postCreatedAt, post.conversationId, JSON.stringify(post.media), JSON.stringify(post.outboundUrls), JSON.stringify(post.raw));

  const contentHash = hash(post.text);
  db.prepare(`
    INSERT INTO captures (resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES (?, 'x_post', ?, ?, ?, ?)
    ON CONFLICT(resource_id, kind, content_hash) DO UPDATE SET fetched_at = excluded.fetched_at
  `).run(resource, url, now, contentHash, post.text);
  const capture = db.prepare(`
    SELECT id FROM captures WHERE resource_id = ? AND kind = 'x_post' AND content_hash = ?
  `).get(resource, contentHash) as { id: number };
  db.prepare("DELETE FROM chunks WHERE capture_id = ?").run(capture.id);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (capture_id, ordinal, text, token_count, content_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [ordinal, chunk] of chunkMarkdown(post.text).entries()) {
    insertChunk.run(capture.id, ordinal, chunk, Math.ceil(chunk.length / 4), hash(chunk));
  }
  refreshResourceFts(db, resource);
  return existing || existingUrl ? "updated" : "imported";
}

export function importXJson(db: AtlasDatabase, input: unknown, options: XImportOptions = {}): XImportResult {
  const parsed = parseInput(input);
  const integrationId = ensureIntegration(db, options.account ?? "json-import");
  const startedAt = new Date().toISOString();
  const runId = Number(db.prepare(`
    INSERT INTO sync_runs (integration_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(integrationId, startedAt).lastInsertRowid);
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let missingSavedAt = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const post of parsed.posts) {
      if (!post) {
        skipped += 1;
        continue;
      }
      if (!post.savedAt) missingSavedAt += 1;
      const outcome = importPost(db, integrationId, post, parsed.source);
      if (outcome === "imported") imported += 1;
      else updated += 1;
    }
    db.prepare(`
      UPDATE sync_runs SET status = 'completed', completed_at = ?,
        imported_count = ?, updated_count = ? WHERE id = ?
    `).run(new Date().toISOString(), imported, updated, runId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.prepare(`
      UPDATE sync_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?
    `).run(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId);
    throw error;
  }

  return { format: parsed.format, total: parsed.posts.length, imported, updated, skipped, missingSavedAt };
}

export function importXJsonFile(db: AtlasDatabase, file: string, options: XImportOptions = {}): XImportResult {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const size = statSync(file).size;
  if (size > maxBytes) throw new Error(`X bookmark JSON exceeds ${maxBytes} byte limit`);
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid X bookmark JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return importXJson(db, input, options);
}
