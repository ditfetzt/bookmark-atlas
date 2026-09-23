# Details

The long-form rationale behind decisions that the [README](../README.md) only
summarises. Everything here is behaviour you can rely on; it is separated out so
the README stays scannable.

## Where the database lives

The database and the compiled embedding helper live in a per-user data
directory (`~/Library/Application Support/bookmark-atlas/` on macOS), not in the
checkout.

Earlier versions defaulted to `./data/bookmarks.db`, resolved against whatever
directory the CLI happened to be started from. That was wrong in two ways: the
CLI and the palette could disagree about which file was "the" database, and
installed as a package it wrote a database inside `node_modules`. Both the CLI
and the extension now resolve the same per-user path.

`atlasDataDir()` exists twice — in `src/db.ts` and in
`extensions/bookmark-atlas/index.ts`. That is deliberate: when the extension is
symlinked into `~/.pi/agent/extensions`, a relative import resolves against the
symlink rather than the checkout, so it cannot import the shared module.
`test/db.test.ts` asserts the two copies agree, and fails if they drift.

If you moved from an older version, move `bookmarks.db` (and its `-wal`/`-shm`
siblings, if present) into the new directory, or set `BOOKMARK_ATLAS_DB` to
wherever you keep it.

## X bookmarks

### Accepted formats

The importer accepts Siftly native captures, Siftly normalized exports,
individual X API v2 response pages, and TweetXVault exports. Malformed entries
are skipped rather than discarding the whole import.

### Two fields derived, not copied

Two fields come from an X post's stored payload rather than being copied from
the export:

- **Title.** An article post is titled with the article's own title, not with
  its `t.co` link — the link says nothing about what the bookmark holds.
- **Author.** Taken from `core.user_results.result` when the export's own
  author fields are missing.

Import derives both every time. `enrich x-posts` repairs rows written before
those rules existed. It reads the payload already in the database, so it needs
no network and no re-export, and it is safe to re-run.

### The primary capture

The primary capture is the one worth reading: a GitHub README, else an X article
body, else the post text.

An X article post carries both an `x_article` capture and an `x_post` one, and
the `x_post` capture is either a bare `t.co` link or a scraped dump of the same
article — so the body wins, in `get` and in the palette alike.

### What is stored

| Data | Where |
| --- | --- |
| Post text | `captures` kind `x_post`, chunked and FTS-indexed |
| Full X article body | `captures` kind `x_article`, chunked and FTS-indexed |
| Link title / description | `captures` kind `x_link`, FTS-indexed |
| Media (photos, videos, GIFs, article media) | `x_media` with type, dimensions, duration, MIME, byte size, sha256, and an absolute `local_path` |
| Raw TweetXVault payload | `x_posts.raw_json` |

Media files are never copied. `x_media.local_path` points into TweetXVault's
media folder, so if you move that folder the paths go stale.

### `capture x`

Starts a loopback-only receiver on `127.0.0.1:41009`. The supported browser
bridge is Ego Browser: it observes X network responses through CDP and POSTs
native tweet batches to `/session/start`, `/session/batch`, and
`/session/complete`.

The `X-Bookmark-Atlas-Session-Token` header is required, and the token is read
only from `BOOKMARK_ATLAS_X_CAPTURE_TOKEN`. Cookies are not accepted.

### TweetXVault and LanceDB

TweetXVault 0.2.5 resolves LanceDB 0.38, which rejects empty vector columns
during `merge_insert` (`Vector column 'embedding' has variable length vectors`).
Pin the last working version in TweetXVault's isolated environment:

```bash
uv pip install --python "$(uv tool dir)/tweetxvault/bin/python" 'lancedb==0.34.0'
```

## Removal is never a delete

Reconciliation sets `saves.unsaved_at` so the history survives a re-add. That
means unstarred repositories and unbookmarked posts accumulate as rows nothing
can see.

`prune` deletes resources with no active save, along with their captures,
chunks, embeddings, media references, and full-text row. `--dry-run` reports the
count without touching anything.

## Sort and date semantics

`ctrl+s` cycles `newest` → `oldest` → `stars` → `A–Z`. Sorting by stars swaps
the date column for the star count (`★ 390.3k`, `★ 12.3k`). A bookmark with no
star count — every X post — reads `★ —` and sorts below all of them, because
there is no star count to rank it by.

`best match` joins the cycle once you have typed a query. Without one there is
nothing to be relevant to, so the base order is simply newest-first and is
labelled `newest`.

X bookmarks carry no save date from TweetXVault, so the date sorts and the date
column fall back to when this database first saw them — the same fallback the
base ordering uses, which keeps the two consistent.

## Palette search ranking

Typing searches two things at once. A bookmark whose title, author, description,
or URL literally contains what you typed ranks first, with title matches ahead
of the rest; then bookmarks found only inside their captured README, post, or
article text, ordered by keyword relevance; then looser letter-by-letter
matches, which is what makes partial typing work.

`ctrl+e` opens a reading pane: the list and the image give way to the full
README, post, or article text, wrapped and scrolled with `↑↓` (a page at a time
with `Fn+↑`/`Fn+↓`). `esc` returns to the list without closing the palette. The
overlay keeps the same height, so nothing jumps when you toggle it.

## Semantic search — experimental, off by default

`scripts/macos-embed.swift` uses the sentence-embedding model built into macOS
(512 dimensions, no download, no network, no third-party dependency).
`node src/cli.ts embed` compiles it once, embeds every content chunk
incrementally, and stores the vectors in SQLite. `recall --semantic` (or
`BOOKMARK_ATLAS_SEMANTIC=1`) then adds a cosine-similarity ranking to the RRF
fusion.

It is off by default because it did not earn its place: measured against this
corpus, the macOS model ranked short, generic X posts above the substantive
READMEs, and results with and without it were nearly identical — matching the
earlier finding that FTS beat the local macOS embedding model on the retrieval
benchmark.

It is kept as an opt-in seam for a stronger model. Point
`BOOKMARK_ATLAS_EMBED_BIN` at any binary that maps a JSON array of strings to a
JSON array of vectors. A real sentence-transformer (for example through ONNX) or
an embedding API is what would actually move the needle.
