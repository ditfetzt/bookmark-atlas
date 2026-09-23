import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasDatabase } from "./db.ts";
import { importXJsonFile, type XImportResult } from "./x.ts";

export type CollectXOptions = {
  account?: string;
  full?: boolean;
  keepExport?: boolean;
  fast?: boolean;
};

function run(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw new Error(`Unable to run ${executable}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${executable} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

// Keep updating the X integration that already holds the most saves, so a
// collection import does not duplicate saves under a second account.
function resolveXAccount(db: AtlasDatabase, explicit?: string): string {
  if (explicit) return explicit;
  const row = db.prepare(`
    SELECT account FROM integrations
    WHERE provider = 'x'
    ORDER BY (SELECT COUNT(*) FROM saves WHERE saves.integration_id = integrations.id) DESC, id
    LIMIT 1
  `).get() as { account: string } | undefined;
  return row?.account ?? "tweetxvault";
}

export function collectXBookmarks(db: AtlasDatabase, options: CollectXOptions = {}): XImportResult & { exportPath?: string } {
  const executable = process.env.BOOKMARK_ATLAS_TWEETXVAULT_BIN ?? "tweetxvault";
  const directory = mkdtempSync(join(tmpdir(), "bookmark-atlas-x-"));
  const exportPath = join(directory, "bookmarks.json");
  try {
    const syncArgs = ["sync", "bookmarks"];
    if (options.full) syncArgs.push("--full");
    // --fast keeps every text source (posts, articles, link unfurls) but skips
    // the multi-gigabyte media download. The full pass stays the default.
    if (options.fast) syncArgs.push("--skip-media");
    run(executable, syncArgs);
    run(executable, ["export", "json", "--collection", "bookmarks", "--out", exportPath]);
    const result = importXJsonFile(db, exportPath, {
      account: resolveXAccount(db, options.account),
      reconcile: true,
    });
    return options.keepExport ? { ...result, exportPath } : result;
  } finally {
    if (!options.keepExport) rmSync(directory, { recursive: true, force: true });
  }
}
