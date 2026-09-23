import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { refreshResourceFts, type AtlasDatabase } from "./db.ts";
import { chunkMarkdown } from "./enrich.ts";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type JsonNode = JsonObject | string | number | boolean | null | JsonNode[];

export type XImportOptions = {
  account?: string;
  tweetxvaultDir?: string;
  /** Mark active saves missing from this import as unsaved. Use for a full collection import. */
  reconcile?: boolean;
};

export type XImportResult = {
  format: "siftly-native" | "siftly-export" | "tweetxvault" | "x-api-v2";
  total: number;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  missingSavedAt: number;
};

type NormalizedArticle = { title: string | null; body: string };

type NormalizedLink = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
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
  article: NormalizedArticle | null;
  links: NormalizedLink[];
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

function nested(root: unknown, ...keys: string[]): JsonNode | undefined {
  let current: unknown = root;
  for (const key of keys) {
    const value = object(current);
    if (!value) return undefined;
    current = value[key];
  }
  return current as JsonNode | undefined;
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function normalizeArticle(value: unknown): NormalizedArticle | null {
  const article = object(value);
  if (!article) return null;
  const title = string(article.title);
  const body = [string(article.summary_text), string(article.content_text)]
    .filter((part): part is string => part !== null)
    .join("\n\n")
    .trim();
  if (!title && !body) return null;
  return { title, body };
}

function normalizeLinks(value: unknown): NormalizedLink[] {
  if (!Array.isArray(value)) return [];
  const links: NormalizedLink[] = [];
  for (const candidate of value) {
    const item = object(candidate);
    if (!item) continue;
    const resolved = object(item.resolved);
    const url =
      string(resolved?.canonical_url) ??
      string(resolved?.final_url) ??
      string(item.canonical_url) ??
      string(item.expanded_url) ??
      string(item.url);
    if (!url) continue;
    links.push({
      url,
      title: string(resolved?.title),
      description: string(resolved?.description),
      siteName: string(resolved?.site_name),
    });
  }
  return links;
}

/**
 * Author details live in different places depending on the payload: a native
 * tweet nests them under core.user_results.result, a flattened export may keep a
 * screen_name at the top level. Both are checked.
 */
function rawAuthor(raw: JsonObject): { handle: string | null; name: string | null } {
  const user = object(nested(raw, "core", "user_results", "result"));
  const legacy = object(user?.legacy);
  const core = object(user?.core);
  const flat = object(raw.legacy);
  return {
    handle: string(legacy?.screen_name) ?? string(core?.screen_name) ?? string(flat?.screen_name),
    name: string(legacy?.name) ?? string(core?.name) ?? string(flat?.name),
  };
}

function nativeArticle(tweet: JsonObject): NormalizedArticle | null {
  const article = object(nested(tweet, "article", "article_results", "result"));
  if (!article) return null;
  const title = string(article.title);
  let body = string(article.content);
  if (!body) {
    const blocks = nested(article, "content_state", "blocks");
    if (Array.isArray(blocks)) {
      body = blocks
        .map((block) => string(object(block)?.text))
        .filter((value): value is string => value !== null)
        .join("\n\n");
    }
  }
  if (!title && !body) return null;
  return { title, body: body ?? "" };
}

function defaultTweetXVaultDir(): string {
  if (process.env.BOOKMARK_ATLAS_TWEETXVAULT_DIR) return process.env.BOOKMARK_ATLAS_TWEETXVAULT_DIR;
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "tweetxvault")
    : join(homedir(), ".local", "share", "tweetxvault");
}

function resolveMediaPath(baseDir: string, localPath: string | null): string | null {
  return localPath ? resolve(baseDir, localPath) : null;
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
  const author = rawAuthor(tweet);
  return {
    id,
    text: nativeText(tweet),
    authorId: string(user?.rest_id),
    authorHandle: author.handle,
    authorName: author.name,
    language: string(nested(tweet, "legacy", "lang")),
    postCreatedAt: validDate(nested(tweet, "legacy", "created_at")),
    savedAt: null,
    conversationId: string(nested(tweet, "legacy", "conversation_id_str")),
    media: nativeMedia(tweet),
    outboundUrls: entityUrls(tweet),
    article: nativeArticle(tweet),
    links: entityUrls(tweet).map((url) => ({ url, title: null, description: null, siteName: null })),
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
    article: null,
    links: [],
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
  const rawLegacy = object(raw?.legacy);
  const rawAuthorDetail = rawAuthor(raw);
  const text = string(bookmark.text) ?? string(bookmark.full_text) ?? string(bookmark.content) ?? string(rawLegacy?.full_text) ?? "";
  const urlValues = [bookmark.urls, bookmark.outbound_urls, bookmark.outboundUrls]
    .flatMap((value) => Array.isArray(value) ? value : [value]);
  const outboundUrls = uniqueStrings(urlValues.flatMap((value) => {
    const item = object(value);
    return item ? [item.expanded_url, item.unwound_url, item.url] : [value];
  }));
  return {
    id,
    text,
    authorId: string(bookmark.author_id) ?? string(bookmark.authorId),
    authorHandle: string(bookmark.author_username) ?? string(bookmark.author_handle) ?? string(bookmark.authorHandle) ?? rawAuthorDetail.handle,
    authorName: string(bookmark.author_display_name) ?? string(bookmark.author_name) ?? string(bookmark.authorName) ?? rawAuthorDetail.name,
    language: string(bookmark.lang) ?? string(bookmark.language),
    postCreatedAt: validDate(bookmark.created_at) ?? validDate(bookmark.post_created_at) ?? validDate(bookmark.tweetCreatedAt),
    savedAt: validDate(bookmark.added_at) ?? validDate(bookmark.captured_at) ?? validDate(bookmark.saved_at) ?? validDate(bookmark.importedAt),
    conversationId: string(bookmark.conversation_id) ?? string(bookmark.conversationId),
    media,
    outboundUrls,
    article: normalizeArticle(bookmark.article),
    links: normalizeLinks(bookmark.urls),
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
    article: null,
    links: [],
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
  // An X article post's own text is often just a t.co link, so the article's own
  // title is what a reader recognises in a list.
  const articleTitle = (post.article?.title ?? "").replace(/\s+/g, " ").trim();
  if (articleTitle) return articleTitle.slice(0, 240);
  const oneLine = post.text.replace(/\s+/g, " ").trim();
  const prefix = post.authorHandle ? `@${post.authorHandle}: ` : "X post: ";
  return `${prefix}${oneLine || post.id}`.slice(0, 240);
}

function description(post: NormalizedPost): string {
  if (post.text.trim()) return post.text.slice(0, 2_000);
  return "Posttext wurde von X in diesem Browser-Capture nicht mitgeliefert. Der Original-Post ist über den Link erreichbar.";
}

function canonicalUrl(post: NormalizedPost): string {
  return `https://x.com/i/web/status/${post.id}`;
}

function storeCapture(
  db: AtlasDatabase,
  resourceId: number,
  kind: string,
  sourceUrl: string,
  text: string,
  now: string,
): void {
  const contentHash = hash(text);
  db.prepare(`
    INSERT INTO captures (resource_id, kind, source_url, fetched_at, content_hash, normalized_content)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, kind, content_hash) DO UPDATE SET fetched_at = excluded.fetched_at
  `).run(resourceId, kind, sourceUrl, now, contentHash, text);
  const capture = db.prepare(`
    SELECT id FROM captures WHERE resource_id = ? AND kind = ? AND content_hash = ?
  `).get(resourceId, kind, contentHash) as { id: number };
  db.prepare("DELETE FROM chunks WHERE capture_id = ?").run(capture.id);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (capture_id, ordinal, text, token_count, content_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [ordinal, chunk] of chunkMarkdown(text).entries()) {
    insertChunk.run(capture.id, ordinal, chunk, Math.ceil(chunk.length / 4), hash(chunk));
  }
}

function persistMedia(db: AtlasDatabase, resourceId: number, media: JsonObject[], baseDir: string): void {
  db.prepare("DELETE FROM x_media WHERE resource_id = ?").run(resourceId);
  const insert = db.prepare(`
    INSERT INTO x_media (
      resource_id, media_key, type, source, article_id, position, url, thumbnail_url,
      width, height, duration_millis, local_path, content_type, byte_size, sha256, download_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  media.forEach((item, index) => {
    const download = object(item.download);
    const localPath = string(download?.local_path);
    insert.run(
      resourceId,
      string(item.media_key) ?? `${string(item.type) ?? "media"}-${index}`,
      string(item.type) ?? "unknown",
      string(item.source),
      string(item.article_id),
      numberOrNull(item.position) ?? index,
      string(item.url),
      string(item.thumbnail_url),
      numberOrNull(item.width),
      numberOrNull(item.height),
      numberOrNull(item.duration_millis),
      resolveMediaPath(baseDir, localPath),
      string(download?.content_type),
      numberOrNull(download?.byte_size),
      string(download?.sha256),
      string(download?.state),
    );
  });
}

function importPost(
  db: AtlasDatabase,
  integrationId: number,
  post: NormalizedPost,
  source: string,
  mediaBaseDir: string,
): "imported" | "updated" {
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
    `).run(url, title(post), post.authorHandle ?? post.authorName, description(post), post.language, now, resourceId);
  } else {
    db.prepare(`
      INSERT INTO resources (
        canonical_url, resource_type, title, author, description, language,
        availability_status, created_at, updated_at
      ) VALUES (?, 'x_post', ?, ?, ?, ?, 'available', ?, ?)
    `).run(url, title(post), post.authorHandle ?? post.authorName, description(post), post.language, now, now);
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

  persistMedia(db, resource, post.media, mediaBaseDir);
  storeCapture(db, resource, "x_post", url, post.text, now);
  if (post.article) {
    const articleText = [post.article.title, post.article.body].filter(Boolean).join("\n\n").trim();
    if (articleText) storeCapture(db, resource, "x_article", url, articleText, now);
  }
  if (post.links.length) {
    const linkText = post.links
      .map((link) => [link.title, link.description, link.url].filter(Boolean).join(" — "))
      .join("\n\n")
      .trim();
    if (linkText) storeCapture(db, resource, "x_link", url, linkText, now);
  }
  refreshResourceFts(db, resource);
  return existing || existingUrl ? "updated" : "imported";
}

export function importXJson(db: AtlasDatabase, input: unknown, options: XImportOptions = {}): XImportResult {
  const parsed = parseInput(input);
  const integrationId = ensureIntegration(db, options.account ?? "json-import");
  const mediaBaseDir = options.tweetxvaultDir ?? defaultTweetXVaultDir();
  const startedAt = new Date().toISOString();
  const runId = Number(db.prepare(`
    INSERT INTO sync_runs (integration_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(integrationId, startedAt).lastInsertRowid);
  let imported = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;
  let missingSavedAt = 0;
  const seen = new Set<string>();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const post of parsed.posts) {
      if (!post) {
        skipped += 1;
        continue;
      }
      seen.add(post.id);
      if (!post.savedAt) missingSavedAt += 1;
      const outcome = importPost(db, integrationId, post, parsed.source, mediaBaseDir);
      if (outcome === "imported") imported += 1;
      else updated += 1;
    }
    if (options.reconcile) {
      const active = db
        .prepare("SELECT id, provider_external_id FROM saves WHERE integration_id = ? AND unsaved_at IS NULL")
        .all(integrationId) as Array<{ id: number; provider_external_id: string }>;
      const now = new Date().toISOString();
      const markRemoved = db.prepare("UPDATE saves SET unsaved_at = ?, updated_at = ? WHERE id = ?");
      for (const save of active) {
        if (!seen.has(save.provider_external_id)) {
          markRemoved.run(now, now, save.id);
          removed += 1;
        }
      }
    }
    db.prepare(`
      UPDATE sync_runs SET status = 'completed', completed_at = ?,
        imported_count = ?, updated_count = ?, removed_count = ? WHERE id = ?
    `).run(new Date().toISOString(), imported, updated, removed, runId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.prepare(`
      UPDATE sync_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?
    `).run(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId);
    throw error;
  }

  return { format: parsed.format, total: parsed.posts.length, imported, updated, removed, skipped, missingSavedAt };
}

export type RepairResult = { scanned: number; retitled: number; authored: number };

/**
 * Fill in the fields that can be derived from the raw payload already stored in
 * the database: an article post's own title, and the author of the post. Import
 * derives both, but rows written before those rules keep a bare t.co title and a
 * null author, and re-importing them means a full TweetXVault sync. This needs
 * neither the network nor a re-export.
 */
export function repairXPosts(db: AtlasDatabase): RepairResult {
  const rows = db.prepare(`
    SELECT p.resource_id AS id, p.raw_json AS raw, r.title AS currentTitle, r.author AS currentAuthor
    FROM x_posts p JOIN resources r ON r.id = p.resource_id
  `).all() as Array<{ id: number; raw: string | null; currentTitle: string; currentAuthor: string | null }>;
  const updateTitle = db.prepare("UPDATE resources SET title = ?, updated_at = ? WHERE id = ?");
  const updateAuthor = db.prepare("UPDATE resources SET author = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  let retitled = 0;
  let authored = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const raw = jsonObject(row.raw) ?? {};
      const handle = rawAuthor(raw).handle;
      // Both shapes: a native tweet nests the article under article_results.
      const article = nativeArticle(raw) ?? normalizeArticle(raw.article);
      const nextTitle = (article?.title ?? "").replace(/\s+/g, " ").trim();
      let changed = false;
      if (handle && handle !== row.currentAuthor) {
        updateAuthor.run(handle, now, row.id);
        authored += 1;
      }
      if (nextTitle && nextTitle !== row.currentTitle) {
        updateTitle.run(nextTitle.slice(0, 240), now, row.id);
        retitled += 1;
        // Title is an indexed column, so only this branch needs the index refreshed.
        // The author is not part of the full-text index.
        changed = true;
      }
      if (changed) refreshResourceFts(db, row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { scanned: rows.length, retitled, authored };
}

export function importXJsonFile(db: AtlasDatabase, file: string, options: XImportOptions = {}): XImportResult {
  const maxBytes = DEFAULT_MAX_FILE_BYTES;
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
