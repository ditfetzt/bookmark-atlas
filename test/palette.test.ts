import assert from "node:assert/strict";
import test from "node:test";
import { BookmarkPalette } from "../extensions/bookmark-atlas/index.ts";

// Raw terminal sequences as macOS terminals emit them: Fn+←/→ is home/end,
// Fn+↑/↓ is pageUp/pageDown. Cmd+↑/↓ is `\x1b[1;9A`/`\x1b[1;9B` where forwarded.
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CMD_UP = "\x1b[1;9A";
const CMD_DOWN = "\x1b[1;9B";

type Harness = {
  handleInput(data: string): void;
  refresh(): Promise<void>;
  selected: number;
  notice: string | null;
  showHelp: boolean;
  reading: boolean;
  noteEdit: { id: number; input: { getValue(): string } } | null;
  preview: { id: number; offset: number } | null;
  topic: string | null;
  topicPicker: { entries: Array<{ name: string; count: number }>; index: number } | null;
  sortMode: string;
  filtered: Array<{ id: number; title: string }>;
  input: { getValue(): string; setValue(value: string): void };
  /** Every action the palette reported through its done callback. */
  actions: unknown[];
};

type ItemSeed = {
  title: string;
  archived?: number;
  topics?: string[];
  savedAt?: string;
  useCount?: number;
  stars?: number;
};

/** The palette hides its state; the test only needs the observable cursor and status. */
function paletteItems(seeds: ItemSeed[], options: Record<string, unknown> = {}): Harness {
  const items = seeds.map((seed, index) => ({
    id: index + 1,
    title: seed.title,
    url: `https://example.com/${index + 1}`,
    type: "github_repo",
    savedAt: seed.savedAt ?? "2024-01-01",
    useCount: seed.useCount ?? 0,
    archived: seed.archived ?? 0,
    stars: seed.stars ?? null,
    topics: JSON.stringify(seed.topics ?? []),
  }));
  const actions: unknown[] = [];
  const palette = new BookmarkPalette(
    items as never,
    {} as never,
    (action) => actions.push(action),
    options as never,
  ) as unknown as Harness;
  palette.actions = actions;
  return palette;
}

function paletteOf(titles: string[], options: Record<string, unknown> = {}): Harness {
  return paletteItems(
    titles.map((title) => ({ title })),
    options,
  );
}

function palette(count = 50, options: Record<string, unknown> = {}): Harness {
  return paletteOf(
    Array.from({ length: count }, (_, index) => `Bookmark ${index + 1}`),
    options,
  );
}

function typeQuery(list: Harness, query: string): void {
  list.input.setValue("");
  for (const character of query) list.handleInput(character);
}

const CTRL_R = "\x12";
const CTRL_E = "\x05";
const CTRL_N = "\x0e";
const CTRL_A = "\x01";
const CTRL_D = "\x04";
const CTRL_T = "\x14";
const CTRL_S = "\x13";
const F1 = "\x1bOP";
const ESCAPE = "\x1b";

/** A stand-in for the CLI that records each call and returns a chosen payload. */
function fakeRunner(handler: (args: string[]) => { ok: boolean; stdout: string }): {
  calls: string[];
  run: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args.join(" "));
      return { stderr: "", ...handler(args) };
    },
  };
}

test("home and end jump to the first and last bookmark", () => {
  const list = palette(50);
  list.handleInput(PAGE_DOWN);
  list.handleInput(HOME);
  assert.equal(list.selected, 0);
  list.handleInput(END);
  assert.equal(list.selected, 49);
  list.handleInput(HOME);
  assert.equal(list.selected, 0);
});

test("page keys move by the visible row count and clamp at both ends", () => {
  const list = palette(50);
  list.handleInput(PAGE_DOWN);
  assert.equal(list.selected, 10);
  list.handleInput(PAGE_DOWN);
  assert.equal(list.selected, 20);
  list.handleInput(PAGE_UP);
  assert.equal(list.selected, 10);
  list.handleInput(PAGE_UP);
  list.handleInput(PAGE_UP);
  assert.equal(list.selected, 0);
  list.handleInput(PAGE_UP);
  assert.equal(list.selected, 0);

  const short = palette(4);
  short.handleInput(PAGE_DOWN);
  assert.equal(short.selected, 3);
});

test("Cmd+arrow pages when the terminal forwards the super modifier", () => {
  const list = palette(50);
  list.handleInput(CMD_DOWN);
  assert.equal(list.selected, 10);
  list.handleInput(CMD_UP);
  assert.equal(list.selected, 0);
});

test("refresh runs every source in order and reports what changed", async () => {
  const { calls, run } = fakeRunner((args) => ({
    ok: true,
    stdout: JSON.stringify(args[0] === "enrich" ? { enriched: 25 } : { imported: 3 }),
  }));
  const list = palette(50, { cliRunner: run });
  await list.refresh();
  assert.deepEqual(calls, ["sync github", "collect x --fast", "enrich github-readmes --limit 25"]);
  assert.equal(list.notice, "✓ GitHub +3 · X +3 · READMEs +25");
});

test("ctrl+r starts a refresh without waiting for it", () => {
  const { run } = fakeRunner(() => ({ ok: true, stdout: "{}" }));
  const list = palette(50, { cliRunner: run });
  list.handleInput(CTRL_R);
  assert.match(list.notice ?? "", /refreshing GitHub/);
});

test("a failed step is reported and does not stop the rest", async () => {
  const { calls, run } = fakeRunner((args) =>
    args[0] === "collect" ? { ok: false, stdout: "" } : { ok: true, stdout: JSON.stringify({ imported: 1, enriched: 1 }) },
  );
  const list = palette(9, { cliRunner: run });
  await list.refresh();
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["sync", "collect", "enrich"]);
  assert.equal(list.notice, "⚠ GitHub +1 · X failed · READMEs +1");
});

test("a step reporting no change reads as such", async () => {
  const { run } = fakeRunner(() => ({ ok: true, stdout: JSON.stringify({ imported: 0, enriched: 0 }) }));
  const list = palette(50, { cliRunner: run });
  await list.refresh();
  assert.equal(list.notice, "✓ GitHub no change · X no change · READMEs no change");
});

test("? opens help only while the search box is empty", () => {
  const list = palette(50);
  list.handleInput("?");
  assert.equal(list.showHelp, true);

  list.handleInput("x"); // any key returns to the list, and is not typed
  assert.equal(list.showHelp, false);
  assert.equal(list.input.getValue(), "");

  list.handleInput("o");
  list.handleInput("a");
  list.handleInput("?");
  assert.equal(list.showHelp, false);
  assert.equal(list.input.getValue(), "oa?");
});

test("a word-aligned match outranks a scattered subsequence match", () => {
  // Both match "abc", but only the first is contiguous, so only it should lead.
  const list = paletteOf(["a big catalog", "ABC tools"]);
  typeQuery(list, "abc");
  assert.deepEqual(
    list.filtered.map((bookmark) => bookmark.title),
    ["ABC tools", "a big catalog"],
  );
});

test("a query with no real metadata match keeps every candidate", () => {
  const list = paletteOf(["zzz tokenizer zzz", "nothing here"]);
  typeQuery(list, "tknzr");
  assert.equal(list.filtered.length, 1);
});

test("a query literally in a title leads even when looser matches abound", () => {
  // The fuzzy scorer scans greedily from the left, so on a long title it credits
  // scattered letters and can rank the real match fifth. A literal hit wins.
  const list = paletteItems([
    { title: "GargantuaX/gemini-watermark-remover" },
    { title: "mail-in-a-box/mailinabox" },
    { title: "How I write motion graphics prompts for MiniMax H3 Max" },
  ]);
  typeQuery(list, "minimax");
  assert.equal(list.filtered[0]?.title, "How I write motion graphics prompts for MiniMax H3 Max");
});

test("ctrl+e opens the reading pane and esc returns without closing", () => {
  const list = paletteOf(["Bookmark one"]);
  list.handleInput(CTRL_E);
  assert.equal(list.reading, true);

  // esc leaves the reading pane; it must not cancel the whole palette.
  list.handleInput(ESCAPE);
  assert.equal(list.reading, false);
  assert.deepEqual(list.actions, []);

  list.handleInput(ESCAPE);
  assert.deepEqual(list.actions, [{ action: "cancel" }]);
});

test("the reading pane scrolls and stops at the top", () => {
  const list = paletteOf(["Bookmark one"]);
  list.handleInput(CTRL_E);
  list.handleInput("\x1b[A"); // up, with nothing above
  assert.equal(list.preview?.offset ?? 0, 0);
  list.handleInput("\x1b[A");
  list.handleInput("\x1b[A");
  assert.equal(list.preview?.offset ?? 0, 0);
});

test("enter still inserts from the reading pane", () => {
  const list = paletteOf(["Bookmark one"]);
  list.handleInput(CTRL_E);
  list.handleInput("\r");
  assert.deepEqual(list.actions, [{ action: "insert", id: 1 }]);
});

test("ctrl+n writes a note through the CLI, and esc cancels without writing", async () => {
  const { calls, run } = fakeRunner(() => ({ ok: true, stdout: "{}" }));
  const list = paletteOf(["Bookmark one"], { cliRunner: run });

  list.handleInput(CTRL_N);
  assert.equal(list.noteEdit?.id, 1);
  for (const character of "why it matters") list.handleInput(character);
  assert.equal(list.noteEdit?.input.getValue(), "why it matters");

  // esc must abandon the edit without writing and without closing the palette.
  list.handleInput(ESCAPE);
  assert.equal(list.noteEdit, null);
  assert.deepEqual(calls, []);
  assert.deepEqual(list.actions, []);

  list.handleInput(CTRL_N);
  for (const character of "why it matters") list.handleInput(character);
  list.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["note 1 why it matters"]);
  assert.equal(list.notice, "✎ note saved");
});

test("a failed note write is reported and the note is rolled back", async () => {
  const { run } = fakeRunner(() => ({ ok: false, stdout: "" }));
  const list = paletteOf(["Bookmark one"], { cliRunner: run });
  list.handleInput(CTRL_N);
  for (const character of "temporary") list.handleInput(character);
  list.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(list.notice, "✎ note not saved");
  assert.equal(list.filtered[0]?.title, "Bookmark one");
});

test("hide archived drops archived repositories", () => {
  const list = paletteItems([{ title: "live" }, { title: "dead", archived: 1 }]);
  assert.equal(list.filtered.length, 2);
  list.handleInput(CTRL_A);
  assert.deepEqual(list.filtered.map((bookmark) => bookmark.title), ["live"]);
  list.handleInput(CTRL_A);
  assert.equal(list.filtered.length, 2);
});

test("the recent filter keeps only bookmarks inside the window", () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const list = paletteItems([
    { title: "fresh", savedAt: new Date().toISOString() },
    { title: "stale", savedAt: old },
  ]);
  list.handleInput(CTRL_D);
  assert.deepEqual(list.filtered.map((bookmark) => bookmark.title), ["fresh"]);
});

test("the topic picker ranks topics and filters by the chosen one", () => {
  const list = paletteItems([
    { title: "one", topics: ["llm", "rag"] },
    { title: "two", topics: ["llm"] },
    { title: "three", topics: ["design"] },
  ]);
  list.handleInput(CTRL_T);
  // "All topics" is always first, so clearing the filter is one keystroke away.
  assert.equal(list.topicPicker?.entries[0]?.name, "");
  assert.deepEqual(
    list.topicPicker?.entries.slice(1).map((entry) => [entry.name, entry.count]),
    [["llm", 2], ["design", 1], ["rag", 1]],
  );
  list.handleInput("\x1b[B"); // down, onto llm
  list.handleInput("\r");
  assert.equal(list.topic, "llm");
  assert.deepEqual(list.filtered.map((bookmark) => bookmark.title), ["one", "two"]);
});

test("abandoning the topic picker leaves the filter alone", () => {
  const list = paletteItems([{ title: "one", topics: ["llm"] }]);
  list.handleInput(CTRL_T);
  list.handleInput("\x1b[B");
  list.handleInput(ESCAPE);
  assert.equal(list.topicPicker, null);
  assert.equal(list.topic, null);
  assert.equal(list.filtered.length, 1);
  assert.deepEqual(list.actions, []);
});

test("the sort cycle never steps onto a view identical to the current one", () => {
  const list = paletteItems([{ title: "a" }, { title: "b" }]);
  // No query: the base order is newest-first, so it is labelled newest and the
  // first step must go to oldest rather than to a duplicate of where we started.
  assert.equal(list.sortMode, "relevance");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "oldest");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "stars");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "alpha");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "newest");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "oldest");
});

test("with a query the sort cycle offers relevance as well", () => {
  const list = paletteItems([{ title: "alpha one" }]);
  typeQuery(list, "alpha");
  list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "newest");
  for (let step = 0; step < 4; step += 1) list.handleInput(CTRL_S);
  assert.equal(list.sortMode, "relevance");
});

test("sorting by stars puts unstarred bookmarks last", () => {
  const list = paletteItems([
    { title: "few", stars: 3 },
    { title: "none" },
    { title: "many", stars: 900 },
  ]);
  list.handleInput(CTRL_S); // oldest
  list.handleInput(CTRL_S); // stars
  assert.equal(list.sortMode, "stars");
  assert.deepEqual(
    list.filtered.map((bookmark) => bookmark.title),
    ["many", "few", "none"],
  );
});

test("oldest and newest fall back to the row's own date when it has no save date", () => {
  const list = paletteItems([
    { title: "saved-late", savedAt: "2024-06-01" },
    { title: "saved-early", savedAt: "2024-01-01" },
  ]);
  list.handleInput(CTRL_S);
  assert.deepEqual(list.filtered.map((bookmark) => bookmark.title), ["saved-early", "saved-late"]);
});

test("f1 opens help and any key returns to the list", () => {
  const list = palette(50);
  list.handleInput(F1);
  assert.equal(list.showHelp, true);
  list.handleInput(PAGE_DOWN);
  assert.equal(list.showHelp, false);
  assert.equal(list.selected, 0);
});
