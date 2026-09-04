import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.ts";
import { syncGitHubStars, type GitHubStar } from "../src/github.ts";

const star: GitHubStar = {
  starred_at: "2026-09-03T12:00:00Z",
  repo: {
    id: 42,
    node_id: "R_42",
    name: "atlas",
    full_name: "example/atlas",
    html_url: "https://github.com/example/atlas",
    description: "Search personal bookmarks for coding agents",
    language: "TypeScript",
    owner: { login: "example" },
    default_branch: "main",
    license: { spdx_id: "MIT" },
    stargazers_count: 12,
    forks_count: 2,
    open_issues_count: 1,
    topics: ["bookmarks", "agents"],
    archived: false,
    pushed_at: "2026-09-02T12:00:00Z",
    updated_at: "2026-09-02T12:00:00Z",
  },
};

const secondStar: GitHubStar = {
  ...star,
  starred_at: "2026-09-02T12:00:00Z",
  repo: {
    ...star.repo,
    id: 43,
    node_id: "R_43",
    name: "second-atlas",
    full_name: "example/second-atlas",
    html_url: "https://github.com/example/second-atlas",
  },
};

test("imports a GitHub star idempotently", async () => {
  const db = openDatabase(":memory:");
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify([star]), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"abc"' },
    });

  const first = await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });
  const second = await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM resources").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM saves").get() as { count: number }).count,
    1,
  );
  db.close();
});

test("preserves existing data on a not-modified response", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify([star]), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"abc"' },
      });
    }
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"abc"');
    return new Response(null, { status: 304 });
  };

  await syncGitHubStars(db, { account: "test", token: "test-token", fetchImpl: mockFetch });
  const result = await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(result.status, "not_modified");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM resources").get() as { count: number }).count,
    1,
  );
  db.close();
});

test("does not use a partial-import ETag to skip a later full sync", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    calls += 1;
    if (calls === 2) {
      assert.equal((init?.headers as Record<string, string>)["If-None-Match"], undefined);
    }
    return new Response(JSON.stringify([star]), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"abc"' },
    });
  };

  await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
    limit: 1,
  });
  await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(calls, 2);
  db.close();
});

test("follows GitHub pagination links", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const mockFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? [star] : [secondStar]), {
      status: 200,
      headers:
        calls === 1
          ? {
              "content-type": "application/json",
              link: '<https://api.github.com/user/starred?page=2>; rel="next"',
            }
          : { "content-type": "application/json" },
    });
  };

  const result = await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.imported, 2);
  assert.equal(calls, 2);
  db.close();
});

test("marks missing stars as unsaved during a full reconciliation", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const mockFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify(calls === 1 ? [star, secondStar] : [star]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });
  const result = await syncGitHubStars(db, {
    account: "test",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.equal(result.removed, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM saves WHERE unsaved_at IS NOT NULL").get() as { count: number }).count,
    1,
  );
  db.close();
});
