# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The database moved to a per-user data directory.** It previously defaulted
  to `./data/bookmarks.db` relative to the working directory, which let the CLI
  and the palette disagree about which file was the database, and wrote a
  database inside `node_modules` when installed as a package. Both now resolve
  `$BOOKMARK_ATLAS_DATA_DIR` (default: `~/Library/Application Support/bookmark-atlas`
  on macOS, `~/.local/share/bookmark-atlas` on Linux,
  `%LOCALAPPDATA%\bookmark-atlas` on Windows). `BOOKMARK_ATLAS_DB` still
  overrides the full path.

  To upgrade, move `bookmarks.db` (and any `-wal`/`-shm` siblings) into the new
  directory, or set `BOOKMARK_ATLAS_DB` to where you keep it.

- The README is now a front door; the long-form rationale lives in
  [docs/details.md](docs/details.md).

### Removed

- **Semantic search, and the on-device embedding stack behind it.** It was off
  by default and measured as no better than keyword ranking, so it was kept only
  as a seam for a future model. Gone with it: `src/embeddings.ts`,
  `scripts/macos-embed.swift`, the `embed` command, the `recall --semantic` flag
  and `BOOKMARK_ATLAS_SEMANTIC`, `BOOKMARK_ATLAS_EMBED_BIN`, and the
  `chunk_embeddings` and `embedding_cache` tables. Opening an existing database
  now drops those two tables, so the vectors they held are released.
- Four option fields no caller ever set: `XImportOptions.maxFileBytes`,
  `EnrichOptions.maxBytes`, `CollectXOptions.executable` (the
  `BOOKMARK_ATLAS_TWEETXVAULT_BIN` env var already covers it), and
  `XCaptureServerOptions.host`. The capture receiver is now hard-wired to
  loopback rather than merely defaulting to it.
- `--cases`, a leftover in the flag parser from the benchmark command.

### Added

- First public release: GitHub star sync, X bookmark import, full-text search,
  task-aware recall, the `/bookmarks` pi palette, and the read-only MCP server.
- `assets/palette.svg`, an animated illustration of the palette.
- A tag-driven release workflow: pushing `vX.Y.Z` checks the tag against
  `package.json`, runs the suite through `prepublishOnly`, publishes to npm with
  provenance via OIDC trusted publishing, and opens a GitHub release.
- A `zizmor` workflow auditing the workflows themselves for Actions footguns.
- `publishConfig.access: public` in `package.json`, so the package cannot be
  published private by accident.

### Fixed

- **The published `bin` pointed at `src/cli.ts`, which Node will not run from
  inside `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Every
  global install got a `bookmark-atlas` command that crashed on first use, and
  the palette's note and refresh actions failed the same way. The package now
  ships `dist/`, compiled by `tsc`, and the `bin` and the palette both use it.
  CI refuses to publish a tarball without `dist/cli.js`.
- `--help` no longer advertises `use <resource-id>`. The command was removed
  with usage tracking in b013967, but its help line was left behind.
- The CLI's `--help` now prints the database path it will actually use, instead
  of a hardcoded string that had gone stale.
- The palette tokenized queries with 33 fewer stop words than the CLI, so the
  same query could rank differently in the two. The lists are now identical, and
  `test/parity.test.ts` fails if they drift apart again.

[Unreleased]: https://github.com/ditfetzt/bookmark-atlas/commits/main
