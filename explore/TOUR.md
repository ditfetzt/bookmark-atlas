# Bookmark Atlas - Reading Tour

About one hour. Read the stops in order. Line numbers come from the 2026-10-05 exploration and may drift.

## 1. `README.md` (10 min)
What the tool is for and how to install it (CLI, pi package, MCP). Note the three ways to use it: CLI, MCP tools, pi palette. Skip the long key tables on first read.

## 2. `package.json` (3 min)
Look at `bin` (`./dist/cli.js`), `engines` (Node 24+), the `scripts` block, the `pi` block (extension and skill entries), and the empty `dependencies`. The project has no runtime dependencies.

## 3. `src/cli.ts` (8 min)
The single entry point. Read `main()` (line 70) and the if-chain of commands. Notice the pattern: open the database (line 78), run one command, close it in `finally`. The `recall` branch (line 136) is the best flow to follow first.

## 4. `src/db.ts` (8 min)
Schema in `migrate()` (lines 22-186), the FTS5 tables (lines 177 and 273), the state-sniffing migrations (lines 191-295), and the path rules (lines 413-428). Notice: no version number, and `schema_meta` is never read.

## 5. `src/github.ts` then `src/enrich.ts` (8 min)
How stars arrive: token lookup (github.ts:52-61), paging with ETag (233-262), the "unsaved" marking (303). Then how READMEs are fetched with limited workers and a size cap (enrich.ts:198-215).

## 6. `src/x.ts`, `src/collector.ts`, `src/receiver.ts` (10 min)
Three ways X bookmarks enter: a file import (x.ts:721), the `tweetxvault` subprocess (collector.ts:42-56), and the local browser receiver with token and CORS checks (receiver.ts:6-104). Skim x.ts for the accepted formats. It is the second-largest module.

## 7. `src/search.ts` (5 min)
The simple path. Tokenize, drop stop words, query `resources_fts` with column weights (line 127).

## 8. `src/recall.ts` and `src/stage.ts` (12 min)
The core idea. `stage.ts` turns git state into text. `recall()` (line 496) fuses six rank lists (lines 538-546), applies coverage filters (568-581) and bonuses (593-657). Read the constants at the top first (lines 27-64).

## 9. `src/mcp.ts` (4 min)
Four read-only tools over JSON-RPC on stdio (tools at lines 42-95, dispatch at line 119). It shows the "bookmark text is untrusted" message to clients (line 141).

## 10. `extensions/bookmark-atlas/index.ts` (10 min, skim)
The biggest file. Do not read it top to bottom. Find the default export (line 1227), the two commands (1228 and 1267), `runCli` (315), and the refresh action that chains sync, collect and enrich (651-653).

## 11. `test/` (5 min)
`test/palette.test.ts` (28 tests, mirrors the extension), `test/parity.test.ts` (checks search, recall and the extension stay in step), `test/db.test.ts` (checks the two copies of `atlasDataDir`).

## 12. `.github/workflows/release.yml` and `docs/details.md` (5 min)
How a tag becomes an npm release with provenance. Then the written reasons behind the data-dir move and the duplicated function.

Next: run `node src/cli.ts status` and `node src/cli.ts search "agents"` against your own database.
