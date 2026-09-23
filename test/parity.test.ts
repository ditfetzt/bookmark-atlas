import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = readFileSync(join(ROOT, "src", "search.ts"), "utf8");
const RECALL = readFileSync(join(ROOT, "src", "recall.ts"), "utf8");
const PALETTE = readFileSync(join(ROOT, "extensions", "bookmark-atlas", "index.ts"), "utf8");

/** Pull the words out of a `const NAME = new Set([...])` declaration. */
function stopWords(source: string, name: string): string[] {
  const body = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\s*\\);`).exec(source)?.[1];
  assert.ok(body, `${name} not found in the source`);
  return [...new Set(body.match(/"[^"]+"/g) ?? [])].map((word) => word.slice(1, -1)).sort();
}

/** The weight list from a `bm25(resources_fts, ...)` call. */
function bm25Weights(source: string): string {
  const match = /bm25\(resources_fts,\s*([^)]*)\)/.exec(source);
  assert.ok(match, "no weighted bm25 call over resources_fts found");
  return match[1]!.replace(/\s+/g, "");
}

// The palette cannot import src/search.ts: when the extension is symlinked into
// ~/.pi/agent/extensions, a relative import resolves against the symlink rather
// than the checkout. So two rules are written twice, and these tests are what
// stop the copies drifting apart.
//
// They had already drifted once: the palette was missing 33 stop words, so the
// same query tokenized differently in the palette and in the CLI.
test("the palette tokenizes with the same stop words as the CLI", () => {
  assert.deepEqual(stopWords(PALETTE, "SEARCH_STOP_WORDS"), stopWords(CLI, "STOP_WORDS"));
});

test("every weighted bm25 call over resources_fts uses the same column weights", () => {
  const expected = bm25Weights(CLI);
  // Guards against someone replacing the literal with an interpolation, which
  // FTS5 cannot resolve and which the SQL-injection lint rightly rejects.
  assert.match(expected, /^[\d.]+(,[\d.]+)*$/, `expected a literal weight list, got "${expected}"`);
  assert.equal(bm25Weights(RECALL), expected);
  assert.equal(bm25Weights(PALETTE), expected);
});
