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
  refreshStatus: string | null;
  showHelp: boolean;
  filtered: Array<{ id: number; title: string }>;
  input: { getValue(): string; setValue(value: string): void };
};

/** The palette hides its state; the test only needs the observable cursor and status. */
function paletteOf(titles: string[], options: Record<string, unknown> = {}): Harness {
  const items = titles.map((title, index) => ({
    id: index + 1,
    title,
    url: `https://example.com/${index + 1}`,
    type: "github_repo",
    savedAt: "2024-01-01",
    useCount: 0,
  }));
  return new BookmarkPalette(items as never, {} as never, () => {}, options as never) as unknown as Harness;
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
const F1 = "\x1bOP";

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
  const list = palette(50, { refreshRunner: run });
  await list.refresh();
  assert.deepEqual(calls, ["sync github", "collect x --fast", "enrich github-readmes --limit 25"]);
  assert.equal(list.refreshStatus, "✓ GitHub +3 · X +3 · READMEs +25");
});

test("ctrl+r starts a refresh without waiting for it", () => {
  const { run } = fakeRunner(() => ({ ok: true, stdout: "{}" }));
  const list = palette(50, { refreshRunner: run });
  list.handleInput(CTRL_R);
  assert.match(list.refreshStatus ?? "", /refreshing GitHub/);
});

test("a failed step is reported and does not stop the rest", async () => {
  const { calls, run } = fakeRunner((args) =>
    args[0] === "collect" ? { ok: false, stdout: "" } : { ok: true, stdout: JSON.stringify({ imported: 1, enriched: 1 }) },
  );
  const list = palette(9, { refreshRunner: run });
  await list.refresh();
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["sync", "collect", "enrich"]);
  assert.equal(list.refreshStatus, "⚠ GitHub +1 · X failed · READMEs +1");
});

test("a step reporting no change reads as such", async () => {
  const { run } = fakeRunner(() => ({ ok: true, stdout: JSON.stringify({ imported: 0, enriched: 0 }) }));
  const list = palette(50, { refreshRunner: run });
  await list.refresh();
  assert.equal(list.refreshStatus, "✓ GitHub no change · X no change · READMEs no change");
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

test("f1 opens help and any key returns to the list", () => {
  const list = palette(50);
  list.handleInput(F1);
  assert.equal(list.showHelp, true);
  list.handleInput(PAGE_DOWN);
  assert.equal(list.showHelp, false);
  assert.equal(list.selected, 0);
});
