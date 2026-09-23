import assert from "node:assert/strict";
import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import { atlasDataDir, databasePath } from "../src/db.ts";
import { atlasDataDir as paletteDataDir } from "../extensions/bookmark-atlas/index.ts";

/** Run `body` with the named env vars set (undefined deletes), then restore. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The palette extension cannot import src/db.ts (a relative import would resolve
// against the symlink in ~/.pi/agent/extensions), so the rule is written twice.
// This is what stops the two copies drifting apart.
test("the CLI and the palette resolve the same data directory", () => {
  assert.equal(paletteDataDir(), atlasDataDir());
  withEnv({ BOOKMARK_ATLAS_DATA_DIR: "/tmp/atlas-drift-check" }, () => {
    assert.equal(paletteDataDir(), atlasDataDir());
  });
});

test("the data directory is absolute, per-user, and outside the checkout", () => {
  withEnv({ BOOKMARK_ATLAS_DATA_DIR: undefined }, () => {
    const dir = atlasDataDir();
    assert.ok(isAbsolute(dir), `${dir} must be absolute`);
    assert.ok(dir.startsWith(homedir()), `${dir} must live under ${homedir()}`);
    assert.equal(basename(dir), "bookmark-atlas");
    assert.ok(!dir.includes("node_modules"), `${dir} must not be inside an install`);
  });
});

test("BOOKMARK_ATLAS_DATA_DIR overrides the directory in both copies", () => {
  withEnv({ BOOKMARK_ATLAS_DATA_DIR: "/tmp/atlas-override" }, () => {
    assert.equal(atlasDataDir(), "/tmp/atlas-override");
    assert.equal(paletteDataDir(), "/tmp/atlas-override");
  });
});

test("the database defaults inside the data directory", () => {
  withEnv({ BOOKMARK_ATLAS_DATA_DIR: undefined, BOOKMARK_ATLAS_DB: undefined }, () => {
    assert.equal(databasePath(), join(atlasDataDir(), "bookmarks.db"));
    assert.ok(!databasePath().includes("node_modules"));
  });
});

test("BOOKMARK_ATLAS_DB still wins over the data directory", () => {
  withEnv({ BOOKMARK_ATLAS_DATA_DIR: "/tmp/atlas-ignored", BOOKMARK_ATLAS_DB: "/tmp/custom.db" }, () => {
    assert.equal(databasePath(), "/tmp/custom.db");
  });
});
