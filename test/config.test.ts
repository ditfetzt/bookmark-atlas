import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { atlasConfigPath, readConfig, writeConfig } from "../src/config.ts";

// The data directory is resolved when it is asked for, not when this module is
// imported, so pointing it here keeps every test in this file away from the real
// config. Each test file runs in its own process, so it cannot leak either.
const dir = mkdtempSync(join(tmpdir(), "atlas-config-"));
process.env.BOOKMARK_ATLAS_DATA_DIR = dir;

after(() => rmSync(dir, { recursive: true, force: true }));

test("a missing config means every browser", () => {
  rmSync(atlasConfigPath(), { force: true });
  assert.deepEqual(readConfig(), { browsers: null });
});

test("a chosen list round-trips", () => {
  writeConfig({ browsers: ["brave", "safari"] });
  assert.deepEqual(readConfig(), { browsers: ["brave", "safari"] });
  assert.deepEqual(JSON.parse(readFileSync(atlasConfigPath(), "utf8")), {
    browsers: ["brave", "safari"],
  });
});

test("an empty list means none, which is not the same as the default", () => {
  // Switching every browser off in the picker has to mean something, so `[]`
  // cannot be a synonym for "all".
  writeConfig({ browsers: [] });
  assert.deepEqual(readConfig(), { browsers: [] });
});

test("the default is stored as the absence of the key, not as a list", () => {
  // Writing every browser down would go stale the moment another is installed.
  writeConfig({ browsers: null });
  assert.deepEqual(JSON.parse(readFileSync(atlasConfigPath(), "utf8")), {});
  assert.deepEqual(readConfig(), { browsers: null });
});

test("a malformed config falls back to the default rather than failing", () => {
  writeFileSync(atlasConfigPath(), "{ not json");
  assert.deepEqual(readConfig(), { browsers: null });

  writeFileSync(atlasConfigPath(), JSON.stringify(["brave"]));
  assert.deepEqual(readConfig(), { browsers: null });

  writeFileSync(atlasConfigPath(), JSON.stringify({ browsers: "brave" }));
  assert.deepEqual(readConfig(), { browsers: null });
});

test("values that are not strings are dropped", () => {
  writeFileSync(atlasConfigPath(), JSON.stringify({ browsers: ["brave", 7, null, "safari"] }));
  assert.deepEqual(readConfig(), { browsers: ["brave", "safari"] });
});
