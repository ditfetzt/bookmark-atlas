# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-05

Bookmark Atlas now reads your browser bookmarks. Chrome, Brave, Edge, Chromium, Vivaldi,
Arc, Opera, Firefox and Safari are read from the files they already keep on disk — no export,
no extension, no account. A browser bookmark becomes an ordinary resource next to your stars
and posts, so the same search, the same recall ranking, and the same palette reach it.

### Highlights

- **Three readers cover every browser here.** Every Chromium browser writes the same `Bookmarks` file, so one reader handles Chrome, Brave, Edge, Chromium, Vivaldi, Arc, Opera and the Ego Browser at once. Safari and Firefox each needed their own — and Firefox turned out to be the cheapest of the three, because it already keeps its bookmarks in SQLite, which this project already uses.
- **A browser bookmark is not a second-class row.** It lands in the same three tables as a star or a post: an integration per browser profile, a resource per page, a save per bookmark. The folder, the save date, and the browser and profile it came from ride along in metadata. No new table, no new query path, no schema change.
- **The same page saved twice is one bookmark.** Canonicalisation strips tracking parameters, so a link bookmarked in Brave and again in Ego resolves to a single resource with two saves. A page that is both a starred repository and a bookmark resolves to one resource too, which is the difference between an atlas and four lists.
- **Your browser stays the source of truth.** Delete a bookmark and the next sync marks it removed. `prune` is what actually deletes, and it takes `--dry-run`.

### Added

- `sync browsers`, reading the Chromium family, Safari and Firefox, with `--browser` and `--profile` to narrow the run.
- `browsers`, which lists every source found and reports per-source read errors — the answer to "why is Safari empty?" without a stack trace.
- A **Browsers** filter in the palette: `tab` now cycles All → GitHub → X → Browsers.
- **A `ctrl+b` picker for choosing which browsers to import from**, plus `browsers --enable NAME,NAME|all|none` for the shell. The choice is stored in `config.json` beside the database, and switching a browser off hides its bookmarks from search and recall rather than only filtering the list — `tab` narrows what you see, but search and recall rank everything. The saves are marked removed rather than deleted, so switching a browser back on restores them, and `prune` stays the step that actually deletes.
- `bookmark-atlas browsers` reports, per browser, how many distinct pages it holds and how many of those exist in no other browser.
- **`enrich web-pages` indexes the text behind browser bookmarks.** A bookmark used to be a title and a URL, so search could only match what a page was called; now it reaches what is on the page. Batches are the point — each run walks the collection once, so `--limit 25` costs 25 fetches and the next run continues where that one stopped rather than retrying its failures. Re-runs are incremental on the ETag. The HTML is reduced to text by a small dependency-free extractor that drops `script`/`style`/comments, turns block boundaries into line breaks and decodes entities; a page that yields almost nothing (a JavaScript shell, a PDF, a login wall) is reported as `empty` rather than stored, so search is never told there is content where there is none.
- `status` now breaks down every fetch by kind and outcome — how many pages are `available`, `archived`, `empty` or `failed`, how many READMEs are `unchanged` — and reports `webPagesPending`: the pages still waiting for a first fetch.
- **`enrich web-pages` falls back to the Wayback Machine.** A block is usually aimed at the visitor, not the page, so a 403, a rate limit or a Cloudflare challenge is retried against the newest archived snapshot before it is called a failure. On a real collection that recovered 4 of 5 blocked pages, including one that headless Chromium could not get past. The capture records the snapshot URL as its source, so text always says where it came from, and the fetch state distinguishes `available` from `archived`.
- `ctrl+r` in the palette now syncs browsers as well, so a bookmark you add in your browser shows up without leaving pi. It runs last, because it is the cheapest step and the only one that can fail per source: a blocked Safari plist reports itself without stopping the rest.
- Browser bookmarks are indexed as `web_page` resources, so full-text search, `recall` and `related` reach them like anything else.
- Folders are recorded per save, next to the browser and profile the bookmark came from.

### Changed

- **Every development dependency is now at its latest release.** TypeScript 5.9 → 7.0, `@types/node` 24 → 26, and the pi packages 0.87 → 1.0.4. The source itself needed no changes: the only thing TypeScript 7 broke was an implicit source root, which is now pinned explicitly, and `@types/node` 26 matches the Node 26 that actually runs this project. The palette needed no port to pi 1.0 — it already guarded on `ctx.mode`, used `ctx.hasUI`, and passed `overlay: true` with a responsive width, which is what the 1.0 extension contract asks for.
- `sync browsers` is safe to re-run: a second pass updates rather than re-imports, and reports the two counts separately.
- Only `http` and `https` bookmarks are imported. `javascript:`, `chrome://` and `file://` entries are counted and skipped rather than stored as rows nothing can search or fetch.

### Fixed

- **A failed fetch no longer blocks a batch.** `enrich github-readmes --limit N` ordered its work by whether a fetch had ever succeeded, and a failure never records a success — so the same failures sat at the front of every batch and a limited run could never reach the rows behind them. Both enrichers now order by when a row was last *checked*, so batches make progress and failures are retried only after everything else has been tried.
- **Search returned resources that were no longer saved.** `searchResources` never filtered on an active save, while `recall` and the palette both did, so a repository you had unstarred — or a page whose browser you had switched off — stayed findable by search indefinitely. Search now excludes them, like everything else.
- **`http` and `https` for the same host were two resources.** The same link saved in two browsers rarely agrees on the scheme, and the `http://` side is almost always a stale address that redirects. `golem.de` was stored twice on a real collection.
- **Bookmarks from uninstalled browsers were imported.** Uninstalling a browser leaves its profile behind, and those leftovers were read as if the browser were still there — which is how Firefox's four stock `mozilla.org` bookmarks appear on a machine that has no Firefox. A browser is now only imported by default when its application is actually present, and an unknown browser is assumed installed rather than hidden on a guess.
- **The browser picker reported bookmark counts, which made it look like it did far more than it does.** Ego read `517` while contributing four pages, because four profiles held four copies of the same import. It now reports distinct pages and how many exist in no other browser, taken from the browser files rather than the database — a switched-off browser's saves are marked removed, so a database view reports nothing for exactly the browsers someone opens that list to decide about.
- `/bookmarks` now describes itself as searching GitHub stars, X posts, and browser bookmarks. It had said only stars and posts since the browser work landed.

### Notes

- **Safari needs Full Disk Access.** macOS protects `~/Library/Safari`, so the terminal running the sync has to be granted it in System Settings → Privacy & Security. Without it the sync reports the error for that one source and leaves every existing Safari bookmark untouched, rather than reading a blocked file as "you deleted everything".
- `--limit` imports a prefix of each source and deliberately skips deletion detection, because bookmarks that were not read are not bookmarks that went away.

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

[0.2.0]: https://github.com/ditfetzt/bookmark-atlas/releases/tag/v0.2.0
[0.1.1]: https://github.com/ditfetzt/bookmark-atlas/releases/tag/v0.1.1
[0.1.0]: https://github.com/ditfetzt/bookmark-atlas/releases/tag/v0.1.0
