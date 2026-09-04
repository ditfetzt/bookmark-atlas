import { spawnSync } from "node:child_process";
import { refreshResourceFts, type AtlasDatabase } from "./db.ts";

type GitHubOwner = {
  login: string;
};

export type GitHubRepository = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  owner: GitHubOwner;
  default_branch: string;
  license: { spdx_id: string | null } | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics: string[];
  archived: boolean;
  pushed_at: string | null;
  updated_at: string | null;
};

export type GitHubStar = {
  starred_at: string;
  repo: GitHubRepository;
};

export type SyncOptions = {
  account?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  token?: string;
};

export type SyncResult = {
  status: "completed" | "not_modified";
  fetched: number;
  imported: number;
  updated: number;
  removed: number;
  pages: number;
};

const API_VERSION = "2026-03-10";

export function resolveGitHubToken(): string {
  const environmentToken =
    process.env.BOOKMARK_ATLAS_GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (environmentToken) return environmentToken;

  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) {
    throw new Error(
      "GitHub authentication unavailable. Set BOOKMARK_ATLAS_GITHUB_TOKEN or run gh auth login.",
    );
  }
  return token;
}

function ensureIntegration(db: AtlasDatabase, account: string): number {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integrations (provider, account, created_at, updated_at)
    VALUES ('github', ?, ?, ?)
    ON CONFLICT(provider, account) DO UPDATE SET updated_at = excluded.updated_at
  `).run(account, now, now);

  const row = db
    .prepare("SELECT id FROM integrations WHERE provider = 'github' AND account = ?")
    .get(account) as { id: number };
  return row.id;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

function upsertStar(
  db: AtlasDatabase,
  integrationId: number,
  star: GitHubStar,
): "imported" | "updated" {
  const now = new Date().toISOString();
  const repo = star.repo;
  const existing = db
    .prepare("SELECT id FROM resources WHERE canonical_url = ?")
    .get(repo.html_url) as { id: number } | undefined;

  db.prepare(`
    INSERT INTO resources (
      canonical_url, resource_type, title, author, description, language,
      availability_status, created_at, updated_at
    ) VALUES (?, 'github_repository', ?, ?, ?, ?, 'available', ?, ?)
    ON CONFLICT(canonical_url) DO UPDATE SET
      title = excluded.title,
      author = excluded.author,
      description = excluded.description,
      language = excluded.language,
      availability_status = 'available',
      updated_at = excluded.updated_at
  `).run(
    repo.html_url,
    repo.full_name,
    repo.owner.login,
    repo.description,
    repo.language,
    now,
    now,
  );

  const resource = db
    .prepare("SELECT id FROM resources WHERE canonical_url = ?")
    .get(repo.html_url) as { id: number };

  db.prepare(`
    INSERT INTO saves (
      integration_id, provider_external_id, resource_id, saved_at,
      provider_metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', ?, ?)
    ON CONFLICT(integration_id, provider_external_id) DO UPDATE SET
      resource_id = excluded.resource_id,
      saved_at = excluded.saved_at,
      unsaved_at = NULL,
      updated_at = excluded.updated_at
  `).run(integrationId, repo.node_id, resource.id, star.starred_at, now, now);

  db.prepare(`
    INSERT INTO github_repositories (
      resource_id, github_id, node_id, owner, name, full_name,
      default_branch, license_spdx, stars, forks, open_issues, topics,
      archived, pushed_at, github_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET
      github_id = excluded.github_id,
      node_id = excluded.node_id,
      owner = excluded.owner,
      name = excluded.name,
      full_name = excluded.full_name,
      default_branch = excluded.default_branch,
      license_spdx = excluded.license_spdx,
      stars = excluded.stars,
      forks = excluded.forks,
      open_issues = excluded.open_issues,
      topics = excluded.topics,
      archived = excluded.archived,
      pushed_at = excluded.pushed_at,
      github_updated_at = excluded.github_updated_at
  `).run(
    resource.id,
    repo.id,
    repo.node_id,
    repo.owner.login,
    repo.name,
    repo.full_name,
    repo.default_branch,
    repo.license?.spdx_id ?? null,
    repo.stargazers_count,
    repo.forks_count,
    repo.open_issues_count,
    JSON.stringify(repo.topics ?? []),
    repo.archived ? 1 : 0,
    repo.pushed_at,
    repo.updated_at,
  );

  refreshResourceFts(db, resource.id);

  return existing ? "updated" : "imported";
}

export async function syncGitHubStars(
  db: AtlasDatabase,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const account = options.account ?? "authenticated-user";
  const integrationId = ensureIntegration(db, account);
  const token = options.token ?? resolveGitHubToken();
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = new Date().toISOString();
  const run = db.prepare(`
    INSERT INTO sync_runs (integration_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(integrationId, startedAt);
  const runId = Number(run.lastInsertRowid);
  const checkpoint = db
    .prepare("SELECT etag, is_complete AS isComplete FROM sync_checkpoints WHERE integration_id = ?")
    .get(integrationId) as { etag: string | null; isComplete: number } | undefined;

  let url: string | null =
    "https://api.github.com/user/starred?sort=created&direction=desc&per_page=100";
  let firstPage = true;
  let firstEtag: string | null = null;
  let pages = 0;
  const stars: GitHubStar[] = [];

  try {
    while (url && (!options.limit || stars.length < options.limit)) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.star+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "bookmark-atlas/0.1",
      };
      if (firstPage && checkpoint?.etag && checkpoint.isComplete === 1) {
        headers["If-None-Match"] = checkpoint.etag;
      }

      const response = await fetchImpl(url, { headers });
      if (firstPage && response.status === 304) {
        const etag = checkpoint?.etag;
        if (!etag) throw new Error("GitHub returned 304 without a stored ETag");
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO sync_checkpoints (
            integration_id, etag, is_complete, last_checked_at, last_success_at
          ) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(integration_id) DO UPDATE SET
            last_checked_at = excluded.last_checked_at,
            last_success_at = excluded.last_success_at,
            last_error = NULL
        `).run(integrationId, etag, now, now);
        db.prepare(`
          UPDATE sync_runs SET status = 'not_modified', completed_at = ? WHERE id = ?
        `).run(now, runId);
        return { status: "not_modified", fetched: 0, imported: 0, updated: 0, removed: 0, pages: 1 };
      }
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
      }

      if (firstPage) firstEtag = response.headers.get("etag");
      const page = (await response.json()) as GitHubStar[];
      stars.push(...page);
      pages += 1;
      url = parseNextLink(response.headers.get("link"));
      firstPage = false;
    }

    const selected = options.limit ? stars.slice(0, options.limit) : stars;
    let imported = 0;
    let updated = 0;
    let removed = 0;
    const seen = new Set<string>();

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const star of selected) {
        seen.add(star.repo.node_id);
        const outcome = upsertStar(db, integrationId, star);
        if (outcome === "imported") imported += 1;
        else updated += 1;
      }

      if (!options.limit) {
        const active = db
          .prepare("SELECT id, provider_external_id FROM saves WHERE integration_id = ? AND unsaved_at IS NULL")
          .all(integrationId) as Array<{ id: number; provider_external_id: string }>;
        const now = new Date().toISOString();
        const markRemoved = db.prepare("UPDATE saves SET unsaved_at = ?, updated_at = ? WHERE id = ?");
        for (const save of active) {
          if (!seen.has(save.provider_external_id)) {
            markRemoved.run(now, now, save.id);
            removed += 1;
          }
        }
      }

      const completedAt = new Date().toISOString();
      const highWatermark = selected[0]?.starred_at ?? null;
      db.prepare(`
        INSERT INTO sync_checkpoints (
          integration_id, etag, is_complete, high_watermark, last_checked_at,
          last_success_at, last_reconciled_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(integration_id) DO UPDATE SET
          etag = excluded.etag,
          is_complete = excluded.is_complete,
          high_watermark = COALESCE(excluded.high_watermark, sync_checkpoints.high_watermark),
          last_checked_at = excluded.last_checked_at,
          last_success_at = excluded.last_success_at,
          last_reconciled_at = COALESCE(excluded.last_reconciled_at, sync_checkpoints.last_reconciled_at),
          last_error = NULL
      `).run(
        integrationId,
        firstEtag,
        options.limit ? 0 : 1,
        highWatermark,
        completedAt,
        completedAt,
        options.limit ? null : completedAt,
      );
      db.prepare(`
        UPDATE sync_runs SET status = 'completed', completed_at = ?,
          imported_count = ?, updated_count = ?, removed_count = ?
        WHERE id = ?
      `).run(completedAt, imported, updated, removed, runId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      status: "completed",
      fetched: selected.length,
      imported,
      updated,
      removed,
      pages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE sync_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?
    `).run(completedAt, message, runId);
    db.prepare(`
      INSERT INTO sync_checkpoints (integration_id, last_checked_at, last_error)
      VALUES (?, ?, ?)
      ON CONFLICT(integration_id) DO UPDATE SET
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error
    `).run(integrationId, completedAt, message);
    throw error;
  }
}
