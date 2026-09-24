# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-24

Installing Bookmark Atlas no longer drags the pi coding agent's dependency tree along with
it. Nothing about how the package runs changed — this release only corrects what npm installs
next to it.

### Highlights

- **A plain `npm install bookmark-atlas` went from 147 packages to 1.** npm installs `peerDependencies` automatically, and ours pointed at the pi packages, so a bare install pulled in `openai`, `google-auth-library`, `protobufjs`, `esbuild` and the rest of pi's tree. Marking them optional stops that. pi still supplies both to the palette at runtime, which is the only place they are used.

### Fixed

- `peerDependenciesMeta` marks `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` optional. The CLI imports neither, so a consumer who only wants the command now installs one package instead of 148. This matches what the most-downloaded pi package does.

## [0.1.0] - 2026-09-23

Bookmark Atlas turns your starred GitHub repositories and saved X bookmarks into a local,
searchable knowledge base for coding agents. This first release ships three read-only
interfaces over one SQLite file: a CLI, an MCP server over stdio, and a `/bookmarks` palette
inside pi. There is no account, no hosted API, no background service, and no runtime
dependency — Node's standard library and its built-in SQLite only.

### Highlights

- **Search the text, not just the titles.** Full-text search runs across titles, descriptions, topics, and the entire captured text of every README, post, and article you saved. A query for something you only ever read once still finds it.
- **Recall ranks your library against the task in front of you.** It reads the current project's manifests for dependency and language signals, combines four independent rankings with Reciprocal Rank Fusion rather than one flat score, and reports *why* each hit matched.
- **Three interfaces, one database.** A CLI for scripts, an MCP server for other harnesses, and a palette inside pi. All three read; nothing reaches your prompt unless you ask for it.
- **Your data stays yours.** One SQLite file in your per-user data directory. Not encrypted, never uploaded, and gitignored so it cannot follow the project into a commit.

### Added

- GitHub star sync with `sync github`: incremental, ETag-aware, and safe to re-run.
- README capture with `enrich github-readmes`, so search reaches the text behind a repository rather than its description alone.
- X bookmark import from Siftly captures and exports, X API v2 pages, and TweetXVault exports. An X article post is titled with the article's own title rather than its `t.co` link, and `enrich x-posts` repairs rows written before that rule existed.
- Full-text search with `search`, task-aware ranking with `recall` (including `--stage`, which derives the current stage from git), `related`, `get`, and `note`.
- An MCP server (`mcp`) exposing `search_bookmarks`, `suggest_for_task`, `get_bookmark`, and `related_bookmarks`. All four read, and captured text is always marked `untrusted_external_content`.
- A `/bookmarks` palette for pi, with topic, archived, and recency filters, a sort cycle, a reading pane, notes, multi-insert, and a related pivot.
- An agent skill that teaches a harness to run recall and search against the same database.
- A tag-driven release workflow: pushing `vX.Y.Z` checks the tag against `package.json`, publishes with provenance over OIDC trusted publishing, and opens this release from this file.
- A `zizmor` workflow auditing the workflows themselves.

### Changed

- **The database moved out of the working directory** into your per-user data directory (`~/Library/Application Support/bookmark-atlas` on macOS, `~/.local/share/bookmark-atlas` on Linux, `%LOCALAPPDATA%\bookmark-atlas` on Windows). It previously resolved against whatever directory the CLI was started from, which let the CLI and the palette disagree about which file was the database, and wrote a database inside `node_modules` when installed as a package. `BOOKMARK_ATLAS_DB` still overrides the full path.
- The README is a front door; the long-form reasoning lives in [docs/details.md](docs/details.md).

### Removed

- **Semantic search, and the on-device embedding stack behind it.** It was off by default and measured as no better than keyword ranking on this corpus, so keeping it meant carrying a schema, a compiled Swift helper, and two environment variables for a future model that does not exist yet. Keyword ranking and RRF are what score.

### Fixed

- **The published `bin` pointed at `src/cli.ts`, which Node refuses to run from inside `node_modules`.** Every global install would have received a `bookmark-atlas` command that crashed on first use, and the palette's note and refresh actions failed the same way. The package now ships compiled JavaScript in `dist/`, and CI refuses to publish a tarball without `dist/cli.js`.
- The palette tokenized queries with 33 fewer stop words than the CLI, so the same query could rank differently in the two. The lists are identical now, and a test fails if they drift apart again.
- `--help` no longer advertises a `use` command that was removed with usage tracking.
- `--help` prints the database path it will actually use, instead of a hardcoded string that had gone stale.

[0.1.1]: https://github.com/ditfetzt/bookmark-atlas/releases/tag/v0.1.1
[0.1.0]: https://github.com/ditfetzt/bookmark-atlas/releases/tag/v0.1.0
