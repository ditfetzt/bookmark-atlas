# Bookmark Atlas

<img src="assets/palette.svg" alt="The /bookmarks palette: typing a query narrows the list to the bookmarks that match" width="820">

Turn your GitHub stars and X bookmarks into a local, searchable knowledge base for coding agents. Everything lives in one SQLite file, with full-text search over titles, descriptions, topics, and the captured text of every README, post, and article you saved.

Three read-only interfaces over that one database: a **CLI**, an **MCP server**, and a `/bookmarks` palette inside [pi](https://pi.dev).

No web dashboard, no hosted API, no background service, and no runtime dependencies — Node's standard library and its built-in SQLite only.

## Install

```bash
pi install npm:bookmark-atlas      # palette extension + agent skill
npm install -g bookmark-atlas      # the CLI
```

From source:

```bash
git clone https://github.com/ditfetzt/bookmark-atlas.git
cd bookmark-atlas
npm install
node src/cli.ts status
```

## Quick start

```bash
node src/cli.ts sync github             # import your starred repositories
node src/cli.ts enrich github-readmes   # fetch the README text behind them
node src/cli.ts search "local-first agents"
```

## Requirements

- Node.js 24 or newer — the code uses the built-in `node:sqlite` with FTS5 and Node's native TypeScript type stripping, so there is no build step.
- GitHub CLI authenticated with `gh auth login`, or a `BOOKMARK_ATLAS_GITHUB_TOKEN`.
- Optional: [TweetXVault](https://github.com/lhl/tweetxvault) on `PATH` for `collect x`, or [Ego Browser](https://lite.ego.app/) for `capture x`.

GitHub credentials resolve in this order: `BOOKMARK_ATLAS_GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Tokens are never written to the database or to logs.

## Commands

| Command | What it does |
| --- | --- |
| `sync github [--limit N]` | Incremental GitHub star sync (metadata only) |
| `enrich github-readmes` | Fetch README text; incremental and ETag-aware |
| `enrich x-posts` | Repair X titles and authors from the stored payload |
| `import x-json <file>` | Import a Siftly or TweetXVault export |
| `collect x [--fast]` | Full X pass via TweetXVault; `--fast` skips media |
| `capture x` | Receive X responses from the Ego Browser bridge |
| `search <query> [--limit N]` | Keyword search across metadata and captured text |
| `recall <task> [--repo .]` | Rank bookmarks against a task and the current project |
| `recall --stage [focus]` | Derive the stage from git, then rank against it |
| `related <id>` | What relates to one bookmark, and why |
| `get <id> [--content]` | One source's metadata, optionally with its full text |
| `note <id> "text"` \| `--clear` | Attach a searchable note explaining why it matters |
| `embed` | Build optional on-device embeddings (macOS) |
| `status` | Counts and sync state |
| `prune [--dry-run]` | Delete resources with no active save |
| `mcp` | MCP server over stdio |

`sync github` imports metadata only — run `enrich github-readmes` to fetch the actual text. Re-running is cheap. See [docs/details.md](docs/details.md) for import quirks, `prune` semantics, and the sort and date rules.

## Recall — bookmarks as context for the agent

`recall` ranks your library against a task, biased by the project you are in. It reads `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, and `Cargo.toml` for dependency and language signals, then fuses four independent rankings — resource text, chunk passages, metadata, and project context — with Reciprocal Rank Fusion rather than summing them into one flat score.

```bash
node src/cli.ts recall "reduce cache invalidation latency" --repo . --limit 5
```

Every hit carries `whyMatched` reasons and its best matching passage. When a question is too vague to rank on its own words, the project's name and README intro are added as context terms, so "is there anything that helps here?" still lands in the project's domain.

`recall --stage` derives where the project is from git — branch, recent commit subjects, and the files in play — instead of making you describe it:

```bash
node src/cli.ts recall --stage "multi-tenant sync" --repo . --limit 8
```

In pi, `/consult [focus]` does the same and opens the palette pre-ranked. Nothing is ever injected into your prompt unless you ask.

**Notes are the strongest signal.** Attach one to any bookmark explaining why it matters; they are searchable, returned by `get` and `recall`, and shown in the palette.

```bash
node src/cli.ts note 406 "Closest blueprint: hybrid BM25+vector with RRF"
```

## pi palette

`/bookmarks [query]` opens an overlay that searches titles *and* the captured text of everything you saved, with a text preview and inline images.

```text
/bookmarks local-first agents
```

`↑↓` navigate · `Fn+←/→` first/last · `Fn+↑/↓` ten rows · `tab` source filter · `ctrl+a` hide archived · `ctrl+d` last 7 days · `ctrl+t` topic picker · `ctrl+l` pivot to related · `ctrl+s` cycle sort · `ctrl+r` fetch new bookmarks · `ctrl+e` read full text · `ctrl+n` write a note · `ctrl+x` mark for multi-insert · `enter` insert · `ctrl+y` copy URL · `ctrl+o` open in browser · `?` help · `esc` close

Rows are numbered by position in the current view, so the number stays stable while you scroll, filter, or sort. `enter` inserts the bookmark — or every marked one, separated by `---` — into the editor, note included. The extension registers exactly two commands, `/bookmarks` and `/consult [focus]`, and opens its database connection read-only.

Install it from npm (above), or point a local checkout at your data by symlink:

```bash
ln -s "$PWD/extensions/bookmark-atlas" ~/.pi/agent/extensions/bookmark-atlas
```

## MCP

The same read-only retrieval core is available over stdio:

```json
{
  "mcpServers": {
    "bookmark-atlas": {
      "command": "node",
      "args": ["/absolute/path/to/bookmark-atlas/src/cli.ts", "mcp"]
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `search_bookmarks` | Keyword search across titles, descriptions, topics, and captured content |
| `suggest_for_task` | Rank saved bookmarks against a task and the current project's dependencies |
| `get_bookmark` | One source's metadata, optionally with captured content |
| `related_bookmarks` | Sources related to one source, with the reasons why |

All four are read-only. Returned bookmark and README text is always marked `untrusted_external_content` — agents must treat it as evidence to quote or analyse, never as instructions to follow.

## Where your data lives

By default the database and the compiled embedding helper sit in your per-user data directory, never in the checkout or inside an installed package:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/bookmark-atlas/` |
| Linux | `$XDG_DATA_HOME/bookmark-atlas/` or `~/.local/share/bookmark-atlas/` |
| Windows | `%LOCALAPPDATA%\bookmark-atlas\` |

| Variable | Purpose |
| --- | --- |
| `BOOKMARK_ATLAS_DB` | Full SQLite path (overrides the data directory) |
| `BOOKMARK_ATLAS_DATA_DIR` | Data directory (default above) |
| `BOOKMARK_ATLAS_GITHUB_TOKEN` | GitHub token (falls back to `GH_TOKEN` or `gh auth token`) |
| `BOOKMARK_ATLAS_TWEETXVAULT_BIN` | TweetXVault executable (default `tweetxvault`) |
| `BOOKMARK_ATLAS_TWEETXVAULT_DIR` | TweetXVault data dir, used to resolve media paths |
| `BOOKMARK_ATLAS_X_CAPTURE_TOKEN` | Required token for `capture x` |
| `BOOKMARK_ATLAS_EMBED_BIN` | Override the embedding helper binary |

The database is **not encrypted**, and it holds the full text of everything you saved. It is gitignored for that reason — do not commit it, and do not point `BOOKMARK_ATLAS_DB` at a shared or synced folder unless you accept that.

## Credits

Built on other people's work. Nothing here is a fork, and no code was copied from another project — but these are the pieces it stands on:

- **[pi](https://pi.dev)** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) — the extension API, and the TUI primitives the palette is assembled from: `Image`, `Input`, `fuzzyMatch`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `getNativeClipboard`.
- **[nicobailon/pi-skill-palette](https://github.com/nicobailon/pi-skill-palette)** — the overlay interaction the `/bookmarks` palette is modelled on.
- **[SQLite FTS5](https://sqlite.org/fts5.html)** — the `porter` tokenizer and `bm25()` ranking do the stemming and the scoring; this project only ranks and fuses their output.
- **Reciprocal Rank Fusion** — Cormack, Clarke & Buettcher, *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009. The fusion in `src/recall.ts`.
- **[lhl/tweetxvault](https://github.com/lhl/tweetxvault)** (Apache-2.0) — `collect x` drives its CLI to archive X bookmarks.
- **[Ego Browser](https://lite.ego.app/)** — the CDP bridge that `capture x` receives native tweet batches from.
- **Apple NaturalLanguage** — `scripts/macos-embed.swift` calls `NLEmbedding` for the optional on-device embeddings.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks a pull request should pass. Security issues go through [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE) © Mæxim
