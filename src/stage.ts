import { spawnSync } from "node:child_process";

export type StageSignals = {
	branch: string | null;
	commits: string[];
	files: string[];
	/** Composed query text: the focus plus where the project currently is. */
	description: string;
};

function git(repoPath: string, args: string[]): string | null {
	try {
		const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
		if (result.status !== 0) return null;
		return result.stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Summarize where a project currently is: the branch, recent commit subjects,
 * and the files in play. This is the "we are here right now" signal, so a
 * consult does not need the user to describe the stage by hand.
 */
export function collectStage(repoPath: string, focus = ""): StageSignals {
	const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const log = git(repoPath, ["log", "--pretty=%s", "-n", "12"]);
	const commits = (log ? log.split("\n").filter(Boolean) : [])
		// Strip conventional-commit prefixes so the words describe the work.
		.map((subject) =>
			subject.replace(/^(feat|fix|chore|docs|refactor|test|perf|style|build|ci|revert)(\([^)]*\))?:\s*/i, ""),
		)
		.filter((subject) => subject.length > 3);
	const status = git(repoPath, ["status", "--porcelain"]);
	const files = status
		? status
				.split("\n")
				.map((line) => line.slice(3).trim())
				.filter(Boolean)
				.slice(0, 20)
		: [];

	const fileNames = files.map((file) => file.split("/").pop() ?? file);
	// The branch is only informative when it is not the default.
	const branchHint = branch && !["main", "master"].includes(branch) ? [branch] : [];
	const description = [focus, ...branchHint, ...commits, ...fileNames].filter(Boolean).join(" ");
	return { branch, commits, files, description };
}
