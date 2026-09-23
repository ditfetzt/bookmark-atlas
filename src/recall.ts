import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AtlasDatabase } from "./db.ts";
import { vectorRank } from "./embeddings.ts";
import { getResource, searchResources, tokenize, type SearchResult } from "./search.ts";

export type RecallOptions = {
  task: string;
  repoPath?: string;
  limit?: number;
  /** Precomputed query embedding; omit to skip semantic ranking. */
  queryVector?: number[] | null;
  /** Where the project is right now (recent work); adds secondary context terms. */
  stage?: string;
};

export type RecallHit = SearchResult & {
  whyMatched: string[];
  passage: string | null;
};

export type ProjectSignals = {
  dependencies: string[];
  language: string | null;
  manifests: string[];
  /** Project name, description, and README head, used to expand generic tasks. */
  context: string;
};

const MAX_DEPENDENCIES = 40;
const MAX_CONTEXT_TOKENS = 12;
const CONTEXT_WEIGHT = 0.35;
/** Fraction of the task's own IDF weight a result must match. */
const TASK_COVERAGE_RATIO = 0.35;

/** Same idea for words: "source" is in 392 of 650 resources and separates nothing. */
const DISTINCTIVE_TERM_RATIO = 0.35;

/**
 * Topics that describe the *form* of a project rather than its subject. In a
 * library this size even the commonest topic covers only 17% of repos, so a
 * frequency floor cannot separate these — two repos can both be "cli" and
 * "open-source" and have nothing to do with each other. They never count as a
 * relation on their own.
 */
const STRUCTURAL_TOPICS = new Set([
  "open-source",
  "awesome",
  "awesome-list",
  "cli",
  "developer-tools",
  "hacktoberfest",
  "template",
  "boilerplate",
]);
/** Fraction of the combined (task + context) coverage a result must reach. */
const MIN_COVERAGE_RATIO = 0.3;
/** Reciprocal Rank Fusion damping constant. */
const RRF_K = 60;
/** RRF scores are small; scale them to sit alongside the flat boosts. */
const RRF_SCALE = 100;
/** Minimum cosine similarity for a semantic match to count on its own. */
const MIN_SIMILARITY = 0.4;
const RRF_LIMIT_MULTIPLIER = 8;

// Dependency names too generic to be a useful repo-name signal.
const GENERIC_DEPENDENCIES = new Set([
  "node",
  "core",
  "main",
  "test",
  "tests",
  "type",
  "types",
  "utils",
  "util",
  "common",
  "client",
  "server",
  "shared",
  "helpers",
  "config",
]);

function readFile(repoPath: string, name: string): string | null {
  const path = join(repoPath, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens.map((token) => token.toLowerCase()))];
}

/**
 * Opening lines of a README: the project's own summary of what it is, before
 * the implementation details (which otherwise dominate the query terms).
 */
function readmeIntro(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  return lines.slice(0, 2).join(" ").slice(0, 500);
}

/** Read the current project's manifests and descriptive context. */
export function collectProjectSignals(repoPath: string | undefined): ProjectSignals {
  const dependencies = new Set<string>();
  const manifests: string[] = [];
  let language: string | null = null;
  const contextParts: string[] = [];
  if (!repoPath || !existsSync(repoPath)) return { dependencies: [], language: null, manifests, context: "" };

  contextParts.push(basename(repoPath));
  const add = (value: string | undefined): void => {
    const name = value?.trim().toLowerCase();
    if (name) dependencies.add(name);
  };

  const pkg = readFile(repoPath, "package.json");
  if (pkg) {
    manifests.push("package.json");
    language = "TypeScript";
    try {
      const parsed = JSON.parse(pkg) as {
        name?: string;
        description?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      contextParts.push(parsed.name ?? "", parsed.description ?? "");
      for (const name of Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })) add(name);
    } catch {
      // ignore malformed manifests
    }
  }

  const pyproject = readFile(repoPath, "pyproject.toml");
  if (pyproject) {
    manifests.push("pyproject.toml");
    language ??= "Python";
    for (const match of pyproject.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*[=><~^]/gm)) add(match[1]);
  }

  const requirements = readFile(repoPath, "requirements.txt");
  if (requirements) {
    manifests.push("requirements.txt");
    language ??= "Python";
    for (const line of requirements.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      add(line.split(/[=<>!~[]/)[0]);
    }
  }

  const goMod = readFile(repoPath, "go.mod");
  if (goMod) {
    manifests.push("go.mod");
    language ??= "Go";
    for (const match of goMod.matchAll(/^\s+([a-z0-9./-]+)\s+v/gm)) add(match[1]?.split("/").pop());
  }

  const cargo = readFile(repoPath, "Cargo.toml");
  if (cargo) {
    manifests.push("Cargo.toml");
    language ??= "Rust";
    for (const match of cargo.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
      const name = match[1];
      if (name && !["name", "version", "edition", "authors", "license"].includes(name)) add(name);
    }
  }

  const readme = readFile(repoPath, "README.md") ?? readFile(repoPath, "readme.md");
  if (readme) contextParts.push(readmeIntro(readme));

  return {
    dependencies: [...dependencies].slice(0, MAX_DEPENDENCIES),
    language,
    manifests,
    context: contextParts.filter(Boolean).join("\n"),
  };
}

type TokenMatch = { all: Set<number>; meta: Set<number>; chunks: Set<number> };

function matchToken(db: AtlasDatabase, token: string): TokenMatch {
  const quoted = `"${token.replaceAll('"', '""')}"`;
  const all = db
    .prepare("SELECT resource_id FROM resources_fts WHERE resources_fts MATCH ?")
    .all(quoted) as Array<{ resource_id: number }>;
  const meta = db
    .prepare("SELECT resource_id FROM resources_fts WHERE resources_fts MATCH ?")
    .all(`{title description topics} : ${quoted}`) as Array<{ resource_id: number }>;
  const chunks = db
    .prepare(`
      SELECT cap.resource_id AS id
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN captures cap ON cap.id = c.capture_id
      WHERE chunks_fts MATCH ?
    `)
    .all(quoted) as Array<{ id: number }>;
  return {
    all: new Set(all.map((row) => row.resource_id)),
    meta: new Set(meta.map((row) => row.resource_id)),
    chunks: new Set(chunks.map((row) => row.id)),
  };
}

function collectDependencyMatches(
  db: AtlasDatabase,
  dependencies: string[],
  out: Map<number, string[]>,
): void {
  for (const dependency of dependencies) {
    if (dependency.startsWith("@types/")) continue;
    const needles = new Set<string>([dependency]);
    const unscoped = dependency.includes("/") ? dependency.split("/").pop() : undefined;
    if (unscoped) needles.add(unscoped);
    for (const needle of needles) {
      if (needle.length < 4 || GENERIC_DEPENDENCIES.has(needle)) continue;
      const like = `%${needle}%`;
      const hits = db
        .prepare(`
          SELECT r.id AS id
          FROM resources r
          LEFT JOIN github_repositories g ON g.resource_id = r.id
          WHERE EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
            AND (lower(COALESCE(g.full_name, '')) LIKE ? OR lower(r.title) LIKE ?)
          LIMIT 2
        `)
        .all(like, like) as Array<{ id: number }>;
      for (const hit of hits) {
        const list = out.get(hit.id) ?? [];
        if (!list.includes(dependency)) list.push(dependency);
        out.set(hit.id, list);
      }
    }
  }
}

function quoteTokens(tokens: string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

/** Resource ids ranked by bm25 for a match expression. */
function rankResourceFts(db: AtlasDatabase, match: string, limit: number): number[] {
  if (!match) return [];
  const rows = db
    .prepare(`
      SELECT r.id AS id
      FROM resources_fts
      JOIN resources r ON r.id = resources_fts.resource_id
      WHERE resources_fts MATCH ?
        AND EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
      ORDER BY bm25(resources_fts, 0.0, 10.0, 5.0, 3.0, 1.0, 2.0)
      LIMIT ?
    `)
    .all(match, limit) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** Resource ids ranked by bm25 over chunk text, best rank per resource. */
function rankChunkFts(db: AtlasDatabase, match: string, limit: number): number[] {
  if (!match) return [];
  const rows = db
    .prepare(`
      SELECT cap.resource_id AS id
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN captures cap ON cap.id = c.capture_id
      JOIN resources r ON r.id = cap.resource_id
      WHERE chunks_fts MATCH ?
        AND EXISTS (SELECT 1 FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL)
      ORDER BY bm25(chunks_fts)
      LIMIT ?
    `)
    .all(match, limit) as Array<{ id: number }>;
  return [...new Set(rows.map((row) => row.id))];
}

function bestPassage(db: AtlasDatabase, tokens: string[], resourceId: number): string | null {
  if (tokens.length === 0) return null;
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
  const row = db
    .prepare(`
      SELECT c.text AS text
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN captures cap ON cap.id = c.capture_id
      WHERE chunks_fts MATCH ? AND cap.resource_id = ?
      ORDER BY bm25(chunks_fts) LIMIT 1
    `)
    .get(query, resourceId) as { text: string } | undefined;
  return row?.text ?? null;
}

type Scored = {
  id: number;
  score: number;
  reasons: string[];
  matchedTokens: string[];
};

/**
 * Inverse document frequency over the resource vocabulary, memoised for the
 * lifetime of the call. Rarer terms separate bookmarks; common ones do not.
 */
function idfLookup(db: AtlasDatabase): (token: string) => number {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM resources_fts").get() as { c: number }).c || 1;
  const cache = new Map<string, number>();
  return (token: string): number => {
    const cached = cache.get(token);
    if (cached !== undefined) return cached;
    // Counted through the index rather than a vocabulary table: the tokenizer stems
    // the query exactly as it stemmed the documents, so a raw token like "example"
    // cannot drift away from its stored stem "exampl" and read as infinitely rare.
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM resources_fts WHERE resources_fts MATCH ?")
      .get(`"${token.replaceAll('"', '""')}"`) as { n: number };
    const value = Math.log((total + 1) / (row.n + 1));
    cache.set(token, value);
    return value;
  };
}

function parseTopics(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((topic): topic is string => typeof topic === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * How much a shared topic is worth, by how rare it is. Sharing "mlx" says a lot;
 * sharing "cli" says very little.
 */
function topicWeights(db: AtlasDatabase): Map<string, number> {
  const total = Math.max(
    1,
    (db.prepare("SELECT COUNT(*) AS c FROM github_repositories").get() as { c: number }).c,
  );
  const rows = db
    .prepare(`
      SELECT value AS topic, COUNT(*) AS n
      FROM github_repositories, json_each(github_repositories.topics)
      GROUP BY value
    `)
    .all() as Array<{ topic: string; n: number }>;
  return new Map(rows.map((row) => [row.topic.toLowerCase(), Math.log((total + 1) / (row.n + 1))]));
}

export type RelatedHit = SearchResult & { whyRelated: string[] };

/**
 * Bookmarks related to one bookmark. This used to re-search the bookmark's own
 * title, so it returned rows that shared the words already on screen. Instead it
 * builds a signature from what the bookmark is actually about — its rarest terms
 * plus its topics — then scores candidates on shared topics first and shared
 * signature terms second, and says which of the two matched.
 */
export function relatedResources(db: AtlasDatabase, id: number, options: { limit?: number } = {}): RelatedHit[] {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
  const source = getResource(db, id);
  if (!source) return [];
  const idf = idfLookup(db);
  const corpusSize = Math.max(
    1,
    (db.prepare("SELECT COUNT(*) AS c FROM resources_fts").get() as { c: number }).c,
  );
  const termFloor = Math.log((corpusSize + 1) / (DISTINCTIVE_TERM_RATIO * corpusSize + 1));

  const signature = uniqueTokens(
    tokenize([source.title, source.description ?? "", source.topics.join(" ")].join(" ")),
  )
    .map((token) => ({ token, weight: idf(token) }))
    // Deliberately unfiltered: these terms build the candidate query, and a source's
    // own topics have to be in it or a bookmark related only by topic is never even
    // considered. Common words are kept out of the *scoring* instead.
    .sort((a, b) => b.weight - a.weight || a.token.localeCompare(b.token))
    .slice(0, 12)
    .map((entry) => entry.token);
  if (signature.length === 0) return [];

  const activeIds = new Set(
    (db.prepare("SELECT resource_id AS id FROM saves WHERE unsaved_at IS NULL").all() as Array<{ id: number }>)
      .map((row) => row.id),
  );
  const candidates = searchResources(db, signature.join(" "), 80).filter(
    (candidate) => candidate.id !== id && activeIds.has(candidate.id),
  );
  if (candidates.length === 0) return [];

  // Every GitHub topic set in one read: cheaper than building an IN list per call.
  const topicsById = new Map(
    (
      db.prepare("SELECT resource_id AS id, topics FROM github_repositories").all() as Array<{
        id: number;
        topics: string;
      }>
    ).map((row) => [row.id, parseTopics(row.topics)]),
  );
  const sourceTopics = new Set(source.topics.map((topic) => topic.toLowerCase()));
  const signatureSet = new Set(signature);
  const weights = topicWeights(db);

  return candidates
    .map((candidate) => {
      // Topic rarity orders the results rather than gating them: in a library this
      // size even the commonest topic covers 17% of repos, so a frequency floor
      // would only ever reject the small ones.
      const sharedTopics = (topicsById.get(candidate.id) ?? [])
        .filter((topic) => sourceTopics.has(topic.toLowerCase()))
        .filter((topic) => !STRUCTURAL_TOPICS.has(topic.toLowerCase()));
      const sharedTerms = uniqueTokens(tokenize(`${candidate.title} ${candidate.description ?? ""}`))
        .filter((token) => signatureSet.has(token))
        // A word carried by a third of the library separates nothing.
        .filter((token) => idf(token) >= termFloor);
      const topicScore = sharedTopics.reduce(
        (sum, topic) => sum + (weights.get(topic.toLowerCase()) ?? 1),
        0,
      );
      return {
        candidate,
        whyRelated: [...sharedTopics.map((topic) => `topic:${topic}`), ...sharedTerms].slice(0, 5),
        score: topicScore * 3 + sharedTerms.length,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, limit)
    .map((entry) => ({ ...entry.candidate, whyRelated: entry.whyRelated }));
}

/**
 * Rank saved bookmarks against a task.
 *
 * Keyword matching alone is not enough: a question like "is there a repo that
 * can improve this?" matches common words in half the library. So terms are
 * weighted by rarity (IDF), a result must match more than one term, and when
 * the task has no distinctive terms the current project's own description is
 * used to expand the query.
 */
export function recall(db: AtlasDatabase, options: RecallOptions): RecallHit[] {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 25);
  const signals = collectProjectSignals(options.repoPath);
  const taskTokens = uniqueTokens(tokenize(options.task));

  const idf = idfLookup(db);

  const contextTokens = uniqueTokens(tokenize(`${signals.context} ${options.stage ?? ""}`))
    .filter((token) => !taskTokens.includes(token))
    .sort((a, b) => idf(b) - idf(a))
    .slice(0, MAX_CONTEXT_TOKENS);
  // The task is always the query. When it is vague its own words are common, so
  // the project's own description adds context terms that can carry the ranking.
  const primary = taskTokens.length > 0 ? taskTokens : contextTokens;
  const secondary = taskTokens.length > 0 ? contextTokens : [];
  const taskMaxCoverage = taskTokens.reduce((sum, token) => sum + idf(token), 0);
  const maxCoverage =
    primary.reduce((sum, token) => sum + idf(token), 0) +
    secondary.reduce((sum, token) => sum + idf(token) * CONTEXT_WEIGHT, 0);
  const tokens = [...new Set([...taskTokens, ...contextTokens])];

  const matches = new Map<string, TokenMatch>();
  for (const token of tokens) matches.set(token, matchToken(db, token));

  const candidates = new Set<number>();
  for (const match of matches.values()) for (const id of match.all) candidates.add(id);

  const dependencyMatches = new Map<number, string[]>();
  collectDependencyMatches(db, signals.dependencies, dependencyMatches);
  for (const id of dependencyMatches.keys()) candidates.add(id);

  // Reciprocal Rank Fusion: combine the independent rankings (resource text,
  // chunk passages, metadata, and project context) instead of one flat score.
  const taskMatch = quoteTokens(taskTokens);
  const contextMatch = quoteTokens(contextTokens);
  const rankedLimit = limit * RRF_LIMIT_MULTIPLIER;
  const rrf = new Map<number, number>();
  const addRanked = (ids: number[], weight: number): void => {
    ids.forEach((id, index) => {
      rrf.set(id, (rrf.get(id) ?? 0) + weight / (RRF_K + index + 1));
    });
  };
  addRanked(rankResourceFts(db, taskMatch, rankedLimit), 1.0);
  addRanked(rankChunkFts(db, taskMatch, rankedLimit), 1.0);
  if (taskMatch) {
    addRanked(rankResourceFts(db, `{title description topics} : (${taskMatch})`, rankedLimit), 1.5);
  }
  if (contextMatch) {
    addRanked(rankResourceFts(db, contextMatch, rankedLimit), 0.3);
    addRanked(rankChunkFts(db, contextMatch, rankedLimit), 0.3);
    addRanked(rankResourceFts(db, `{title description topics} : (${contextMatch})`, rankedLimit), 0.45);
  }

  // Semantic ranking from on-device embeddings, when a query vector is available.
  const vectorMatches = new Map<number, number>();
  if (options.queryVector && options.queryVector.length > 0) {
    const hits = vectorRank(db, options.queryVector, rankedLimit);
    addRanked(
      hits.map((hit) => hit.resourceId),
      1.2,
    );
    for (const hit of hits) {
      candidates.add(hit.resourceId);
      if (hit.score >= MIN_SIMILARITY) vectorMatches.set(hit.resourceId, hit.score);
    }
  }

  // Whether the task matched anything at all. If it did, results that only match
  // project context are noise; if it did not, context is all we have.
  const taskHasMatches = [...candidates].some((id) =>
    primary.some((token) => matches.get(token)?.all.has(id)),
  );

  const scored: Scored[] = [];
  for (const id of candidates) {
    const matchedPrimary = primary.filter((token) => matches.get(token)?.all.has(id));
    const matchedSecondary = secondary.filter((token) => matches.get(token)?.all.has(id));
    const dependencies = dependencyMatches.get(id) ?? [];

    let coverage = 0;
    for (const token of matchedPrimary) coverage += idf(token);
    for (const token of matchedSecondary) coverage += idf(token) * CONTEXT_WEIGHT;

    // Common words must not carry a result: require real weighted coverage,
    // and when the task is specific it has to be a task term that matched.
    const taskCoverage = matchedPrimary.reduce((sum, token) => sum + idf(token), 0);
    const vectorScore = vectorMatches.get(id);
    // A strong semantic match is a match on its own, even without keyword overlap.
    if (dependencies.length === 0 && vectorScore === undefined) {
      if (taskTokens.length === 0) {
        // No explicit task: the stage/project context *is* the query, so require
        // two of its terms rather than a share of a long, noisy description.
        if (matchedPrimary.length < 2) continue;
      } else if (matchedPrimary.length === 0) {
        // Only a genuinely vague task may fall back to the project's own terms,
        // and then it must match more than one of them.
        if (taskHasMatches || matchedSecondary.length < 2) continue;
      } else {
        if (taskMaxCoverage > 0 && taskCoverage / taskMaxCoverage < TASK_COVERAGE_RATIO) continue;
        if (maxCoverage <= 0 || coverage / maxCoverage < MIN_COVERAGE_RATIO) continue;
      }
    }

    // A match in the title/description/topics is worth more than one buried in
    // a README, and more for a rarer term.
    let metaScore = 0;
    for (const token of matchedPrimary) {
      if (matches.get(token)?.meta.has(id)) metaScore += idf(token) * 1.5;
    }
    const metaMatched = metaScore > 0;
    const passageMatched = primary.some((token) => matches.get(token)?.chunks.has(id));

    let score = RRF_SCALE * (rrf.get(id) ?? 0);
    score += dependencies.length * 14;

    const reasons: string[] = [];
    if (matchedPrimary.length > 0) reasons.push(`matched: ${matchedPrimary.slice(0, 3).join(", ")}`);
    if (matchedSecondary.length > 0) {
      reasons.push(`project context: ${matchedSecondary.slice(0, 3).join(", ")}`);
    }
    if (metaMatched) reasons.push("metadata match");
    if (passageMatched) reasons.push("passage match");
    if (vectorScore !== undefined) reasons.push(`semantic match (${vectorScore.toFixed(2)})`);
    for (const dependency of dependencies) reasons.push(`dependency: ${dependency}`);

    scored.push({
      id,
      score,
      reasons,
      matchedTokens: [...matchedPrimary, ...matchedSecondary],
    });
  }

  if (scored.length === 0) return [];

  const rows = db.prepare(`
    SELECT r.id, r.title, r.canonical_url AS url, r.description, r.language,
      (SELECT MAX(s.saved_at) FROM saves s WHERE s.resource_id = r.id AND s.unsaved_at IS NULL) AS savedAt,
      CASE WHEN EXISTS (
        SELECT 1 FROM captures c WHERE c.resource_id = r.id AND length(trim(c.normalized_content)) > 0
      ) THEN 'full' ELSE 'partial' END AS contentStatus,
      COALESCE(g.archived, 0) AS archived,
      g.stars AS stars,
      g.pushed_at AS lastPushedAt,
      n.context AS context
    FROM resources r
    LEFT JOIN github_repositories g ON g.resource_id = r.id
    LEFT JOIN resource_notes n ON n.resource_id = r.id
    WHERE r.id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(scored.map((entry) => entry.id))) as Array<{
    id: number;
    title: string;
    url: string;
    description: string | null;
    language: string | null;
    savedAt: string | null;
    contentStatus: "full" | "partial";
    archived: number;
    stars: number | null;
    lastPushedAt: string | null;
    context: string | null;
  }>;

  const byId = new Map(scored.map((entry) => [entry.id, entry]));
  const now = Date.now();
  const results: RecallHit[] = rows.map((row) => {
    const entry = byId.get(row.id);
    let score = entry?.score ?? 0;
    const reasons = [...(entry?.reasons ?? [])];

    if (signals.language && row.language && signals.language.toLowerCase() === row.language.toLowerCase()) {
      score += 4;
      reasons.push(`language: ${row.language}`);
    }
    if (row.contentStatus === "full") score += 2;
    if (row.archived === 1) score -= 6;
    if (row.savedAt) {
      const ageDays = (now - new Date(row.savedAt).getTime()) / 86_400_000;
      score += Math.max(0, 3 - ageDays / 365);
    }

    const passage = bestPassage(db, entry?.matchedTokens ?? [], row.id);
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      description: row.description,
      language: row.language,
      savedAt: row.savedAt,
      score,
      snippet: passage ?? (row.description ?? "").slice(0, 240),
      contentStatus: row.contentStatus,
      archived: row.archived === 1,
      stars: row.stars,
      lastPushedAt: row.lastPushedAt,
      context: row.context,
      whyMatched: reasons,
      passage,
      trust: "untrusted_external_content" as const,
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
