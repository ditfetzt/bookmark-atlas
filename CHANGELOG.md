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
  `%LOCALAPPDATA%\bookmark-atlas` on Windows). The compiled embedding helper
  moved with it. `BOOKMARK_ATLAS_DB` still overrides the full path.

  To upgrade, move `bookmarks.db` (and any `-wal`/`-shm` siblings) into the new
  directory, or set `BOOKMARK_ATLAS_DB` to where you keep it.

- The README is now a front door; the long-form rationale lives in
  [docs/details.md](docs/details.md).

### Added

- First public release: GitHub star sync, X bookmark import, full-text search,
  task-aware recall, the `/bookmarks` pi palette, and the read-only MCP server.
- `assets/palette.svg`, an animated illustration of the palette.

### Fixed

- `--help` no longer advertises `use <resource-id>`. The command was removed
  with usage tracking in b013967, but its help line was left behind.
- The CLI's `--help` now prints the database path it will actually use, instead
  of a hardcoded string that had gone stale.

[Unreleased]: https://github.com/ditfetzt/bookmark-atlas/commits/main
