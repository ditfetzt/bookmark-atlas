# Contributing

Thanks for taking a look. This is a small, deliberately dependency-light
project — issues and pull requests are welcome.

## Getting set up

Requires Node.js 24 or newer (the code uses the built-in `node:sqlite` with
FTS5 and Node's native TypeScript type stripping — there is no build step).

```bash
git clone https://github.com/ditfetzt/bookmark-atlas.git
cd bookmark-atlas
npm install
npm run typecheck
npm test
```

Tests run against temporary SQLite databases and committed fixtures, so no
GitHub token, no network, and no personal bookmarks database are needed.

## Before opening a pull request

1. `npm run typecheck` passes.
2. `npm test` passes (69 tests at the time of writing).
3. New behaviour comes with a test in `test/`. Tests use the built-in
   `node:test` runner and `node:assert/strict` — no test framework.

## What the code looks like

- TypeScript, ESM, run directly by Node. Imports use explicit `.ts`
  extensions, which Node resolves natively.
- `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are
  on. Please keep them satisfied rather than casting around them.
- Two-space indent in `src/` and `test/`, tabs in `extensions/`; see
  `.editorconfig`. There is no formatter or linter configured — match the
  surrounding code.
- Prefer the standard library and Node built-ins. A new runtime dependency
  needs a reason in the pull request; the current set is zero.
- `data/` is gitignored and holds personal bookmarks. Never commit a database,
  a capture, or an export.

## Reporting bugs

Open an issue with the command you ran, what you expected, and what happened.
If it involves your own data, redact titles and URLs — a minimal reproduction
is worth more than a real dump.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a
public issue.
