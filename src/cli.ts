#!/usr/bin/env node
import { databasePath, openDatabase, refreshResourceFts } from "./db.ts";
import { syncGitHubStars } from "./github.ts";
import { getResource, searchResources } from "./search.ts";
import { recall } from "./recall.ts";
import { buildEmbeddings, embedQuery, embeddingsAvailable } from "./embeddings.ts";
import { collectStage } from "./stage.ts";
import { recordUsage, usageCounts } from "./usage.ts";
import { enrichGitHubReadmes } from "./enrich.ts";
import { importXJsonFile, repairXPosts } from "./x.ts";
import { collectXBookmarks } from "./collector.ts";
import { startXCaptureServer } from "./receiver.ts";
import { startMcpServer } from "./mcp.ts";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Only these flags consume the next argument. Boolean flags (--stage, --fast,
// --semantic, --clear, ...) must not swallow the positional text that follows.
const VALUE_FLAGS = new Set([
  "--limit",
  "--repo",
  "--account",
  "--concurrency",
  "--port",
  "--cases",
]);

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) break;
    if (argument.startsWith("--")) {
      if (VALUE_FLAGS.has(argument)) index += 1;
      continue;
    }
    result.push(argument);
  }
  return result;
}

function printHelp(): void {
  console.log(`Bookmark Atlas — read your starred bookmarks and their content

Usage:
  bookmark-atlas sync github [--limit N] [--account NAME]
  bookmark-atlas enrich github-readmes [--limit N] [--concurrency N]
  bookmark-atlas enrich x-posts
  bookmark-atlas import x-json <file> [--account NAME] [--reconcile]
  bookmark-atlas collect x [--account NAME] [--full] [--fast] [--keep-export]
  bookmark-atlas capture x [--port N]
  bookmark-atlas search <query> [--limit N]
  bookmark-atlas recall <task> [--repo PATH] [--limit N] [--semantic] [--stage]
  bookmark-atlas embed [--limit N]
  bookmark-atlas get <resource-id> [--content]
  bookmark-atlas note <resource-id> <text...> [--clear]
  bookmark-atlas use <resource-id> [--open]
  bookmark-atlas status
  bookmark-atlas mcp

Environment:
  BOOKMARK_ATLAS_DB              SQLite path (default: ./data/bookmarks.db)
  BOOKMARK_ATLAS_GITHUB_TOKEN    GitHub token (falls back to GH_TOKEN or gh auth token)
  BOOKMARK_ATLAS_TWEETXVAULT_BIN TweetXVault executable (default: tweetxvault)
  BOOKMARK_ATLAS_X_CAPTURE_TOKEN Required token for the local browser capture receiver
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const db = openDatabase(databasePath());
  try {
    if (command === "collect" && args[1] === "x") {
      const account = optionValue(args, "--account");
      const result = collectXBookmarks(db, {
        ...(account ? { account } : {}),
        full: args.includes("--full"),
        fast: args.includes("--fast"),
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

    if (command === "mcp") {
      await startMcpServer(db);
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

    if (command === "recall") {
      const focus = positional(args.slice(1)).join(" ").trim();
      const useStage = args.includes("--stage");
      if (!focus && !useStage) throw new Error("recall requires a task description");
      const explicitRepo = optionValue(args, "--repo");
      const repoPath = explicitRepo ?? (useStage ? process.cwd() : undefined);
      // --stage derives "where the project is now" from git so the caller does
      // not have to describe the current state by hand.
      const stage = useStage && repoPath ? collectStage(repoPath, focus) : null;
      if (!focus && !stage) throw new Error("recall found nothing to work with; pass a task description");
      const limit = Number.parseInt(optionValue(args, "--limit") ?? "5", 10);
      // Semantic ranking is opt-in: measured against this corpus it did not beat
      // keyword ranking. See the README.
      const semantic = args.includes("--semantic") || process.env.BOOKMARK_ATLAS_SEMANTIC === "1";
      const queryVector = semantic ? embedQuery(db, focus || stage?.description || "") : null;
      if (stage) process.stderr.write(`stage: branch=${stage.branch ?? "?"} · ${stage.commits.length} commits · ${stage.files.length} files\n`);
      console.log(
        JSON.stringify(
          recall(db, {
            task: focus,
            ...(repoPath ? { repoPath } : {}),
            ...(stage ? { stage: stage.description } : {}),
            limit,
            queryVector,
          }),
          null,
          2,
        ),
      );
      return;
    }

    if (command === "use") {
      const id = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(id) || id < 1) throw new Error("use requires a numeric resource id");
      const action = args.includes("--open") ? "open" : "insert";
      recordUsage(db, id, action);
      console.log(JSON.stringify({ id, action }, null, 2));
      return;
    }

    if (command === "embed") {
      const rawLimit = optionValue(args, "--limit");
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      if (rawLimit && (!Number.isSafeInteger(limit) || (limit ?? 0) < 1)) {
        throw new Error("--limit must be a positive integer");
      }
      console.log(JSON.stringify(buildEmbeddings(db, limit ? { limit } : {}), null, 2));
      return;
    }

    if (command === "import" && args[1] === "x-json") {
      const file = args[2];
      if (!file || file.startsWith("--")) throw new Error("import x-json requires a file path");
      const account = optionValue(args, "--account");
      console.log(
        JSON.stringify(
          importXJsonFile(db, file, {
            ...(account ? { account } : {}),
            reconcile: args.includes("--reconcile"),
          }),
          null,
          2,
        ),
      );
      return;
    }

    if (command === "enrich" && args[1] === "x-posts") {
      console.log(JSON.stringify(repairXPosts(db), null, 2));
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

    if (command === "note") {
      const id = Number.parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(id) || id < 1) throw new Error("note requires a numeric resource id");
      const text = positional(args.slice(2)).join(" ").trim();
      if (!text || args.includes("--clear")) {
        db.prepare("DELETE FROM resource_notes WHERE resource_id = ?").run(id);
      } else {
        db.prepare(`
          INSERT INTO resource_notes (resource_id, context, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(resource_id) DO UPDATE SET
            context = excluded.context, updated_at = excluded.updated_at
        `).run(id, text, new Date().toISOString());
      }
      refreshResourceFts(db, id);
      const row = db.prepare("SELECT context FROM resource_notes WHERE resource_id = ?").get(id) as
        | { context: string }
        | undefined;
      console.log(JSON.stringify({ id, context: row?.context ?? null }, null, 2));
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
          (SELECT COUNT(*) FROM chunks) AS chunks,
          (SELECT COUNT(*) FROM chunk_embeddings) AS embeddedChunks
      `).get();
      const sync = db.prepare(`
        SELECT i.provider, i.account, c.high_watermark AS highWatermark,
               c.last_success_at AS lastSuccessAt, c.last_reconciled_at AS lastReconciledAt,
               c.last_error AS lastError
        FROM integrations i
        LEFT JOIN sync_checkpoints c ON c.integration_id = i.id
        ORDER BY i.provider, i.account
      `).all();
      console.log(
        JSON.stringify(
          {
            database: databasePath(),
            embeddings: embeddingsAvailable(),
            counts,
            usage: usageCounts(db),
            sync,
          },
          null,
          2,
        ),
      );
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
