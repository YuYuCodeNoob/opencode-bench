import { $ } from "./shell.js";
import type { CommitDiff } from "./github.js";

export async function assertLocalGitRepository(repoPath: string): Promise<void> {
  try {
    await $`git -C ${repoPath} rev-parse --is-inside-work-tree`.quiet();
  } catch (error) {
    throw new Error(
      `Path '${repoPath}' is not a valid git repository: ${(error as Error).message}`
    );
  }
}

export async function fetchLocalComparisonDiff(
  repoPath: string,
  from: string,
  to: string,
): Promise<string> {
  await assertLocalGitRepository(repoPath);

  try {
    const diff = await $`git -C ${repoPath} diff --binary ${from}..${to}`.text();

    if (diff.trim().length === 0) {
      throw new Error(
        `Local git comparison diff between ${from} and ${to} was empty.`
      );
    }

    return diff;
  } catch (error) {
    throw new Error(
      `Failed to fetch local git diff between ${from} and ${to}: ${(error as Error).message}`
    );
  }
}

export async function fetchLocalCommits(
  repoPath: string,
  from: string,
  to: string,
): Promise<CommitDiff[]> {
  await assertLocalGitRepository(repoPath);

  try {
    // Get list of commits between from and to with robust delimiter
    const commitList = await $`git -C ${repoPath} log --pretty=format:"%H%x00%s" ${from}..${to}`.text();
    const commits = commitList
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => {
        const nullIndex = line.indexOf("\x00");
        if (nullIndex === -1) return null;
        return {
          sha: line.slice(0, nullIndex),
          title: line.slice(nullIndex + 1)
        };
      })
      .filter(commit => commit !== null && commit.sha.trim() !== "");

    if (commits.length === 0) {
      return [];
    }

    const results = await Promise.all(
      commits.map(async ({ sha, title }) => {
        try {
          // Get diff content suitable for prompts - no full metadata
          const diff = await $`git -C ${repoPath} show --format= --binary ${sha}`.text();

          return { sha, title, diff };
        } catch (error) {
          console.error(
            `Failed to fetch diff for commit ${sha} in ${repoPath}:`,
            (error as Error).message
          );
          return null;
        }
      })
    );

    return results.filter((value): value is CommitDiff => value !== null);
  } catch (error) {
    throw new Error(
      `Failed to fetch local git commits between ${from} and ${to}: ${(error as Error).message}`
    );
  }
}

export async function cloneLocalRepositoryAtCommit(
  repoPath: string,
  commit: string,
  destination: string,
): Promise<void> {
  await assertLocalGitRepository(repoPath);

  try {
    // Clone the repository and checkout specific commit
    await $`git clone ${repoPath} ${destination}`.quiet();

    await $`git -C ${destination} checkout ${commit}`.quiet();
  } catch (error) {
    throw new Error(
      `Failed to clone repository at ${repoPath} to ${destination} at commit ${commit}: ${(error as Error).message}`
    );
  }
}
