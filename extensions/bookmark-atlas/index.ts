/**
 * bookmark-atlas — a search palette for your starred GitHub repos and saved X posts.
 *
 * Usage: /bookmarks [query]
 *
 * Opens an overlay modeled on pi-skill-palette: type to fuzzy-filter, arrows to
 * navigate, preview shows post/article text and inline images.
 *   enter    insert the bookmark (title, url, content) into the editor
 *   ctrl+y   copy the url
 *   ctrl+o   open the url in the default browser
 *   ctrl+r   fetch new bookmarks (GitHub stars, X posts, READMEs)
 *   esc      close
 *
 * Reads the Bookmark Atlas SQLite database directly (read-only). Override the
 * location with BOOKMARK_ATLAS_DB.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Image,
	Input,
	fuzzyFilter,
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
    (SELECT MAX(s.saved_at) FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL) AS savedAt,
    (SELECT COUNT(*) FROM x_media m WHERE m.resource_id = r.id AND m.type = 'photo') AS photos,
    (SELECT COUNT(*) FROM x_media m WHERE m.resource_id = r.id AND m.type = 'video') AS videos,
    n.context AS context,
    g.stars AS stars,
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
	savedAt: string | null;
	photos: number;
	videos: number;
	context: string | null;
	stars: number | null;
	useCount: number;
};

/** Which source a bookmark came from. */
type SourceFilter = "all" | "github" | "x";

function sourceOf(bookmark: Bookmark): "github" | "x" {
	return bookmark.type === "x_post" ? "x" : "github";
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
	refreshRunner?: CliRunner;
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
	private readonly requestRender: (() => void) | undefined;
	private readonly refreshRunner: CliRunner;
	private refreshing = false;
	private refreshStatus: string | null = null;
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
		this.refreshRunner = options.refreshRunner ?? runCli;
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
		const base = query.trim()
			? fuzzyFilter(scoped, query, (bookmark) =>
					`${bookmark.title} ${bookmark.author ?? ""} ${bookmark.description ?? ""} ${bookmark.url}`,
				)
			: [...scoped];
		return this.sortBookmarks(base);
	}

	private sortBookmarks(items: Bookmark[]): Bookmark[] {
		const sorted = [...items];
		switch (this.sortMode) {
			case "newest":
				return sorted.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
			case "oldest":
				return sorted.sort((a, b) => (a.savedAt ?? "").localeCompare(b.savedAt ?? ""));
			case "stars":
				return sorted.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));
			case "alpha":
				return sorted.sort((a, b) => a.title.localeCompare(b.title));
			default:
				return sorted;
		}
	}

	private cycleSort(): void {
		const order: SortMode[] = ["relevance", "newest", "oldest", "stars", "alpha"];
		const index = order.indexOf(this.sortMode);
		this.sortMode = order[(index + 1) % order.length] ?? "relevance";
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
			this.refreshStatus = "refresh unavailable: CLI not found";
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
				this.refreshStatus = `↻ refreshing ${step.label}\u2026`;
				this.requestRender?.();
				const result = await this.refreshRunner(step.args);
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
			this.items = loadBookmarks();
			this.details.clear();
			this.images.clear();
			this.filtered = this.applyFilter(this.input.getValue());
			this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
			this.refreshStatus = `${failed ? "⚠" : "✓"} ${parts.join(" · ")}`;
			this.requestRender?.();
		}
	}

	handleInput(data: string): void {
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

		this.input.handleInput(data);
		this.filtered = this.applyFilter(this.input.getValue());
		this.selected = 0;
	}

	render(width: number): string[] {
		this.input.focused = this.focused;
		const theme = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const pad = (text: string): string => {
			const line = truncateToWidth(text, innerWidth, "…", true);
			return line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		};
		const row = (content: string): string =>
			theme.fg("border", "│ ") + pad(content) + theme.fg("border", " │");

		// Fixed row budgets keep the overlay the same size as the selection moves.
		const EXCERPT_ROWS = 5;
		const IMAGE_ROWS = 10;

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
		lines.push(row(this.input.render(innerWidth)[0] ?? ""));
		const counts = this.sourceCounts();
		const unseenCount = this.items.filter((bookmark) => bookmark.useCount === 0).length;
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
					theme.fg("dim", ` sort:${this.sortMode} `) +
					theme.fg("dim", this.refreshStatus ?? "tab/ctrl+u/ctrl+s/ctrl+r · ⇞⇟/home-end"),
			),
		);
		lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));

		const maxStart = Math.max(0, this.filtered.length - LIST_ROWS);
		const start = Math.max(0, Math.min(this.selected - Math.floor(LIST_ROWS / 2), maxStart));
		// Numbers are absolute positions in the current view, so they stay stable while scrolling.
		const ordinalWidth = Math.max(2, String(this.filtered.length).length);
		for (let offset = 0; offset < LIST_ROWS; offset += 1) {
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
			const date = (bookmark.savedAt ?? "").slice(0, 10) || "----------";
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
			const text = `${marker} ${ordinal}  ${date}  ${author.padEnd(14)}  ${title}${badge}`;
			lines.push(
				row(
					index === this.selected
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg("muted", text),
				),
			);
		}
		lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));

		const bookmark = this.selectedBookmark();
		const detail = bookmark ? this.detail(bookmark) : null;
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
		lines.push(row(""));

		const note = bookmark?.context ? `📝 ${bookmark.context}` : "";
		const body = (detail?.content ?? bookmark?.description ?? "").replace(/\s+/g, " ").trim();
		const excerptLines = wrap([note, body].filter(Boolean).join("  ·  "), innerWidth, EXCERPT_ROWS);
		for (let index = 0; index < EXCERPT_ROWS; index += 1) {
			lines.push(row(theme.fg("text", excerptLines[index] ?? "")));
		}
		lines.push(row(""));

		const imageLines = bookmark ? (this.image(bookmark)?.render(innerWidth) ?? []) : [];
		for (let index = 0; index < IMAGE_ROWS; index += 1) {
			lines.push(row(imageLines[index] ?? ""));
		}

		lines.push(theme.fg("border", `└${"─".repeat(width - 2)}┘`));
		lines.push(
			theme.fg("dim", "  ↑↓ navigate · enter insert · ctrl+y copy · ctrl+o open · esc close"),
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
