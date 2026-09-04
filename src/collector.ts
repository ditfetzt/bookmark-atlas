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
  executable?: string;
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

export function collectXBookmarks(db: AtlasDatabase, options: CollectXOptions = {}): XImportResult & { exportPath?: string } {
  const executable = options.executable ?? process.env.BOOKMARK_ATLAS_TWEETXVAULT_BIN ?? "tweetxvault";
  const directory = mkdtempSync(join(tmpdir(), "bookmark-atlas-x-"));
  const exportPath = join(directory, "bookmarks.json");
  try {
    const syncArgs = ["sync", "bookmarks"];
    if (options.full) syncArgs.push("--full");
    run(executable, syncArgs);
    run(executable, ["export", "json", "--output", exportPath]);
    const result = importXJsonFile(db, exportPath, options.account ? { account: options.account } : {});
    return options.keepExport ? { ...result, exportPath } : result;
  } finally {
    if (!options.keepExport) rmSync(directory, { recursive: true, force: true });
  }
}
