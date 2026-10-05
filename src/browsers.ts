import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { refreshResourceFts, type AtlasDatabase } from "./db.ts";

export type BrowserKind = "chromium" | "safari" | "firefox";

export type PlistValue =
  | string
  | number
  | boolean
  | null
  | PlistValue[]
  | { [key: string]: PlistValue };

export type BrowserSource = {
  provider: string;
  kind: BrowserKind;
  profile: string;
  path: string;
};

export type BrowserBookmark = {
  externalId: string;
  url: string;
  title: string;
  folderPath: string[];
  addedAt: string | null;
  description: string | null;
};

export type BrowserSyncOptions = {
  provider?: string;
  profile?: string;
  limit?: number;
  // Lets a caller (and the tests) supply the sources instead of scanning the
  // machine, so a fixture can be synced without a browser installed.
  sources?: BrowserSource[];
};

export type BrowserSourceResult = {
  provider: string;
  profile: string;
  kind: BrowserKind;
  read: number;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  error?: string;
};

export type BrowserSyncResult = {
  sources: BrowserSourceResult[];
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
};

// Every Chromium browser writes the same `Bookmarks` JSON, so one reader covers
// all of them. Keys are the provider recorded on the integration; values are the
// path under the platform's application-data directory.
const CHROMIUM_ROOTS: Record<string, Record<string, string>> = {
  darwin: {
    chrome: "Google/Chrome",
    chromium: "Chromium",
    brave: "BraveSoftware/Brave-Browser",
    edge: "Microsoft Edge",
    vivaldi: "Vivaldi",
    arc: "Arc/User Data",
    opera: "com.operasoftware.Opera",
    ego: "Citro Labs/ego lite",
  },
  linux: {
    chrome: "google-chrome",
    chromium: "chromium",
    brave: "BraveSoftware/Brave-Browser",
    edge: "microsoft-edge",
    vivaldi: "vivaldi",
    opera: "opera",
  },
  win32: {
    chrome: "Google/Chrome/User Data",
    chromium: "Chromium/User Data",
    brave: "BraveSoftware/Brave-Browser/User Data",
    edge: "Microsoft/Edge/User Data",
    vivaldi: "Vivaldi/User Data",
    opera: "Opera Software/Opera Stable",
  },
};

// Safari names its own top-level folders after internal identifiers. Anything
// not listed here is kept verbatim; `History` is dropped because it is not a
// bookmark list.
const SAFARI_FOLDER_LABELS: Record<string, string> = {
  BookmarksBar: "Bookmarks bar",
  BookmarksMenu: "Bookmarks menu",
  "com.apple.ReadingList": "Reading List",
};
const SAFARI_SKIP_FOLDERS = new Set(["History"]);

// Firefox names its built-in roots with numeric ids and no title.
const FIREFOX_ROOT_IDS: Record<number, string> = {
  2: "Bookmarks menu",
  3: "Bookmarks toolbar",
  4: "Other bookmarks",
  5: "Mobile bookmarks",
};

// Stripped before the URL becomes a resource key, so the same page bookmarked in
// two browsers lands on one resource. Deliberately conservative: the fragment is
// kept, because plenty of documentation and single-page apps route on it.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_eid$|igshid$|ref_src$|ref_url$)/i;

export function canonicalBookmarkUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function httpOnly(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function chromiumBaseDir(): string | null {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? null;
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function firefoxBaseDir(): string | null {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Firefox");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, "Mozilla", "Firefox") : null;
  }
  return join(homedir(), ".mozilla", "firefox");
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Firefox stores the friendly profile name in profiles.ini; the directory is
// named `<random>.<name>` and reads badly in the palette.
function firefoxProfileNames(base: string): Map<string, string> {
  const names = new Map<string, string>();
  const ini = join(base, "profiles.ini");
  if (!existsSync(ini)) return names;
  try {
    let sectionName: string | null = null;
    const sections = new Map<string, Record<string, string>>();
    for (const line of readFileSync(ini, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        sectionName = trimmed.slice(1, -1);
        sections.set(sectionName, {});
        continue;
      }
      if (!sectionName) continue;
      const equals = trimmed.indexOf("=");
      if (equals < 0) continue;
      const section = sections.get(sectionName);
      if (!section) continue;
      section[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
    }
    for (const values of sections.values()) {
      const path = values.Path;
      const name = values.Name;
      if (path && name) names.set(path.replace(/^Profiles\//, ""), name);
    }
  } catch {
    // A malformed profiles.ini only costs us the friendly name.
  }
  return names;
}

export function discoverBrowserSources(): BrowserSource[] {
  const sources: BrowserSource[] = [];

  const base = chromiumBaseDir();
  const roots = base ? CHROMIUM_ROOTS[process.platform] ?? {} : {};
  for (const [provider, relative] of Object.entries(roots)) {
    const root = join(base as string, relative);
    if (!existsSync(root)) continue;
    for (const profile of safeReaddir(root)) {
      const file = join(root, profile, "Bookmarks");
      if (existsSync(file)) sources.push({ provider, kind: "chromium", profile, path: file });
    }
  }

  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "Safari", "Bookmarks.plist");
    if (existsSync(plist)) {
      sources.push({ provider: "safari", kind: "safari", profile: "Safari", path: plist });
    }
  }

  const firefoxBase = firefoxBaseDir();
  if (firefoxBase && existsSync(firefoxBase)) {
    const profilesDir = existsSync(join(firefoxBase, "Profiles"))
      ? join(firefoxBase, "Profiles")
      : firefoxBase;
    const names = firefoxProfileNames(firefoxBase);
    for (const dir of safeReaddir(profilesDir)) {
      const file = join(profilesDir, dir, "places.sqlite");
      if (existsSync(file)) {
        sources.push({ provider: "firefox", kind: "firefox", profile: names.get(dir) ?? dir, path: file });
      }
    }
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------

// Chrome timestamps are microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function chromeDate(value: unknown): string | null {
  const micros = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(micros) || micros <= 0) return null;
  const milliseconds = micros / 1_000 - CHROME_EPOCH_OFFSET_SECONDS * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function readChromiumBookmarks(file: string): BrowserBookmark[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error("Bookmarks file is not an object");
  const roots = isRecord(parsed.roots) ? parsed.roots : {};
  const out: BrowserBookmark[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (!isRecord(node)) return;
    const children = Array.isArray(node.children) ? node.children : [];
    if (node.type === "url") {
      const url = asString(node.url);
      if (url) {
        out.push({
          externalId: asString(node.guid) ?? asString(node.id) ?? url,
          url,
          title: asString(node.name) ?? url,
          folderPath: path,
          addedAt: chromeDate(node.date_added),
          description: null,
        });
      }
      return;
    }
    const name = asString(node.name);
    const next = name ? [...path, name] : path;
    for (const child of children) walk(child, next);
  };

  for (const root of Object.values(roots)) walk(root, []);
  return out;
}

// ---------------------------------------------------------------------------
// Safari
// ---------------------------------------------------------------------------

// A plist is a small, frozen format: nine element types and no attributes that
// matter. Parsing it here avoids a dependency, and `plutil` (shipped with macOS)
// turns Safari's binary plist into this XML for free.
export function parseXmlPlist(xml: string): PlistValue {
  const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  let index = 0;

  const nameOf = (token: string): string =>
    token.slice(1, -1).replace(/^\//, "").split(/[\s/]/, 1)[0] ?? "";

  const peek = (): string | undefined => tokens[index];

  const text = (): string => {
    let out = "";
    while (true) {
      const token = peek();
      if (token === undefined || token.startsWith("<")) break;
      out += token;
      index += 1;
    }
    if (peek()?.startsWith("</")) index += 1;
    return decodeEntities(out);
  };

  const value = (): PlistValue => {
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === undefined) break;
      if (!token.startsWith("<")) {
        index += 1;
        continue;
      }
      if (token.startsWith("<?") || token.startsWith("<!")) {
        index += 1;
        continue;
      }
      if (token.startsWith("</")) {
        index += 1;
        continue;
      }
      const name = nameOf(token);
      if (name === "plist") {
        index += 1;
        continue;
      }
      index += 1;
      switch (name) {
        case "dict":
          return dict();
        case "array":
          return array();
        case "true":
          return true;
        case "false":
          return false;
        case "integer":
          return Number.parseInt(text(), 10);
        case "real":
          return Number.parseFloat(text());
        case "string":
        case "date":
        case "data":
          return text();
        default:
          return null;
      }
    }
    return null;
  };

  const dict = (): Record<string, PlistValue> => {
    const out: Record<string, PlistValue> = {};
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === undefined) break;
      if (!token.startsWith("<")) {
        index += 1;
        continue;
      }
      if (token.startsWith("</")) {
        index += 1;
        return out;
      }
      if (nameOf(token) !== "key") {
        index += 1;
        continue;
      }
      index += 1;
      out[text()] = value();
    }
    return out;
  };

  const array = (): PlistValue[] => {
    const out: PlistValue[] = [];
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === undefined) break;
      if (!token.startsWith("<")) {
        index += 1;
        continue;
      }
      if (token.startsWith("</")) {
        index += 1;
        return out;
      }
      out.push(value());
    }
    return out;
  };

  return value();
}

function decodeEntities(input: string): string {
  return input.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (match, dec, hex, named) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (named) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return match;
    }
  });
}

function safariDate(node: Record<string, unknown>): string | null {
  const readingList = isRecord(node.ReadingList) ? node.ReadingList : undefined;
  const raw = asString(readingList?.DateAdded) ?? asString(node.DateAdded);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function readSafariBookmarks(file: string): BrowserBookmark[] {
  // `plutil` inherits this process's permissions, so a machine without Full Disk
  // Access fails here rather than in the parse.
  const converted = spawnSync("plutil", ["-convert", "xml1", "-o", "-", file], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (converted.error) {
    throw new Error(`Unable to run plutil: ${converted.error.message}`);
  }
  if (converted.status !== 0) {
    const detail = (converted.stderr || "").trim();
    if (/operation not permitted|not permitted|permission/i.test(detail)) {
      throw new Error(
        "macOS blocked reading Safari's bookmarks. Grant Full Disk Access to your terminal in " +
          "System Settings > Privacy & Security > Full Disk Access, then re-run.",
      );
    }
    throw new Error(`plutil failed${detail ? `: ${detail}` : ""}`);
  }

  const root = parseXmlPlist(converted.stdout);
  const out: BrowserBookmark[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (!isRecord(node)) return;
    if (node.WebBookmarkType === "WebBookmarkTypeLeaf") {
      const url = asString(node.URLString);
      if (!url) return;
      const uri = isRecord(node.URIDictionary) ? node.URIDictionary : {};
      out.push({
        externalId: asString(node.WebBookmarkUUID) ?? url,
        url,
        title: asString(uri.title) ?? asString(node.Title) ?? url,
        folderPath: path,
        addedAt: safariDate(node),
        description: asString(node.previewText),
      });
      return;
    }
    const rawTitle = asString(node.Title);
    const label = rawTitle ? SAFARI_FOLDER_LABELS[rawTitle] ?? rawTitle : null;
    // Skipping the label is not enough: a skipped folder must take its whole
    // subtree with it, or Safari's History becomes imported bookmarks.
    if (label && SAFARI_SKIP_FOLDERS.has(label)) return;
    const next = label ? [...path, label] : path;
    const children = Array.isArray(node.Children) ? node.Children : [];
    for (const child of children) walk(child, next);
  };

  walk(root, []);
  return out;
}

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

export function readFirefoxBookmarks(file: string): BrowserBookmark[] {
  // Firefox holds the database open while it runs, and a read-only connection to
  // a WAL database still needs the -shm file. Copying first sidesteps the lock.
  const directory = mkdtempSync(join(tmpdir(), "bookmark-atlas-firefox-"));
  const copy = join(directory, "places.sqlite");
  try {
    copyFileSync(file, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    }

    const db = new DatabaseSync(copy);
    try {
      const folders = new Map<number, { parent: number | null; title: string | null }>();
      for (const row of db.prepare("SELECT id, parent, title FROM moz_bookmarks WHERE type = 2").all()) {
        folders.set(Number(row.id), {
          parent: row.parent === null ? null : Number(row.parent),
          title: asString(row.title),
        });
      }

      const pathFor = (parent: number | null): string[] => {
        const path: string[] = [];
        let current = parent;
        let guard = 0;
        while (current !== null && guard < 64) {
          const folder = folders.get(current);
          if (!folder) break;
          // A folder's own title always wins. The ids below are the built-in
          // roots, which have no title of their own — but a named folder must
          // never be relabelled just because it shares a number with one.
          const label = folder.title ?? FIREFOX_ROOT_IDS[current];
          if (label) path.push(label);
          current = folder.parent;
          guard += 1;
        }
        return path.reverse();
      };

      const out: BrowserBookmark[] = [];
      const rows = db
        .prepare(`
          SELECT b.id, b.title, b.guid, b.dateAdded, b.parent, p.url
          FROM moz_bookmarks b
          JOIN moz_places p ON p.id = b.fk
          WHERE b.type = 1 AND p.url IS NOT NULL
        `)
        .all();
      for (const row of rows) {
        const url = asString(row.url);
        if (!url) continue;
        const added = Number(row.dateAdded);
        out.push({
          externalId: asString(row.guid) ?? String(row.id),
          url,
          title: asString(row.title) ?? url,
          folderPath: pathFor(row.parent === null ? null : Number(row.parent)),
          addedAt: Number.isFinite(added) && added > 0 ? new Date(added / 1_000).toISOString() : null,
          description: null,
        });
      }
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readBrowserSource(source: BrowserSource): BrowserBookmark[] {
  switch (source.kind) {
    case "chromium":
      return readChromiumBookmarks(source.path);
    case "safari":
      return readSafariBookmarks(source.path);
    case "firefox":
      return readFirefoxBookmarks(source.path);
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function syncBrowserBookmarks(db: AtlasDatabase, options: BrowserSyncOptions = {}): BrowserSyncResult {
  const all = options.sources ?? discoverBrowserSources();
  const selected = all.filter(
    (source) =>
      (!options.provider || source.provider === options.provider) &&
      (!options.profile || source.profile === options.profile),
  );

  const result: BrowserSyncResult = { sources: [], imported: 0, updated: 0, removed: 0, skipped: 0 };
  const now = new Date().toISOString();

  for (const source of selected) {
    const summary: BrowserSourceResult = {
      provider: source.provider,
      profile: source.profile,
      kind: source.kind,
      read: 0,
      imported: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
    };
    result.sources.push(summary);

    let bookmarks: BrowserBookmark[];
    try {
      bookmarks = readBrowserSource(source);
    } catch (error) {
      // A source we could not read must not be reconciled: an unreadable Safari
      // plist would otherwise look like every bookmark having been deleted.
      summary.error = error instanceof Error ? error.message : String(error);
      continue;
    }

    const usable = bookmarks.filter((bookmark) => httpOnly(bookmark.url));
    summary.skipped = bookmarks.length - usable.length;
    summary.read = usable.length;
    result.skipped += summary.skipped;

    const limited = options.limit ? usable.slice(0, options.limit) : usable;

    db.prepare(`
      INSERT INTO integrations (provider, account, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(provider, account) DO UPDATE SET updated_at = excluded.updated_at
    `).run(source.provider, source.profile, now, now);
    const integrationId = Number(
      (db.prepare("SELECT id FROM integrations WHERE provider = ? AND account = ?").get(
        source.provider,
        source.profile,
      ) as { id: number }).id,
    );

    const insertResource = db.prepare(`
      INSERT INTO resources (
        canonical_url, resource_type, title, description, availability_status, created_at, updated_at
      ) VALUES (?, 'web_page', ?, ?, 'available', ?, ?)
      ON CONFLICT(canonical_url) DO UPDATE SET
        title = excluded.title,
        description = COALESCE(excluded.description, resources.description),
        availability_status = 'available',
        updated_at = excluded.updated_at
    `);
    const selectResource = db.prepare("SELECT id FROM resources WHERE canonical_url = ?");
    const insertSave = db.prepare(`
      INSERT INTO saves (
        integration_id, provider_external_id, resource_id, saved_at,
        provider_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_id, provider_external_id) DO UPDATE SET
        resource_id = excluded.resource_id,
        saved_at = excluded.saved_at,
        provider_metadata = excluded.provider_metadata,
        unsaved_at = NULL,
        updated_at = excluded.updated_at
    `);

    // Read the integration's saves once, and use them for both questions the
    // loop asks: is this bookmark new, and which bookmarks went away.
    const existingSaves = db
      .prepare("SELECT id, provider_external_id, unsaved_at FROM saves WHERE integration_id = ?")
      .all(integrationId) as Array<{ id: number; provider_external_id: string; unsaved_at: string | null }>;
    const knownIds = new Set(existingSaves.map((save) => save.provider_external_id));

    const seen = new Set<string>();
    db.exec("BEGIN");
    try {
      for (const bookmark of limited) {
        const url = canonicalBookmarkUrl(bookmark.url);
        const metadata = JSON.stringify({
          browser: source.provider,
          profile: source.profile,
          folder: bookmark.folderPath.join("/"),
        });
        insertResource.run(url, bookmark.title, bookmark.description, now, now);
        const resourceId = Number((selectResource.get(url) as { id: number }).id);
        insertSave.run(
          integrationId,
          bookmark.externalId,
          resourceId,
          bookmark.addedAt,
          metadata,
          now,
          now,
        );
        refreshResourceFts(db, resourceId);
        seen.add(bookmark.externalId);
        if (knownIds.has(bookmark.externalId)) summary.updated += 1;
        else summary.imported += 1;
      }

      // Reconciliation is skipped when a limit is in play: the bookmarks we did
      // not look at are not bookmarks that went away.
      if (!options.limit) {
        const markRemoved = db.prepare("UPDATE saves SET unsaved_at = ?, updated_at = ? WHERE id = ?");
        for (const save of existingSaves) {
          if (save.unsaved_at !== null || seen.has(save.provider_external_id)) continue;
          markRemoved.run(now, now, save.id);
          summary.removed += 1;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    result.imported += summary.imported;
    result.updated += summary.updated;
    result.removed += summary.removed;
  }

  return result;
}
