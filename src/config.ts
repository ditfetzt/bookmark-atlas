import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atlasDataDir } from "./db.ts";

export type AtlasConfig = {
  /**
   * Browser providers to import from.
   *
   * `null` means every browser found, which is the default and what an absent
   * config file gives you. An empty array means none, which is a real choice
   * rather than a synonym for the default — switching every browser off in the
   * picker has to mean something.
   */
  browsers: string[] | null;
};

/** Settings live beside the database, so one directory holds everything. */
export function atlasConfigPath(): string {
  return join(atlasDataDir(), "config.json");
}

/**
 * A missing, unreadable, or malformed file all mean the same thing: the default.
 * Nothing here is worth failing a sync over, and every caller wants the default
 * rather than an error.
 */
export function readConfig(): AtlasConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(atlasConfigPath(), "utf8"));
  } catch {
    return { browsers: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { browsers: null };
  }
  const browsers = (parsed as { browsers?: unknown }).browsers;
  // Not an array means the key is absent or unusable, which is the default.
  if (!Array.isArray(browsers)) return { browsers: null };
  return { browsers: browsers.filter((value): value is string => typeof value === "string") };
}

export function writeConfig(config: AtlasConfig): void {
  const path = atlasConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  // "All" is the absence of the key, so the default is never written down.
  const body = config.browsers === null ? {} : { browsers: config.browsers };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}
