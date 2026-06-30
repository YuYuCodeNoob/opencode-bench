import { $ } from "./shell";
import type { CommitDiff } from "./github";

export async function assertLocalGitRepository(repoPath: string): Promise<void> {
  try {
    $.cwd(repoPath);
    await $`git rev-parse --is-inside-work-tree`.quiet();
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

  $.cwd(repoPath);
  try {
    const diff = await $`git diff ${from}...${to}`.text();

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

  $.cwd(repoPath);
  try {
    // Get list of commits between from and to
    const commitList = await $`git log --pretty=format:"%H %s" ${from}...${to}`.text();
    const commitSHAs = commitList
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => line.split(" ")[0])
      .filter(sha => sha !== undefined);

    if (commitSHAs.length === 0) {
      return [];
    }

    const results = await Promise.all(
      commitSHAs.map(async (sha) => {
        try {
          // Get full diff for each commit
          const diff = await $`git show ${sha}`.text();
          const title = (await $`git show --pretty=format:"%s" -s ${sha}`.text()).trim();

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

    $.cwd(destination);
    await $`git checkout ${commit}`.quiet();
  } catch (error) {
    throw new Error(
      `Failed to clone repository at ${repoPath} to ${destination} at commit ${commit}: ${(error as Error).message}`
    );
  }
}
