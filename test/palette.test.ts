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

/** The palette hides `selected`; the test only needs the observable cursor. */
function palette(count = 50): { handleInput(data: string): void; selected: number } {
  const items = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `Bookmark ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    type: "github_repo",
    savedAt: "2024-01-01",
    useCount: 0,
  }));
  return new BookmarkPalette(items as never, {} as never, () => {}) as unknown as {
    handleInput(data: string): void;
    selected: number;
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
