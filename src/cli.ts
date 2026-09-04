#!/usr/bin/env node
import { databasePath, openDatabase, openReadOnlyDatabase } from "./db.ts";
import { syncGitHubStars } from "./github.ts";
import { getResource, searchResources } from "./search.ts";
import { enrichGitHubReadmes } from "./enrich.ts";
import { importXJsonFile } from "./x.ts";
import { runRetrievalBenchmark } from "./benchmark.ts";
import { buildSnapshot, installSnapshot } from "./snapshot.ts";
import { collectXBookmarks } from "./collector.ts";
import { startXCaptureServer } from "./receiver.ts";
import { startDashboardServer } from "./dashboard.ts";
import { startAgentApiServer } from "./agent-api.ts";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) break;
    if (argument.startsWith("--")) index += 1;
    else result.push(argument);
  }
  return result;
}

function printHelp(): void {
  console.log(`Bookmark Atlas

Usage:
  bookmark-atlas sync github [--limit N] [--account NAME]
  bookmark-atlas import x-json <file> [--account NAME]
  bookmark-atlas collect x [--account NAME] [--full] [--keep-export]
  bookmark-atlas capture x [--port N]
  bookmark-atlas dashboard [--port N]
  bookmark-atlas agent-api [--port N]
  bookmark-atlas benchmark retrieval [--cases FILE]
  bookmark-atlas snapshot build <output> [--version N]
  bookmark-atlas snapshot install <source> <manifest> <destination>
  bookmark-atlas enrich github-readmes [--limit N] [--concurrency N]
  bookmark-atlas search <query> [--limit N]
  bookmark-atlas search <query> --snapshot FILE
  bookmark-atlas get <resource-id> [--content]
  bookmark-atlas status

Environment:
  BOOKMARK_ATLAS_DB             SQLite path (default: ./data/bookmarks.db)
  BOOKMARK_ATLAS_GITHUB_TOKEN   GitHub token (falls back to GH_TOKEN or gh auth token)
  BOOKMARK_ATLAS_TWEETXVAULT_BIN TweetXVault executable (default: tweetxvault)
  BOOKMARK_ATLAS_X_CAPTURE_TOKEN Required token for local browser capture receiver
  BOOKMARK_ATLAS_AGENT_TOKEN    Optional Bearer token for the read-only agent API
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "snapshot" && args[1] === "install") {
    const [source, manifest, destination] = args.slice(2, 5);
    if (!source || !manifest || !destination) {
      throw new Error("snapshot install requires source, manifest, and destination paths");
    }
    console.log(JSON.stringify(await installSnapshot(source, manifest, destination), null, 2));
    return;
  }

  const snapshotPath = command === "search" ? optionValue(args, "--snapshot") : undefined;
  const db = snapshotPath ? openReadOnlyDatabase(snapshotPath) : openDatabase(databasePath());
  try {
    if (command === "collect" && args[1] === "x") {
      const account = optionValue(args, "--account");
      const result = collectXBookmarks(db, {
        ...(account ? { account } : {}),
        full: args.includes("--full"),
        keepExport: args.includes("--keep-export"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "capture" && args[1] === "x") {
      const token = process.env.BOOKMARK_ATLAS_X_CAPTURE_TOKEN;
      if (!token) throw new Error("Set BOOKMARK_ATLAS_X_CAPTURE_TOKEN before starting capture x");
      const rawPort = optionValue(args, "--port");
      const port = rawPort ? Number.parseInt(rawPort, 10) : 41009;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535");
      const capture = await startXCaptureServer({ db, token, port });
      console.log(JSON.stringify({ listening: capture.address, endpoints: ["/session/start", "/session/batch", "/session/complete"] }, null, 2));
      await new Promise<void>((resolve, reject) => {
        const stop = () => capture.close().then(resolve, reject);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return;
    }

    if (command === "dashboard") {
      const rawPort = optionValue(args, "--port");
      const port = rawPort ? Number.parseInt(rawPort, 10) : 4173;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535");
      const dashboard = await startDashboardServer(db, { port, host: process.env.BOOKMARK_ATLAS_HOST ?? "127.0.0.1" });
      console.log(JSON.stringify({ listening: dashboard.address }, null, 2));
      await new Promise<void>((resolve, reject) => {
        const stop = () => dashboard.close().then(resolve, reject);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return;
    }

    if (command === "agent-api") {
      const rawPort = optionValue(args, "--port");
      const port = rawPort ? Number.parseInt(rawPort, 10) : 4180;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535");
      const token = process.env.BOOKMARK_ATLAS_AGENT_TOKEN;
      const api = await startAgentApiServer(db, { port, host: process.env.BOOKMARK_ATLAS_HOST ?? "127.0.0.1", ...(token ? { token } : {}) });
      console.log(JSON.stringify({ listening: api.address, endpoints: ["/v1/health", "/v1/search?q=...", "/v1/recent", "/v1/resources/:id", "/v1/resources/:id/related"] }, null, 2));
      await new Promise<void>((resolve, reject) => {
        const stop = () => api.close().then(resolve, reject);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return;
    }

    if (command === "sync" && args[1] === "github") {
      const rawLimit = optionValue(args, "--limit");
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      if (rawLimit && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
        throw new Error("--limit must be a positive integer");
      }
      const account = optionValue(args, "--account");
      const result = await syncGitHubStars(db, {
        ...(account ? { account } : {}),
        ...(limit ? { limit } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "search") {
      const query = positional(args.slice(1)).join(" ").trim();
      if (!query) throw new Error("search requires a query");
      const limit = Number.parseInt(optionValue(args, "--limit") ?? "10", 10);
      console.log(JSON.stringify(searchResources(db, query, limit), null, 2));
      return;
    }

    if (command === "import" && args[1] === "x-json") {
      const file = args[2];
      if (!file || file.startsWith("--")) throw new Error("import x-json requires a file path");
      const account = optionValue(args, "--account");
      console.log(JSON.stringify(importXJsonFile(db, file, account ? { account } : {}), null, 2));
      return;
    }

    if (command === "benchmark" && args[1] === "retrieval") {
      const cases = optionValue(args, "--cases") ?? "eval/retrieval-cases.json";
      console.log(JSON.stringify(runRetrievalBenchmark(db, cases), null, 2));
      return;
    }

    if (command === "snapshot" && args[1] === "build") {
      const output = args[2];
      if (!output || output.startsWith("--")) throw new Error("snapshot build requires an output path");
      const rawVersion = optionValue(args, "--version");
      const version = rawVersion ? Number.parseInt(rawVersion, 10) : undefined;
      if (rawVersion && (!Number.isSafeInteger(version) || (version ?? 0) < 1)) {
        throw new Error("--version must be a positive safe integer");
      }
      console.log(JSON.stringify(await buildSnapshot(db, output, version), null, 2));
      return;
    }

    if (command === "enrich" && args[1] === "github-readmes") {
      const limit = Number.parseInt(optionValue(args, "--limit") ?? "25", 10);
      const concurrency = Number.parseInt(optionValue(args, "--concurrency") ?? "4", 10);
      if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive integer");
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new Error("--concurrency must be a positive integer");
      }
      console.log(
        JSON.stringify(await enrichGitHubReadmes(db, { limit, concurrency }), null, 2),
      );
      return;
    }

    if (command === "get") {
      const id = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(id) || id < 1) throw new Error("get requires a numeric resource id");
      const resource = getResource(db, id, args.includes("--content"));
      if (!resource) throw new Error(`resource ${id} not found`);
      console.log(JSON.stringify(resource, null, 2));
      return;
    }

    if (command === "status") {
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM resources) AS resources,
          (SELECT COUNT(*) FROM saves WHERE unsaved_at IS NULL) AS activeSaves,
          (SELECT COUNT(*) FROM resources_fts) AS indexedResources,
          (SELECT COUNT(*) FROM captures WHERE kind = 'github_readme') AS readmeCaptures,
          (SELECT COUNT(*) FROM x_posts) AS xPosts,
          (SELECT COUNT(*) FROM chunks) AS chunks
      `).get();
      const sync = db.prepare(`
        SELECT i.provider, i.account, c.high_watermark AS highWatermark,
               c.last_success_at AS lastSuccessAt, c.last_reconciled_at AS lastReconciledAt,
               c.last_error AS lastError
        FROM integrations i
        LEFT JOIN sync_checkpoints c ON c.integration_id = i.id
        ORDER BY i.provider, i.account
      `).all();
      console.log(JSON.stringify({ database: databasePath(), counts, sync }, null, 2));
      return;
    }

    throw new Error(`Unknown command: ${args.join(" ")}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
