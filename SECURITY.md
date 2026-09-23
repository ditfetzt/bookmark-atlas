# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/ditfetzt/bookmark-atlas/security/advisories/new)
rather than in a public issue.

Include what you did, what happened, and what you expected. A proof of concept
against a scratch database is ideal. Please do not include your real
bookmarks database, captured post text, or tokens.

Expect an initial response within a week. There is no bug bounty.

## Scope

Bookmark Atlas is a local, single-user tool. It is worth understanding what it
does and does not defend against.

**What it defends against:**

- GitHub tokens are never written to the database, to logs, or to captured
  content. They are resolved at call time from `BOOKMARK_ATLAS_GITHUB_TOKEN`,
  `GH_TOKEN`, or `gh auth token`.
- Captured README and post text is external, attacker-influenceable content.
  Every read path marks it `untrusted_external_content` so an agent treats it
  as evidence to quote, never as instructions to follow.
- The pi palette extension opens its database connection read-only.
- `capture x` binds to loopback only (`127.0.0.1`) and requires the
  `BOOKMARK_ATLAS_X_CAPTURE_TOKEN` header. It rejects cookies.

**What it does not defend against:**

- Anyone with read access to your filesystem can read the database. It is not
  encrypted. It lives in your per-user data directory (see the README).
- The database stores full post and README text, and `x_media.local_path`
  points at files under TweetXVault's media directory. Both are as sensitive
  as your bookmark history.
- `data/` is gitignored for this reason. Do not commit a database, and do not
  point `BOOKMARK_ATLAS_DB` at a synced or shared folder unless you accept that.

## Supported versions

The latest published version receives fixes. This is a personal project
maintained on a best-effort basis.
