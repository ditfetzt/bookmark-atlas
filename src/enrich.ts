import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atlasDataDir, refreshResourceFts, type AtlasDatabase } from "./db.ts";
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
  fetchImpl?: typeof fetch;
  token?: string;
  /** Per-request timeout, used by the web page fetcher. */
  timeoutMs?: number;
  /**
   * Ignore the stored ETag and fetch the body again. Needed to backfill
   * something new out of a body that was already read once — the preview
   * image, for instance, which a 304 would otherwise never reveal.
   */
  refresh?: boolean;
};

export type EnrichResult = {
  selected: number;
  enriched: number;
  unchanged: number;
  missing: number;
  failed: number;
};

const API_VERSION = "2026-03-10";

// A real, honest User-Agent. Sites that block unknown clients are within their
// rights to; announcing what this is gives them something to allow.
const USER_AGENT = "bookmark-atlas (+https://github.com/ditfetzt/bookmark-atlas)";

// Below this, a page yielded nothing worth indexing: a JavaScript shell, a
// consent wall, a PDF served as HTML. Storing it would tell search there is
// content on a page where there is none.
const MIN_USEFUL_CHARS = 200;

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
  // Ordered by when each was last looked at, not by whether it succeeded. A
  // failed fetch never records a success, so ordering on success would put the
  // same failures at the front of every batch and a `--limit` run would never
  // reach the pages behind them.
  return db.prepare(`
    SELECT g.resource_id AS resourceId, g.owner, g.name, f.etag
    FROM github_repositories g
    JOIN saves s ON s.resource_id = g.resource_id AND s.unsaved_at IS NULL
    LEFT JOIN resource_fetch_state f
      ON f.resource_id = g.resource_id AND f.kind = 'github_readme'
    GROUP BY g.resource_id
    ORDER BY
      CASE WHEN f.last_checked_at IS NULL THEN 0 ELSE 1 END,
      f.last_checked_at ASC,
      MAX(s.saved_at) DESC
    LIMIT ?
  `).all(limit) as RepositoryTarget[];
}

type FetchTarget = { resourceId: number; etag: string | null };

/** What the palette can draw. Anything else — an SVG logo, an AVIF, a video — is
 * stored as no preview at all rather than as a file that renders as a blank row. */
const RENDERABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function imagesDir(): string {
  return join(atlasDataDir(), "images");
}

/**
 * Download one preview image and remember where it landed.
 *
 * A picture is a nicety: every failure here is silent and returns false, because
 * a dead image URL must never turn a successful page fetch into a failed one.
 */
async function saveResourceImage(
  db: AtlasDatabase,
  resourceId: number,
  imageUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetchImpl(imageUrl, {
      headers: { Accept: "image/*", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
    if (!RENDERABLE_IMAGE_TYPES.has(contentType)) return false;

    const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (declared > MAX_IMAGE_BYTES) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return false;

    const extension = contentType.slice("image/".length).replace("jpeg", "jpg");
    const file = join(imagesDir(), `${resourceId}-${hash(imageUrl).slice(0, 16)}.${extension}`);
    mkdirSync(imagesDir(), { recursive: true });
    writeFileSync(file, bytes);

    db.prepare(`
      INSERT INTO resource_images (
        resource_id, source_url, local_path, content_type, byte_size, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_id) DO UPDATE SET
        source_url = excluded.source_url,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        byte_size = excluded.byte_size,
        fetched_at = excluded.fetched_at
    `).run(resourceId, imageUrl, file, contentType, bytes.byteLength, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

function saveFetchState(
  db: AtlasDatabase,
  target: FetchTarget,
  kind: string,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id, kind) DO UPDATE SET
      etag = COALESCE(excluded.etag, resource_fetch_state.etag),
      status = excluded.status,
      last_checked_at = excluded.last_checked_at,
      last_success_at = COALESCE(excluded.last_success_at, resource_fetch_state.last_success_at),
      error_message = excluded.error_message
  `).run(
    target.resourceId,
    kind,
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
  timeoutMs: number,
  refresh: boolean,
): Promise<"enriched" | "unchanged" | "missing" | "failed"> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
  };
  if (target.etag && !refresh) headers["If-None-Match"] = target.etag;
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/readme`;

  try {
    const response = await fetchImpl(url, { headers });
    if (response.status === 304) {
      saveFetchState(db, target, "github_readme", { status: "unchanged", success: true });
      return "unchanged";
    }
    if (response.status === 404) {
      saveFetchState(db, target, "github_readme", { status: "missing" });
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
      saveFetchState(db, target, "github_readme", {
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

    // After the commit, never inside it: the image is a second request over the
    // network, and holding a write transaction open across it would block every
    // other enrichment running beside this one.
    const imageUrl = readmeImageUrl(content, target.owner, target.name);
    if (imageUrl) await saveResourceImage(db, target.resourceId, imageUrl, fetchImpl, timeoutMs);
    return "enriched";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveFetchState(db, target, "github_readme", { status: "failed", error: message });
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
  const maxBytes = 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const refresh = options.refresh === true;
  const outcomes: Array<"enriched" | "unchanged" | "missing" | "failed"> = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < selected.length) {
      const target = selected[next];
      next += 1;
      if (!target) break;
      outcomes.push(await enrichOne(db, target, fetchImpl, token, maxBytes, timeoutMs, refresh));
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

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

/**
 * The named entities worth knowing. Numeric ones are handled separately, and
 * anything missing is left as written rather than dropped, so an unknown entity
 * shows up as `&foo;` instead of silently vanishing from the text.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  dagger: "†",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  minus: "−",
  frac12: "½",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  szlig: "ß",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // fromCodePoint throws outside the Unicode range, and a malformed entity
      // should survive as text rather than take the whole page down.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Elements whose contents are never readable text. */
const DROPPED_ELEMENTS =
  /<(script|style|noscript|template|svg|iframe|object|embed|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Block-level elements become line breaks, so paragraphs do not run together
 * into one unreadable line. Without this, a page's whole body is a single blob.
 */
const BLOCK_ELEMENTS =
  /<\/?(?:p|div|br|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|h[1-6]|section|article|header|footer|nav|aside|blockquote|pre|figure|figcaption|hr|form|main|details|summary|address)\b[^>]*>/gi;

export type ExtractedPage = {
  title: string | null;
  description: string | null;
  text: string;
  imageUrl: string | null;
};

function metaContent(html: string, name: string): string | null {
  // Attribute order varies between sites, so find the tag by its name and then
  // take the content from anywhere inside it.
  const tag = new RegExp(`<meta\\b[^>]*?(?:name|property)=["']${name}["'][^>]*>`, "i").exec(html)?.[0];
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  if (!content) return null;
  return decodeEntities(content).replace(/\s+/g, " ").trim() || null;
}

function linkHref(html: string, rel: string): string | null {
  const tag = new RegExp(`<link\\b[^>]*?rel=["']${rel}["'][^>]*>`, "i").exec(html)?.[0];
  return tag ? (/href=["']([^"']*)["']/i.exec(tag)?.[1] ?? null) : null;
}

/**
 * The image a page offers as its own preview, resolved to an absolute URL.
 * `og:image` is the one that matters; the rest are the fallbacks sites use when
 * they have no Open Graph tags. An SVG is skipped because it is almost always a
 * logo, and nothing here can draw one.
 */
export function pageImageUrl(html: string, pageUrl: string): string | null {
  const raw =
    metaContent(html, "og:image") ??
    metaContent(html, "og:image:url") ??
    metaContent(html, "twitter:image") ??
    metaContent(html, "twitter:image:src") ??
    linkHref(html, "image_src");
  return resolveImageUrl(raw, pageUrl);
}

function resolveImageUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  if (/^(?:data|blob|javascript):/i.test(raw)) return null;
  let resolved: URL;
  try {
    resolved = new URL(decodeEntities(raw), base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  if (resolved.pathname.toLowerCase().endsWith(".svg")) return null;
  return resolved.toString();
}

/**
 * Badge and chart hosts. A README's first images are its build badges, and a
 * row of shields.io pills is the last thing worth showing as a preview.
 */
const BADGE_HOSTS = new Set([
  "img.shields.io",
  "shields.io",
  "badge.fury.io",
  "badgen.net",
  "badge.buildkite.com",
  "codecov.io",
  "coveralls.io",
  "travis-ci.org",
  "travis-ci.com",
  "circleci.com",
  "app.codacy.com",
  "api.codacy.com",
  "david-dm.org",
  "snyk.io",
  "packagephobia.com",
  "bundlephobia.com",
  "img.badgesize.io",
  "sonarcloud.io",
  "opencollective.com",
  "isitmaintained.com",
  "deepscan.io",
  "star-history.com",
  "komarev.com",
  "visitor-badge.laobi.icu",
  "libraries.io",
  "www.bestpractices.dev",
  "api.securityscorecards.dev",
]);

/**
 * The first image a README actually illustrates itself with. Both markdown and
 * raw `<img>` are matched in one pass so the winner is the one that appears
 * first in the document, not the one in the form we happen to look for first.
 */
export function readmeImageUrl(markdown: string, owner: string, name: string): string | null {
  const base = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/`;
  const pattern = /!\[[^\]]*\]\(\s*([^)\s]+)|<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
  for (const match of markdown.matchAll(pattern)) {
    const url = resolveImageUrl(match[1] ?? match[2] ?? null, base);
    if (!url) continue;
    try {
      if (BADGE_HOSTS.has(new URL(url).hostname.toLowerCase())) continue;
    } catch {
      continue;
    }
    return url;
  }
  return null;
}

/**
 * The readable text of a page, without a dependency.
 *
 * Deliberately not a real HTML parser: it strips what is never text, turns block
 * boundaries into newlines, and drops the rest of the markup. That is enough for
 * articles, documentation and changelogs, and it costs nothing to run over a
 * thousand pages. Pages that build themselves in JavaScript yield almost
 * nothing, which is what `MIN_USEFUL_CHARS` is there to detect.
 */
export function extractPage(html: string, pageUrl = ""): ExtractedPage {
  const title =
    metaContent(html, "og:title") ??
    (() => {
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (!match?.[1]) return null;
      return decodeEntities(match[1]).replace(/\s+/g, " ").trim() || null;
    })();
  const description = metaContent(html, "description") ?? metaContent(html, "og:description");

  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(DROPPED_ELEMENTS, " ")
      .replace(BLOCK_ELEMENTS, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, description, text, imageUrl: pageUrl ? pageImageUrl(html, pageUrl) : null };
}

type WebPageTarget = {
  resourceId: number;
  url: string;
  etag: string | null;
};

export type WebPageEnrichResult = {
  selected: number;
  enriched: number;
  unchanged: number;
  /** Fetched, but the page had no readable text: a JavaScript shell, a PDF, an image. */
  empty: number;
  failed: number;
};

function webPageTargets(db: AtlasDatabase, limit: number): WebPageTarget[] {
  // Ordered by when each was last looked at, so a batch makes progress. A page
  // that failed records no success, and ordering on success would put the same
  // failures at the front of every batch.
  return db.prepare(`
    SELECT r.id AS resourceId, r.canonical_url AS url, f.etag
    FROM resources r
    JOIN saves s ON s.resource_id = r.id AND s.unsaved_at IS NULL
    LEFT JOIN resource_fetch_state f
      ON f.resource_id = r.id AND f.kind = 'web_page'
    WHERE r.resource_type = 'web_page'
    GROUP BY r.id
    ORDER BY
      CASE WHEN f.last_checked_at IS NULL THEN 0 ELSE 1 END,
      f.last_checked_at ASC,
      MAX(s.saved_at) DESC
    LIMIT ?
  `).all(limit) as WebPageTarget[];
}

type PageFetch =
  | { kind: "unchanged" }
  | { kind: "not-text"; detail: string }
  | { kind: "too-thin"; detail: string }
  | { kind: "ok"; content: string; etag: string | null; imageUrl: string | null }
  | { kind: "failed"; detail: string };

/**
 * One attempt at reading a page. It reports what happened instead of recording
 * it, so a blocked page can be retried against the archive before anything is
 * written down.
 */
async function fetchPage(
  url: string,
  etag: string | null,
  fetchImpl: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  refresh: boolean,
): Promise<PageFetch> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": USER_AGENT,
  };
  if (etag && !refresh) headers["If-None-Match"] = etag;

  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304) return { kind: "unchanged" };
    if (!response.ok) return { kind: "failed", detail: `HTTP ${response.status} ${response.statusText}` };

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("text/plain")) {
      // A PDF, an image, a JSON endpoint: there is no page here to read.
      return { kind: "not-text", detail: `content-type: ${contentType || "unknown"}` };
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (declaredLength > maxBytes) return { kind: "failed", detail: `page exceeds ${maxBytes} byte limit` };
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      return { kind: "failed", detail: `page exceeds ${maxBytes} byte limit` };
    }

    // Title and description first: on a thin page they are most of what there is.
    const page = extractPage(body, url);
    const content = [page.title, page.description, page.text].filter(Boolean).join("\n\n").trim();
    if (content.length < MIN_USEFUL_CHARS) {
      return { kind: "too-thin", detail: `only ${content.length} characters of readable text` };
    }
    return {
      kind: "ok",
      content,
      etag: response.headers.get("etag"),
      imageUrl: page.imageUrl,
    };
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The newest snapshot of a page in the Wayback Machine, or null if it has none.
 * A block is usually aimed at the visitor, not the page, so a site that turns
 * this away often still reads fine from the archive.
 */
async function waybackSnapshot(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string } };
    };
    const closest = body.archived_snapshots?.closest;
    return closest?.available && closest.url ? closest.url : null;
  } catch {
    return null;
  }
}

async function enrichWebPage(
  db: AtlasDatabase,
  target: WebPageTarget,
  fetchImpl: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  refresh: boolean,
): Promise<"enriched" | "unchanged" | "empty" | "failed"> {
  let sourceUrl = target.url;
  let etag = target.etag;
  let result = await fetchPage(target.url, target.etag, fetchImpl, maxBytes, timeoutMs, refresh);
  if (result.kind === "ok") etag = result.etag;

  if (result.kind === "failed" || result.kind === "too-thin") {
    const snapshot = await waybackSnapshot(fetchImpl, target.url, timeoutMs);
    if (snapshot) {
      const archived = await fetchPage(snapshot, null, fetchImpl, maxBytes, timeoutMs, false);
      if (archived.kind === "ok") {
        result = archived;
        sourceUrl = snapshot;
      } else if (archived.kind === "failed") {
        result = { ...result, detail: `${result.detail}; archive: ${archived.detail}` };
      }
    }
  }

  if (result.kind === "unchanged") {
    saveFetchState(db, target, "web_page", { status: "unchanged", success: true });
    return "unchanged";
  }
  if (result.kind === "not-text") {
    saveFetchState(db, target, "web_page", { status: "not-text", error: result.detail });
    return "empty";
  }
  if (result.kind === "too-thin") {
    saveFetchState(db, target, "web_page", { status: "empty", error: result.detail });
    return "empty";
  }
  if (result.kind === "failed") {
    saveFetchState(db, target, "web_page", { status: "failed", error: result.detail });
    return "failed";
  }

  {
    const content = result.content;
    const contentHash = hash(content);
    const fetchedAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO captures (
          resource_id, kind, source_url, fetched_at, content_hash, normalized_content
        ) VALUES (?, 'web_page', ?, ?, ?, ?)
        ON CONFLICT(resource_id, kind, content_hash) DO UPDATE SET
          fetched_at = excluded.fetched_at
      `).run(target.resourceId, sourceUrl, fetchedAt, contentHash, content);
      const capture = db
        .prepare(
          "SELECT id FROM captures WHERE resource_id = ? AND kind = 'web_page' AND content_hash = ?",
        )
        .get(target.resourceId, contentHash) as { id: number };

      db.prepare("DELETE FROM chunks WHERE capture_id = ?").run(capture.id);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (capture_id, ordinal, text, token_count, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [ordinal, chunk] of chunkMarkdown(content).entries()) {
        insertChunk.run(capture.id, ordinal, chunk, Math.ceil(chunk.length / 4), hash(chunk));
      }
      saveFetchState(db, target, "web_page", {
        etag,
        status: sourceUrl === target.url ? "available" : "archived",
        success: true,
      });
      refreshResourceFts(db, target.resourceId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      saveFetchState(db, target, "web_page", { status: "failed", error: message });
      return "failed";
    }
    // After the commit: the image is another network round trip, and a write
    // transaction held across it would block every other page being fetched.
    if (result.imageUrl) {
      await saveResourceImage(db, target.resourceId, result.imageUrl, fetchImpl, timeoutMs);
    }
    return "enriched";
  }
}

/**
 * Fetch and index the text behind browser bookmarks.
 *
 * Batches are the point: `--limit` with the ordering above walks the collection
 * once, so a run of 25 costs 25 fetches and the next run continues where this
 * one stopped instead of retrying its failures forever.
 */
export async function enrichWebPages(
  db: AtlasDatabase,
  options: EnrichOptions = {},
): Promise<WebPageEnrichResult> {
  const limit = options.limit ?? 25;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const refresh = options.refresh === true;
  const selected = webPageTargets(db, limit);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = 2 * 1024 * 1024;
  const outcomes: Array<"enriched" | "unchanged" | "empty" | "failed"> = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < selected.length) {
      const target = selected[next];
      next += 1;
      if (!target) break;
      outcomes.push(await enrichWebPage(db, target, fetchImpl, maxBytes, timeoutMs, refresh));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    selected: selected.length,
    enriched: outcomes.filter((value) => value === "enriched").length,
    unchanged: outcomes.filter((value) => value === "unchanged").length,
    empty: outcomes.filter((value) => value === "empty").length,
    failed: outcomes.filter((value) => value === "failed").length,
  };
}
