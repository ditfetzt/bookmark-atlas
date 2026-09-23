/**
 * bookmark-atlas — a search palette for your starred GitHub repos and saved X posts.
 *
 * Usage: /bookmarks [query]
 *
 * Opens an overlay modeled on pi-skill-palette: type to search titles and the
 * captured text of every saved README, post, and article; arrows to
 * navigate, preview shows post/article text and inline images.
 *   enter    insert the bookmark (title, url, content) into the editor
 *   ctrl+y   copy the url
 *   ctrl+o   open the url in the default browser
 *   ctrl+r   fetch new bookmarks (GitHub stars, X posts, READMEs)
 *   ctrl+e   read the full text
 *   ctrl+n   write a note about the selected bookmark
 *   ctrl+t   filter by topic; ctrl+a hide archived; ctrl+d only the last 7 days
 *   esc      close
 *
 * Reads the Bookmark Atlas SQLite database directly (read-only). Override the
 * location with BOOKMARK_ATLAS_DB.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Image,
	Input,
	fuzzyMatch,
	getNativeClipboard,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// Resolve the real path first: when the extension is symlinked into
// ~/.pi/agent/extensions, import.meta.url is the symlink, so relative paths
// would resolve against ~/.pi/agent instead of the repo.
function resolveRepoRoot(): string {
	const modulePath = fileURLToPath(import.meta.url);
	let real = modulePath;
	try {
		real = realpathSync(modulePath);
	} catch {
		// fall back to the unresolved path
	}
	return join(dirname(real), "..", "..");
}

const REPO_ROOT = resolveRepoRoot();
const DB_PATH = process.env.BOOKMARK_ATLAS_DB ?? join(REPO_ROOT, "data", "bookmarks.db");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
// Rows visible in the list; also the jump size for PageUp/PageDown and Cmd+↑/↓.
const LIST_ROWS = 10;
// How far back "recent" reaches, and how many topics the picker will list.
const RECENT_DAYS = 7;
const TOPIC_LIMIT = 60;
const EXCERPT_ROWS = 5;
const IMAGE_ROWS = 10;
// The reading pane trades the list, its separator and the image for more text, so
// the overlay keeps the same height.
const READING_ROWS = LIST_ROWS + 1 + EXCERPT_ROWS + 1 + IMAGE_ROWS;

type RecallHit = {
	id: number;
	title: string;
	url: string;
	whyMatched: string[];
	passage: string | null;
	score: number;
};

const LIST_SQL = `
  SELECT
    r.id, r.title, r.canonical_url AS url, r.author, r.description,
    r.resource_type AS type,
    r.created_at AS createdAt,
    (SELECT MAX(s.saved_at) FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL) AS savedAt,
    (SELECT COUNT(*) FROM x_media m WHERE m.resource_id = r.id AND m.type = 'photo') AS photos,
    (SELECT COUNT(*) FROM x_media m WHERE m.resource_id = r.id AND m.type = 'video') AS videos,
    n.context AS context,
    g.stars AS stars,
    COALESCE(g.archived, 0) AS archived,
    g.topics AS topics,
    COALESCE(u.use_count, 0) AS useCount
  FROM resources r
  LEFT JOIN resource_notes n ON n.resource_id = r.id
  LEFT JOIN github_repositories g ON g.resource_id = r.id
  LEFT JOIN bookmark_usage u ON u.resource_id = r.id
`;

type Bookmark = {
	id: number;
	title: string;
	url: string;
	author: string | null;
	description: string | null;
	type: string;
	createdAt: string | null;
	savedAt: string | null;
	photos: number;
	videos: number;
	context: string | null;
	stars: number | null;
	archived: number;
	topics: string | null;
	useCount: number;
};

/** Which source a bookmark came from. */
type SourceFilter = "all" | "github" | "x";

function sourceOf(bookmark: Bookmark): "github" | "x" {
	return bookmark.type === "x_post" ? "x" : "github";
}

/**
 * When a bookmark was saved. X bookmarks have no save date from TweetXVault, so
 * they fall back to when this database first saw them — the same fallback the
 * base ordering uses, which keeps the date sorts and the base order agreeing.
 */
function savedOn(bookmark: Bookmark): string {
	return bookmark.savedAt ?? bookmark.createdAt ?? "";
}

/** Compact star count for the list column, e.g. 12345 -> "★ 12.3k". */
function formatStars(stars: number | null): string {
	if (stars === null || stars === undefined) return "★ —";
	return stars >= 1000 ? `★ ${(stars / 1000).toFixed(1)}k` : `★ ${stars}`;
}

/** Topics are stored as a JSON array; never let a malformed value break the list. */
function topicsOf(bookmark: Bookmark): string[] {
	if (!bookmark.topics) return [];
	try {
		const parsed = JSON.parse(bookmark.topics) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

type SortMode = "relevance" | "newest" | "oldest" | "stars" | "alpha";

type PaletteOptions = {
	initialQuery?: string;
	/** Preset relevance order (from /consult); restricts the list to these ids. */
	rankedIds?: number[];
	reasons?: Map<number, string[]>;
	/** Repaint hook, so async work (a background refresh) can update the overlay. */
	requestRender?: () => void;
	/** Test seam: how one refresh step is executed. Defaults to the real CLI. */
	cliRunner?: CliRunner;
};

/** Record that a bookmark was used. Best effort: never break the palette. */
function recordUse(resourceId: number, action: "insert" | "open"): void {
	try {
		const db = new DatabaseSync(DB_PATH);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO bookmark_usage (resource_id, first_used_at, last_used_at, use_count, last_action)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(resource_id) DO UPDATE SET
         last_used_at = excluded.last_used_at,
         use_count = bookmark_usage.use_count + 1,
         last_action = excluded.last_action`,
		).run(resourceId, now, now, action);
		db.close();
	} catch {
		// usage tracking is best effort
	}
}

type Media = { type: string; path: string | null; contentType: string | null };

type BookmarkDetail = Bookmark & { content: string; media: Media[] };

type Action = { action: "cancel" } | { action: "insert"; id: number };

function openDb(): DatabaseSync {
	return new DatabaseSync(DB_PATH, { readOnly: true });
}

function loadBookmarks(): Bookmark[] {
	if (!existsSync(DB_PATH)) return [];
	const db = openDb();
	try {
		return db
			.prepare(
				`${LIST_SQL}
         WHERE EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
         ORDER BY COALESCE(savedAt, r.created_at) DESC, r.id DESC`,
			)
			.all() as Bookmark[];
	} finally {
		db.close();
	}
}

// Content search: the palette filter is fuzzy over metadata, this adds the
// captured text so a query can match a README, post, or article body. Same
// tokenising rules as src/search.ts, which the extension cannot import because
// it is symlinked into pi's extensions directory.
const SEARCH_STOP_WORDS = new Set([
	"a", "an", "and", "for", "from", "in", "into", "of", "on", "or", "over", "the", "to", "with",
	"is", "are", "was", "be", "been", "being", "it", "its", "this", "that", "these", "those",
	"i", "me", "my", "we", "our", "you", "your", "do", "does", "did", "can", "could",
	"should", "would", "will", "how", "what", "when", "where", "why", "there", "here", "any", "some",
	"ok", "okay", "nice", "cool", "thanks", "please", "just", "really", "maybe", "sure",
]);

let searchConnection: DatabaseSync | null = null;
let contentCache: { query: string; ids: number[] } | null = null;

/** Resource ids whose captured text matches the query, best first. */
function contentMatchIds(query: string): number[] {
	if (contentCache?.query === query) return contentCache.ids;
	const tokens = (query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
		(token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token.toLocaleLowerCase()),
	);
	if (tokens.length === 0 || !existsSync(DB_PATH)) return [];
	const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
	let ids: number[] = [];
	try {
		searchConnection ??= new DatabaseSync(DB_PATH, { readOnly: true });
		const rows = searchConnection
			.prepare(`
        SELECT resource_id AS id FROM resources_fts
        WHERE resources_fts MATCH ?
        ORDER BY bm25(resources_fts, 0.0, 10.0, 5.0, 3.0, 1.0, 2.0)
        LIMIT 200
      `)
			.all(ftsQuery) as Array<{ id: number }>;
		ids = rows.map((row) => row.id);
	} catch {
		ids = [];
	}
	contentCache = { query, ids };
	return ids;
}

function loadDetail(id: number): BookmarkDetail | null {
	const db = openDb();
	try {
		const bookmark = db.prepare(`${LIST_SQL} WHERE r.id = ?`).get(id) as Bookmark | undefined;
		if (!bookmark) return null;
		const captures = db
			.prepare(`
        SELECT kind, normalized_content AS content FROM captures
        WHERE resource_id = ? ORDER BY fetched_at DESC, id DESC
      `)
			.all(id) as Array<{ kind: string; content: string }>;
		const primary =
			captures.find((capture) => capture.kind === "x_post" || capture.kind === "github_readme") ??
			captures.find((capture) => capture.content.trim()) ??
			captures[0];
		const media = db
			.prepare(`
        SELECT type, local_path AS path, content_type AS contentType
        FROM x_media WHERE resource_id = ? ORDER BY position, media_key
      `)
			.all(id) as Media[];
		return { ...bookmark, content: primary?.content ?? "", media };
	} finally {
		db.close();
	}
}

async function copyText(text: string): Promise<boolean> {
	const clipboard = getNativeClipboard();
	if (clipboard?.setText) {
		try {
			await clipboard.setText(text);
			return true;
		} catch {
			// fall through to the platform helper
		}
	}
	if (process.platform !== "darwin") return false;
	return spawnSync("pbcopy", [], { input: text }).status === 0;
}

type CliResult = { ok: boolean; stdout: string; stderr: string };
type CliRunner = (args: string[]) => Promise<CliResult>;

/** Run the CLI without blocking the TUI. Resolves on exit rather than throwing. */
function runCli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => resolve({ ok: false, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
	});
}

/** Pull one named count out of a CLI JSON payload, when it printed one. */
function countFrom(stdout: string, key: string): number | null {
	try {
		const value = JSON.parse(stdout) as Record<string, unknown>;
		const count = value[key];
		return typeof count === "number" ? count : null;
	} catch {
		return null;
	}
}

function wrap(text: string, width: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (visibleWidth(candidate) > width && current) {
			lines.push(current);
			current = word;
			if (lines.length >= maxLines) break;
		} else {
			current = candidate;
		}
	}
	if (current && lines.length < maxLines) lines.push(current);
	return lines;
}

export class BookmarkPalette implements Component, Focusable {
	focused = false;
	private readonly input: Input;
	private items: Bookmark[];
	private readonly theme: Theme;
	private readonly done: (action: Action) => void;
	private readonly reasons: Map<number, string[]>;
	private readonly ranked: boolean;
	private filtered: Bookmark[];
	private selected = 0;
	private sourceFilter: SourceFilter = "all";
	private sortMode: SortMode = "relevance";
	private unseenOnly = false;
	private hideArchived = false;
	private recentOnly = false;
	private topic: string | null = null;
	private topicPicker: { entries: Array<{ name: string; count: number }>; index: number } | null = null;
	private reading = false;
	private noteEdit: { id: number; input: Input } | null = null;
	private preview: { id: number; offset: number } | null = null;
	/** Recorded by render so input handling can clamp the scroll without re-wrapping. */
	private previewTotal = 0;
	private readonly requestRender: (() => void) | undefined;
	private readonly cliRunner: CliRunner;
	private refreshing = false;
	private showHelp = false;
	private notice: string | null = null;
	private readonly details = new Map<number, BookmarkDetail | null>();
	private readonly images = new Map<number, Image | null>();

	constructor(
		allItems: Bookmark[],
		theme: Theme,
		done: (action: Action) => void,
		options: PaletteOptions = {},
	) {
		const byId = new Map(allItems.map((bookmark) => [bookmark.id, bookmark]));
		this.items = options.rankedIds
			? options.rankedIds.flatMap((id) => {
					const bookmark = byId.get(id);
					return bookmark ? [bookmark] : [];
				})
			: allItems;
		this.ranked = Boolean(options.rankedIds);
		this.reasons = options.reasons ?? new Map();
		this.requestRender = options.requestRender;
		this.cliRunner = options.cliRunner ?? runCli;
		this.theme = theme;
		this.done = done;
		this.input = new Input({ placeholder: "Search title, author, description, url…" });
		const initialQuery = options.initialQuery ?? "";
		if (initialQuery) this.input.setValue(initialQuery);
		this.filtered = this.applyFilter(initialQuery);
	}

	private applyFilter(query: string): Bookmark[] {
		let scoped =
			this.sourceFilter === "all"
				? this.items
				: this.items.filter((bookmark) => sourceOf(bookmark) === this.sourceFilter);
		if (this.unseenOnly) scoped = scoped.filter((bookmark) => bookmark.useCount === 0);
		if (this.hideArchived) scoped = scoped.filter((bookmark) => bookmark.archived !== 1);
		if (this.recentOnly) {
			const cutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
			scoped = scoped.filter((bookmark) => (bookmark.savedAt ?? "") >= cutoff);
		}
		if (this.topic) {
			const wanted = this.topic;
			scoped = scoped.filter((bookmark) => topicsOf(bookmark).includes(wanted));
		}
		const trimmed = query.trim();
		if (!trimmed) return this.sortBookmarks([...scoped]);
		// fuzzyMatch accepts any in-order subsequence, which matches nearly anything
		// in a long title+url. A negative score means the match is contiguous or
		// word-aligned; only those may outrank a match found in the content.
		const tokens = trimmed.split(/[\s/]+/).filter(Boolean);
		const strong: Array<{ bookmark: Bookmark; score: number }> = [];
		const weak: Array<{ bookmark: Bookmark; score: number }> = [];
		for (const bookmark of scoped) {
			const text = `${bookmark.title} ${bookmark.author ?? ""} ${bookmark.description ?? ""} ${bookmark.url}`;
			let score = 0;
			let matchesAll = true;
			for (const token of tokens) {
				const match = fuzzyMatch(token, text);
				if (!match.matches) {
					matchesAll = false;
					break;
				}
				score += match.score;
			}
			if (matchesAll) (score < 0 ? strong : weak).push({ bookmark, score });
		}
		strong.sort((a, b) => a.score - b.score);
		weak.sort((a, b) => a.score - b.score);
		const matched = new Set([...strong, ...weak].map((entry) => entry.bookmark.id));
		const scopedById = new Map(scoped.map((bookmark) => [bookmark.id, bookmark]));
		const byContent: Bookmark[] = [];
		for (const id of contentMatchIds(trimmed)) {
			const bookmark = scopedById.get(id);
			if (bookmark && !matched.has(id)) byContent.push(bookmark);
		}
		return this.sortBookmarks([
			...strong.map((entry) => entry.bookmark),
			...byContent,
			...weak.map((entry) => entry.bookmark),
		]);
	}

	private hasQuery(): boolean {
		return this.input.getValue().trim() !== "";
	}

	private sortBookmarks(items: Bookmark[]): Bookmark[] {
		const sorted = [...items];
		switch (this.sortMode) {
			case "newest":
				return sorted.sort((a, b) => savedOn(b).localeCompare(savedOn(a)));
			case "oldest":
				return sorted.sort((a, b) => savedOn(a).localeCompare(savedOn(b)));
			case "stars":
				return sorted.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));
			case "alpha":
				return sorted.sort((a, b) => a.title.localeCompare(b.title));
			default:
				return sorted;
		}
	}

	private refilter(): void {
		this.filtered = this.applyFilter(this.input.getValue());
		this.selected = 0;
	}

	private cycleSort(): void {
		// "relevance" only means something once there is a query. Without one it is
		// the base ordering, which is newest-first — so it is not offered, and
		// starting from it steps to oldest rather than to an identical view.
		const order: SortMode[] = this.hasQuery()
			? ["relevance", "newest", "oldest", "stars", "alpha"]
			: ["newest", "oldest", "stars", "alpha"];
		const current = this.sortMode === "relevance" && !this.hasQuery() ? "newest" : this.sortMode;
		const index = order.indexOf(current);
		this.sortMode = order[(index + 1) % order.length] ?? order[0] ?? "newest";
		this.filtered = this.applyFilter(this.input.getValue());
		this.selected = 0;
	}

	private sourceCounts(): { all: number; github: number; x: number } {
		let github = 0;
		for (const bookmark of this.items) if (sourceOf(bookmark) === "github") github += 1;
		return { all: this.items.length, github, x: this.items.length - github };
	}

	private cycleSource(step: number): void {
		const order: SourceFilter[] = ["all", "github", "x"];
		const index = order.indexOf(this.sourceFilter);
		this.sourceFilter = order[(index + step + order.length) % order.length] ?? "all";
		this.filtered = this.applyFilter(this.input.getValue());
		this.selected = 0;
	}

	private selectedBookmark(): Bookmark | undefined {
		return this.filtered[this.selected];
	}

	private detail(bookmark: Bookmark): BookmarkDetail | null {
		if (!this.details.has(bookmark.id)) this.details.set(bookmark.id, loadDetail(bookmark.id));
		return this.details.get(bookmark.id) ?? null;
	}

	private image(bookmark: Bookmark): Image | null {
		if (this.images.has(bookmark.id)) return this.images.get(bookmark.id) ?? null;
		let image: Image | null = null;
		const photo = this.detail(bookmark)?.media.find(
			(media) => media.path && (media.contentType ?? "").startsWith("image/"),
		);
		if (photo?.path) {
			try {
				const buffer = readFileSync(photo.path);
				if (buffer.byteLength <= 5 * 1024 * 1024) {
					image = new Image(
						buffer.toString("base64"),
						photo.contentType ?? "image/jpeg",
						{ fallbackColor: (text) => this.theme.fg("dim", text) },
						{ maxWidthCells: 56, maxHeightCells: 12, filename: photo.path },
					);
				}
			} catch {
				image = null;
			}
		}
		this.images.set(bookmark.id, image);
		return image;
	}

	/** Run the refresh steps in order, non-blocking, then reload the list in place. */
	async refresh(): Promise<void> {
		if (this.refreshing) return;
		if (!existsSync(CLI_PATH)) {
			this.notice = "refresh unavailable: CLI not found";
			this.requestRender?.();
			return;
		}
		const steps = [
			{ label: "GitHub", args: ["sync", "github"], key: "imported" },
			{ label: "X", args: ["collect", "x", "--fast"], key: "imported" },
			{ label: "READMEs", args: ["enrich", "github-readmes", "--limit", "25"], key: "enriched" },
		];
		this.refreshing = true;
		const parts: string[] = [];
		let failed = false;
		try {
			for (const step of steps) {
				this.notice = `↻ refreshing ${step.label}\u2026`;
				this.requestRender?.();
				const result = await this.cliRunner(step.args);
				if (!result.ok) {
					failed = true;
					parts.push(`${step.label} failed`);
					continue;
				}
				const count = countFrom(result.stdout, step.key);
				parts.push(`${step.label} ${count === null ? "done" : count > 0 ? `+${count}` : "no change"}`);
			}
		} finally {
			this.refreshing = false;
			contentCache = null;
			this.items = loadBookmarks();
			this.details.clear();
			this.images.clear();
			this.filtered = this.applyFilter(this.input.getValue());
			this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
			this.notice = `${failed ? "⚠" : "✓"} ${parts.join(" · ")}`;
			this.requestRender?.();
		}
	}

	/** Topics worth offering, most used first, with an "All topics" entry on top. */
	private openTopicPicker(): void {
		const counts = new Map<string, number>();
		let total = 0;
		for (const bookmark of this.items) {
			if (this.sourceFilter !== "all" && sourceOf(bookmark) !== this.sourceFilter) continue;
			total += 1;
			for (const name of topicsOf(bookmark)) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		const entries = [
			{ name: "", count: total },
			...[...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, TOPIC_LIMIT)
				.map(([name, count]) => ({ name, count })),
		];
		const current = entries.findIndex((entry) => entry.name === (this.topic ?? ""));
		this.topicPicker = { entries, index: current >= 0 ? current : 0 };
		this.requestRender?.();
	}

	private handleTopicPickerInput(data: string): void {
		const picker = this.topicPicker;
		if (!picker) return;
		const page = LIST_ROWS - 1;
		const last = Math.max(0, picker.entries.length - 1);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+t") || matchesKey(data, "ctrl+c")) {
			this.topicPicker = null;
		} else if (matchesKey(data, "up")) {
			picker.index = Math.max(0, picker.index - 1);
		} else if (matchesKey(data, "down")) {
			picker.index = Math.min(last, picker.index + 1);
		} else if (matchesKey(data, "pageUp")) {
			picker.index = Math.max(0, picker.index - page);
		} else if (matchesKey(data, "pageDown")) {
			picker.index = Math.min(last, picker.index + page);
		} else if (matchesKey(data, "home")) {
			picker.index = 0;
		} else if (matchesKey(data, "end")) {
			picker.index = last;
		} else if (matchesKey(data, "return")) {
			const name = picker.entries[picker.index]?.name ?? "";
			this.topic = name === "" ? null : name;
			this.topicPicker = null;
			this.refilter();
		} else {
			return;
		}
		this.requestRender?.();
	}

	/** Keys while writing a note: enter saves it, esc cancels, anything else edits. */
	private handleNoteInput(data: string): void {
		const edit = this.noteEdit;
		if (!edit) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.noteEdit = null;
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "return")) {
			const text = edit.input.getValue().trim();
			this.noteEdit = null;
			void this.saveNote(edit.id, text);
			return;
		}
		edit.input.handleInput(data);
		this.requestRender?.();
	}

	/**
	 * Write the note through the CLI, which owns both the note write and the FTS
	 * refresh, so the extension keeps its read-only database connection.
	 */
	private async saveNote(id: number, text: string): Promise<void> {
		const bookmark = this.items.find((item) => item.id === id);
		const previous = bookmark?.context ?? null;
		if (bookmark) bookmark.context = text || null;
		this.notice = "✎ saving note…";
		this.requestRender?.();
		const result = await this.cliRunner(["note", String(id), text]);
		if (!result.ok && bookmark) {
			bookmark.context = previous;
			this.notice = "✎ note not saved";
		} else {
			this.notice = text ? "✎ note saved" : "✎ note cleared";
			contentCache = null;
		}
		this.requestRender?.();
	}

	/** Keys while the reading pane is open: scroll the text, esc returns to the list. */
	private handleReadingInput(data: string): void {
		const bookmark = this.selectedBookmark();
		const current = this.preview && bookmark && this.preview.id === bookmark.id ? this.preview.offset : 0;
		const maxOffset = Math.max(0, this.previewTotal - READING_ROWS);
		const scrollTo = (offset: number): void => {
			if (!bookmark) return;
			this.preview = { id: bookmark.id, offset: Math.max(0, Math.min(offset, maxOffset)) };
			this.requestRender?.();
		};
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+e") || matchesKey(data, "ctrl+c")) {
			this.reading = false;
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "up")) return scrollTo(current - 1);
		if (matchesKey(data, "down")) return scrollTo(current + 1);
		if (matchesKey(data, "pageUp")) return scrollTo(current - (READING_ROWS - 1));
		if (matchesKey(data, "pageDown")) return scrollTo(current + (READING_ROWS - 1));
		if (matchesKey(data, "home")) return scrollTo(0);
		if (matchesKey(data, "end")) return scrollTo(maxOffset);
		if (matchesKey(data, "return") && bookmark) {
			recordUse(bookmark.id, "insert");
			this.done({ action: "insert", id: bookmark.id });
		}
	}

	handleInput(data: string): void {
		if (this.showHelp) {
			this.showHelp = false;
			this.requestRender?.();
			return;
		}
		if (this.topicPicker) {
			this.handleTopicPickerInput(data);
			return;
		}
		if (this.reading) {
			this.handleReadingInput(data);
			return;
		}
		if (this.noteEdit) {
			this.handleNoteInput(data);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleSource(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleSource(-1);
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.unseenOnly = !this.unseenOnly;
			this.filtered = this.applyFilter(this.input.getValue());
			this.selected = 0;
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.cycleSort();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+e")) {
			this.reading = true;
			this.preview = null;
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			const bookmark = this.selectedBookmark();
			if (bookmark) {
				const input = new Input({ placeholder: "Why does this bookmark matter?" });
				input.setValue(bookmark.context ?? "");
				this.noteEdit = { id: bookmark.id, input };
				this.requestRender?.();
			}
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			this.hideArchived = !this.hideArchived;
			this.refilter();
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.recentOnly = !this.recentOnly;
			this.refilter();
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			this.openTopicPicker();
			return;
		}
		// Jump navigation. macOS sends Fn+←/→ as home/end and Fn+↑/↓ as pageUp/pageDown;
		// Cmd+↑/↓ arrives as super+up/down only when the terminal forwards the modifier.
		if (matchesKey(data, "home")) {
			this.selected = 0;
			return;
		}
		if (matchesKey(data, "end")) {
			this.selected = Math.max(0, this.filtered.length - 1);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "super+up")) {
			this.selected = Math.max(0, this.selected - LIST_ROWS);
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "super+down")) {
			this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + LIST_ROWS);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			const bookmark = this.selectedBookmark();
			if (bookmark) {
				recordUse(bookmark.id, "insert");
				this.done({ action: "insert", id: bookmark.id });
			}
			return;
		}
		const bookmark = this.selectedBookmark();
		if (bookmark && matchesKey(data, "ctrl+y")) {
			void copyText(bookmark.url);
			return;
		}
		if (bookmark && matchesKey(data, "ctrl+o")) {
			recordUse(bookmark.id, "open");
			if (process.platform === "darwin") spawnSync("open", [bookmark.url]);
			this.done({ action: "cancel" });
			return;
		}

		// `?` only opens help on an empty search box, so it can still be typed in a query.
		if (matchesKey(data, "f1") || (data === "?" && this.input.getValue().trim() === "")) {
			this.showHelp = true;
			this.requestRender?.();
			return;
		}

		this.input.handleInput(data);
		this.filtered = this.applyFilter(this.input.getValue());
		this.selected = 0;
	}

	/** The topic picker: topics ranked by how many bookmarks carry them. */
	private renderTopics(width: number): string[] {
		const theme = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const pad = (text: string): string => {
			const line = truncateToWidth(text, innerWidth, "…", true);
			return line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		};
		const row = (content: string): string =>
			theme.fg("border", "│ ") + pad(content) + theme.fg("border", " │");
		const picker = this.topicPicker;
		const entries = picker?.entries ?? [];
		const selected = picker?.index ?? 0;
		const rows = 20;
		const maxStart = Math.max(0, entries.length - rows);
		const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), maxStart));

		const lines: string[] = [theme.fg("border", `┌${"─".repeat(width - 2)}┐`)];
		lines.push(
			row(
				theme.fg("accent", theme.bold("Filter by topic")) +
					theme.fg("dim", `  ${Math.max(0, entries.length - 1)} topics`),
			),
		);
		lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));
		for (let offset = 0; offset < rows; offset += 1) {
			const index = start + offset;
			const entry = entries[index];
			if (!entry) {
				lines.push(row(""));
				continue;
			}
			const label = (entry.name === "" ? "All topics" : `#${entry.name}`).padEnd(30);
			const text = `${index === selected ? "▸" : " "} ${label}${String(entry.count).padStart(4)}`;
			lines.push(
				row(
					index === selected ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("muted", text),
				),
			);
		}
		lines.push(theme.fg("border", `└${"─".repeat(width - 2)}┘`));
		lines.push(theme.fg("dim", "  ↑↓ navigate · enter filter · esc cancel"));
		return lines;
	}

	/** The `?` / F1 screen: what this is, and every key. */
	private renderHelp(width: number): string[] {
		const theme = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const pad = (text: string): string => {
			const line = truncateToWidth(text, innerWidth, "…", true);
			return line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		};
		const row = (content: string): string =>
			theme.fg("border", "│ ") + pad(content) + theme.fg("border", " │");
		const key = (keys: string, what: string): string =>
			theme.fg("accent", `  ${keys.padEnd(18)}`) + theme.fg("muted", what);

		const body = [
			theme.fg("accent", theme.bold("Bookmark Atlas")),
			theme.fg("dim", "  Starred GitHub repos and saved X posts, read from a local database."),
			"",
			theme.fg("dim", "  Type to search titles and captured text, arrows to move, enter to insert."),
			"",
			theme.fg("accent", "Navigate"),
			key("↑ / ↓", "one row"),
			key("Fn+↑ / Fn+↓", "ten rows (Page Up/Down)"),
			key("Fn+← / Fn+→", "first / last (Home/End)"),
			key("Cmd+↑ / Cmd+↓", "ten rows, where the terminal forwards Cmd"),
			"",
			theme.fg("accent", "Filter"),
			key("tab / shift+tab", "All → GitHub → X"),
			key("ctrl+u", "only bookmarks you have never opened"),
			key("ctrl+a", "hide archived repositories"),
			key("ctrl+d", "only what was added in the last 7 days"),
			key("ctrl+t", "filter by topic"),
			key("ctrl+s", "sort: newest, oldest, stars, A-Z (best match appears once you search)"),
			"",
			theme.fg("accent", "Act"),
			key("enter", "insert title, url and content into the editor"),
			key("ctrl+e", "read the full README or post text"),
			key("ctrl+n", "write a note: why this matters to you"),
			key("ctrl+y", "copy the url"),
			key("ctrl+o", "open in the browser"),
			key("ctrl+r", "fetch new bookmarks (GitHub, X, READMEs)"),
			"",
			key("? / f1", "this help"),
			key("esc", "close"),
		];

		const lines: string[] = [theme.fg("border", `┌${"─".repeat(width - 2)}┐`)];
		for (const line of body) lines.push(row(line));
		lines.push(theme.fg("border", `└${"─".repeat(width - 2)}┘`));
		lines.push(theme.fg("dim", "  press any key to go back"));
		return lines;
	}

	render(width: number): string[] {
		if (this.showHelp) return this.renderHelp(width);
		if (this.topicPicker) return this.renderTopics(width);
		this.input.focused = this.focused;
		if (this.noteEdit) this.noteEdit.input.focused = this.focused;
		const theme = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const pad = (text: string): string => {
			const line = truncateToWidth(text, innerWidth, "…", true);
			return line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		};
		const row = (content: string): string =>
			theme.fg("border", "│ ") + pad(content) + theme.fg("border", " │");

		const lines: string[] = [];
		lines.push(theme.fg("border", `┌${"─".repeat(width - 2)}┐`));
		lines.push(
			row(
				theme.fg("accent", theme.bold(this.ranked ? "Consult" : "Bookmark Atlas")) +
					theme.fg(
						"dim",
						this.ranked
							? `  ${this.items.length} matches  ·  ${this.filtered.length} shown`
							: `  ${this.items.length} bookmarks  ·  ${this.filtered.length} shown`,
					),
			),
		);
		lines.push(
			row(
				this.noteEdit
					? theme.fg("accent", "✎ note: ") + (this.noteEdit.input.render(innerWidth - 8)[0] ?? "")
					: (this.input.render(innerWidth)[0] ?? ""),
			),
		);
		const counts = this.sourceCounts();
		const unseenCount = this.items.filter((bookmark) => bookmark.useCount === 0).length;
		// Without a query (or a consult ranking) there is nothing to be relevant to.
		const sortLabel =
			this.sortMode === "relevance" && !this.hasQuery() && !this.ranked ? "newest" : this.sortMode;
		const chip = (label: string, value: SourceFilter, count: number): string => {
			const text = ` ${label} ${count} `;
			return this.sourceFilter === value
				? theme.bg("selectedBg", theme.fg("accent", text))
				: theme.fg("dim", text);
		};
		const toggle = (label: string, on: boolean): string =>
			on ? theme.bg("selectedBg", theme.fg("accent", ` ${label} `)) : theme.fg("dim", ` ${label} `);
		lines.push(
			row(
				chip("All", "all", counts.all) +
					chip("GitHub", "github", counts.github) +
					chip("X", "x", counts.x) +
					toggle(`unseen ${unseenCount}`, this.unseenOnly) +
					toggle("hide archived", this.hideArchived) +
					toggle(`recent ${RECENT_DAYS}d`, this.recentOnly) +
					(this.topic ? toggle(`#${this.topic}`, true) : "") +
					theme.fg("dim", ` sort:${sortLabel} `) +
					theme.fg("dim", this.notice ?? "? help"),
			),
		);
		lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));

		const reading = this.reading;
		const listRows = reading ? 0 : LIST_ROWS;
		const maxStart = Math.max(0, this.filtered.length - LIST_ROWS);
		const start = Math.max(0, Math.min(this.selected - Math.floor(LIST_ROWS / 2), maxStart));
		// Numbers are absolute positions in the current view, so they stay stable while scrolling.
		const ordinalWidth = Math.max(2, String(this.filtered.length).length);
		// Swap the date column for the star count while sorting by it, so the order is legible.
		const showStars = this.sortMode === "stars";
		for (let offset = 0; offset < listRows; offset += 1) {
			const index = start + offset;
			const bookmark = this.filtered[index];
			if (!bookmark) {
				lines.push(
					row(index === 0 && this.filtered.length === 0 ? theme.fg("warning", "No bookmarks match.") : ""),
				);
				continue;
			}
			const marker = index === this.selected ? theme.fg("accent", "▸") : " ";
			const ordinal = String(index + 1).padStart(ordinalWidth);
			const date = savedOn(bookmark).slice(0, 10) || "----------";
			const leading = showStars ? formatStars(bookmark.stars).padEnd(10) : date;
			const author = truncateToWidth((bookmark.author ?? "").replace(/^@/, ""), 14, "…");
			const badge =
				bookmark.photos || bookmark.videos
					? theme.fg(
							"dim",
							`  ${bookmark.photos ? `📷${bookmark.photos}` : ""}${bookmark.videos ? ` 🎬${bookmark.videos}` : ""}`,
						)
					: "";
			const title = truncateToWidth(
				bookmark.title.replace(/\s+/g, " "),
				Math.max(10, innerWidth - 44 - ordinalWidth),
				"…",
			);
			const text = `${marker} ${ordinal}  ${leading}  ${author.padEnd(14)}  ${title}${badge}`;
			lines.push(
				row(
					index === this.selected
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg("muted", text),
				),
			);
		}
		if (!reading) lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));

		const bookmark = this.selectedBookmark();
		const detail = bookmark ? this.detail(bookmark) : null;
		const note = bookmark?.context ? `📝 ${bookmark.context}` : "";
		const body = (detail?.content ?? bookmark?.description ?? "").replace(/\s+/g, " ").trim();
		const fullText = [note, body].filter(Boolean).join("  ·  ").slice(0, 20000);
		const excerptLines = wrap(fullText, innerWidth, 600);
		// render() owns the wrap, so it records the total for handleReadingInput to clamp against.
		this.previewTotal = excerptLines.length;
		const excerptRows = reading ? READING_ROWS : EXCERPT_ROWS;
		const maxOffset = Math.max(0, excerptLines.length - excerptRows);
		const offset =
			reading && this.preview && bookmark && this.preview.id === bookmark.id
				? Math.min(this.preview.offset, maxOffset)
				: 0;

		lines.push(
			row(bookmark ? theme.fg("accent", theme.bold(truncateToWidth(bookmark.title, innerWidth, "…"))) : ""),
		);
		lines.push(row(bookmark ? theme.fg("mdLinkUrl", bookmark.url) : ""));
		const meta = bookmark
			? [
					bookmark.author,
					(bookmark.savedAt ?? "").slice(0, 10),
					bookmark.type,
					`${bookmark.photos} photos · ${bookmark.videos} videos`,
				]
					.filter(Boolean)
					.join("  ·  ")
			: "";
		lines.push(row(theme.fg("dim", meta)));
		const why = bookmark ? (this.reasons.get(bookmark.id) ?? []) : [];
		lines.push(row(why.length > 0 ? theme.fg("accent", `why: ${why.join(" · ")}`) : ""));
		lines.push(
			row(
				reading
					? theme.fg(
							"dim",
							`${offset + 1}-${Math.min(offset + excerptRows, this.previewTotal)} of ${this.previewTotal} lines · ↑↓ scroll · esc back`,
						)
					: theme.fg("dim", excerptLines.length > EXCERPT_ROWS ? "ctrl+e to read the full text" : ""),
			),
		);

		for (let index = 0; index < excerptRows; index += 1) {
			lines.push(row(theme.fg("text", excerptLines[offset + index] ?? "")));
		}

		if (!reading) {
			lines.push(row(""));
			const imageLines = bookmark ? (this.image(bookmark)?.render(innerWidth) ?? []) : [];
			for (let index = 0; index < IMAGE_ROWS; index += 1) {
				lines.push(row(imageLines[index] ?? ""));
			}
		}

		lines.push(theme.fg("border", `└${"─".repeat(width - 2)}┘`));
		lines.push(
			theme.fg(
				"dim",
				this.noteEdit
					? "  enter save note · esc cancel"
					: reading
						? "  ↑↓ scroll · enter insert · esc back · ? help"
						: "  ↑↓ navigate · enter insert · ctrl+e read · ctrl+n note · esc close",
			),
		);
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
		this.images.clear();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bookmarks", {
		description: "Search your starred bookmarks and saved X posts",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/bookmarks requires interactive TUI mode", "warning");
				return;
			}
			if (!existsSync(DB_PATH)) {
				ctx.ui.notify(`Bookmark Atlas database not found at ${DB_PATH}`, "error");
				return;
			}
			const items = loadBookmarks();
			if (items.length === 0) {
				ctx.ui.notify("No bookmarks found in the Bookmark Atlas database.", "warning");
				return;
			}
			const result = await ctx.ui.custom<Action>(
				(tui, theme, _keybindings, done) =>
					new BookmarkPalette(items, theme, done, {
						initialQuery: args.trim(),
						requestRender: () => tui.requestRender(),
					}),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" } },
			);
			if (result.action !== "insert") return;
			const detail = loadDetail(result.id);
			if (!detail) return;
			const excerpt = detail.content.trim().slice(0, 4000);
			ctx.ui.setEditorText([detail.title, detail.url, excerpt].filter(Boolean).join("\n\n"));
			ctx.ui.notify(`Inserted bookmark #${detail.id}`, "info");
		},
	});

	pi.registerCommand("consult", {
		description: "Find saved bookmarks that fit where this project is right now",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/consult requires interactive TUI mode", "warning");
				return;
			}
			if (!existsSync(DB_PATH)) {
				ctx.ui.notify(`Bookmark Atlas database not found at ${DB_PATH}`, "error");
				return;
			}
			const focus = args.trim();
			const result = spawnSync(
				process.execPath,
				[
					CLI_PATH,
					"recall",
					"--stage",
					...(focus ? [focus] : []),
					"--repo",
					ctx.cwd,
					"--limit",
					"20",
				],
				{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);
			if (result.status !== 0 || !result.stdout) {
				ctx.ui.notify(result.stderr?.trim() || "Consult failed", "error");
				return;
			}
			let hits: RecallHit[];
			try {
				hits = JSON.parse(result.stdout) as RecallHit[];
			} catch {
				ctx.ui.notify("Consult returned invalid data", "error");
				return;
			}
			if (hits.length === 0) {
				ctx.ui.notify("Nothing in your bookmarks fits this stage yet.", "info");
				return;
			}
			const rankedIds = hits.map((hit) => hit.id);
			const reasons = new Map(hits.map((hit) => [hit.id, hit.whyMatched]));
			const chosen = await ctx.ui.custom<Action>(
				(tui, theme, _keybindings, done) =>
					new BookmarkPalette(loadBookmarks(), theme, done, {
						rankedIds,
						reasons,
						requestRender: () => tui.requestRender(),
					}),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" } },
			);
			if (chosen.action !== "insert") return;
			const detail = loadDetail(chosen.id);
			if (!detail) return;
			ctx.ui.setEditorText(
				[
					detail.title,
					detail.url,
					detail.context ?? "",
					detail.content.trim().slice(0, 3000),
				]
					.filter(Boolean)
					.join("\n\n"),
			);
			ctx.ui.notify(`Consult: inserted bookmark #${detail.id}`, "info");
		},
	});

}
