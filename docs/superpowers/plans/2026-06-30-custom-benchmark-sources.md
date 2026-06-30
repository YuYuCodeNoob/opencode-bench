# Custom Benchmark Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for external benchmark task directories and local git repository task sources while preserving existing GitHub task behavior.

**Architecture:** Extend `Task` to be path-configurable and source-type-aware, then route generation and evaluation through GitHub or local git helpers based on `source.type`. Keep the existing task folder contract (`definition.yml`, `prompt.yml`, `diff.patch`) and CLI shape, adding only an optional `--tasks-dir` flag.

**Tech Stack:** Bun, TypeScript, zod, yaml, git CLI, existing `@octokit/request` GitHub utilities, existing AI SDK prompt generation.

## Global Constraints

- Existing task definitions without `source.type` must continue to work and default to GitHub.
- Existing commands without `--tasks-dir` must continue loading built-in `src/tasks`.
- First implementation supports only `source.type: github` and `source.type: local`.
- Do not add arbitrary remote git URL support in this change.
- Existing generated `prompt.yml` and `diff.patch` files must not be overwritten by `generate`.
- `_sample` must remain excluded from task listing and generation.

---

## File Structure

- Modify `src/tasks/index.ts`: add task directory selection, source schemas, local generation, and path-aware `get/listNames/generate` APIs.
- Create `src/util/local-git.ts`: focused helper module for local repository validation, diff extraction, commit listing, and cloning.
- Modify `src/eval.ts`: clone/checkout GitHub or local sources based on `task.source.type`.
- Modify `cli.ts`: add `--tasks-dir` to `generate` and benchmark commands and pass it to `Task`/`Eval`.
- Modify scripts that enumerate tasks if needed: keep defaults unchanged, optionally allow `TASKS_DIR` later only if the code path requires it.
- Modify `README.md`: document custom task directories and local source definitions.

---

### Task 1: Add local git helper module

**Files:**
- Create: `src/util/local-git.ts`

**Interfaces:**
- Consumes: Bun shell `$` and `CommitDiff` shape currently exported from `src/util/github.ts`.
- Produces:
  - `assertLocalGitRepository(repoPath: string): Promise<void>`
  - `fetchLocalComparisonDiff(repoPath: string, from: string, to: string): Promise<string>`
  - `fetchLocalCommits(repoPath: string, from: string, to: string): Promise<CommitDiff[]>`
  - `cloneLocalRepositoryAtCommit(repoPath: string, commit: string, destination: string): Promise<void>`

- [ ] **Step 1: Create helper implementation**

Create `src/util/local-git.ts` with:

```ts
import { $ } from "bun";
import type { CommitDiff } from "~/src/util/github.js";

async function git(repoPath: string, args: string[]) {
  return await $`git -C ${repoPath} ${args}`.text();
}

export async function assertLocalGitRepository(repoPath: string) {
  try {
    const result = (await git(repoPath, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (result !== "true") {
      throw new Error(`${repoPath} is not a git work tree.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local source repo ${repoPath} is not a readable git repository: ${message}`);
  }
}

export async function fetchLocalComparisonDiff(
  repoPath: string,
  from: string,
  to: string,
) {
  await assertLocalGitRepository(repoPath);
  const diff = await git(repoPath, ["diff", "--binary", `${from}..${to}`]);

  if (diff.trim().length === 0) {
    throw new Error(`Local comparison diff for ${repoPath} between ${from} and ${to} was empty.`);
  }

  return diff;
}

export async function fetchLocalCommits(
  repoPath: string,
  from: string,
  to: string,
): Promise<CommitDiff[]> {
  await assertLocalGitRepository(repoPath);
  const output = await git(repoPath, [
    "log",
    "--reverse",
    "--format=%H%x00%s",
    `${from}..${to}`,
  ]);

  const commits = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, title = "(no commit title)"] = line.split("\0", 2);
      return { sha, title };
    });

  const results = await Promise.all(
    commits.map(async ({ sha, title }) => {
      const diff = await git(repoPath, ["show", "--format=", "--binary", sha]);
      if (diff.trim().length === 0) return null;
      return { sha, title, diff };
    }),
  );

  return results.filter((value): value is CommitDiff => value !== null);
}

export async function cloneLocalRepositoryAtCommit(
  repoPath: string,
  commit: string,
  destination: string,
) {
  await assertLocalGitRepository(repoPath);
  await $`git clone ${repoPath} ${destination}`.quiet();
  await $`git -C ${destination} checkout ${commit}`.quiet();
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run check`

Expected: it may fail if task source types are not updated yet, but `src/util/local-git.ts` should not have syntax errors. If Bun shell array interpolation does not typecheck, replace `git()` with a safe `spawn`-based helper or inline `$` calls with explicit arguments.

---

### Task 2: Make task loading path-configurable and source-type-aware

**Files:**
- Modify: `src/tasks/index.ts:15-103`

**Interfaces:**
- Consumes:
  - `assertLocalGitRepository(repoPath)` from `src/util/local-git.ts`
- Produces:
  - `Task.Source = GithubSource | LocalSource`
  - `Task.LoadOptions = { tasksDir?: string }`
  - `Task.get(taskId: string, opts?: LoadOptions): Promise<Task.Instance>`
  - `Task.listNames(opts?: LoadOptions): Promise<string[]>`

- [ ] **Step 1: Replace source schema and cache model**

In `src/tasks/index.ts`, update imports:

```ts
import { join, resolve } from "node:path";
import { assertLocalGitRepository } from "~/src/util/local-git.js";
```

Replace the current `const TASK_PATH`, schema, and `data` cache block with:

```ts
  const TASK_PATH = __dirname;
  const SAMPLE_DATASET_NAME = "_sample";
  const SAMPLE_DATASET_PATH = join(TASK_PATH, SAMPLE_DATASET_NAME);
  const GENERATE_MODEL_ID = "deepseek/deepseek-v4-flash";

  const githubSourceSchema = z.object({
    type: z.literal("github").default("github"),
    repo: z
      .string()
      .regex(/^[^/]+\/[^/]+$/, "repo must follow the format <owner>/<name>."),
    from: z.string().min(1, "from commit SHA is required."),
    to: z.string().min(1, "to commit SHA is required."),
  });

  const localSourceSchema = z.object({
    type: z.literal("local"),
    repo: z.string().min(1, "local repo path is required."),
    from: z.string().min(1, "from commit SHA is required."),
    to: z.string().min(1, "to commit SHA is required."),
  });

  const sourceSchema = z.preprocess((value) => {
    if (value && typeof value === "object" && !("type" in value)) {
      return { ...(value as Record<string, unknown>), type: "github" };
    }
    return value;
  }, z.discriminatedUnion("type", [githubSourceSchema, localSourceSchema]));

  const definitionSchema = z.object({
    source: sourceSchema,
    context: z.string().min(1).optional(),
    metrics: z.array(
      z.object({
        name: z.enum(Object.keys(Metric.all) as [string, ...string[]]),
        weight: z.number().positive(),
        args: z
          .object({
            setup: z.array(z.string().min(1)).default([]),
            commands: z
              .array(z.string().min(1))
              .min(1, "At least one check command is required."),
          })
          .optional(),
      }),
    ),
  });

  export type Source = z.infer<typeof sourceSchema>;
  export type LoadOptions = { tasksDir?: string };
  const data = new Map<string, Awaited<ReturnType<typeof load>>>();

  function getTaskPath(opts?: LoadOptions) {
    return opts?.tasksDir ? resolve(opts.tasksDir) : TASK_PATH;
  }
```

- [ ] **Step 2: Update `get`, `listNames`, and `load` signatures**

Replace the current implementations of `get`, `listNames`, and `load` with:

```ts
  export async function get(taskId: string, opts?: LoadOptions) {
    const taskPath = getTaskPath(opts);
    if (!data.has(taskPath)) data.set(taskPath, await load(taskPath));

    const task = data.get(taskPath)?.find((task) => task.id === taskId);
    if (!task) throw new Error(`Task ${taskId} was not found in ${taskPath}.`);

    if (!task.metrics.length)
      throw new Error(`Task ${taskId} has no score assignments.`);
    if (!task.prompts.length) throw new Error(`Task ${taskId} has no prompts.`);

    const invalidScore = task.metrics.find(({ name }) => !(name in Metric.all));
    if (invalidScore)
      throw new Error(`Score ${invalidScore.name} is not registered.`);

    return task;
  }

  export async function listNames(opts?: LoadOptions) {
    const taskPath = getTaskPath(opts);
    const folders = await readdir(taskPath, { withFileTypes: true });
    return folders
      .filter((folder) => folder.isDirectory())
      .filter((folder) => folder.name !== SAMPLE_DATASET_NAME)
      .map((folder) => folder.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async function load(taskPath: string) {
    const folders = await listNames({ tasksDir: taskPath });
    return await Promise.all(
      folders.map(async (folderName) => {
        const [defYml, promptYml, diff] = await Promise.all([
          readFile(join(taskPath, folderName, "definition.yml"), "utf-8"),
          readFile(join(taskPath, folderName, "prompt.yml"), "utf-8"),
          readFile(join(taskPath, folderName, "diff.patch"), "utf-8"),
        ]);
        const definition = definitionSchema.parse(parseYaml(defYml));
        if (definition.source.type === "local") {
          await assertLocalGitRepository(definition.source.repo);
        }
        return {
          ...definition,
          id: folderName,
          prompts: promptsSchema.parse(parseYaml(promptYml)).prompts,
          diff: diff.trim(),
        };
      }),
    );
  }
```

- [ ] **Step 3: Run typecheck**

Run: `bun run check`

Expected: type errors in `Task.generate` or `Eval.run` are acceptable at this point because later tasks update those call sites. No syntax errors should remain in the replaced block.

---

### Task 3: Add local generation path

**Files:**
- Modify: `src/tasks/index.ts:104-173`

**Interfaces:**
- Consumes:
  - `fetchComparisonDiff(owner, repo, from, to)` from `src/util/github.ts`
  - `fetchCommits(owner, repo, from, to)` from `src/util/github.ts`
  - `fetchLocalComparisonDiff(repoPath, from, to)` from `src/util/local-git.ts`
  - `fetchLocalCommits(repoPath, from, to)` from `src/util/local-git.ts`
- Produces:
  - `Task.generate(opts: { logger: Logger.Instance; tasksDir?: string }): Promise<void>`
  - local and GitHub generation both write `diff.patch` and `prompt.yml` only if missing

- [ ] **Step 1: Update imports**

In `src/tasks/index.ts`, update the local git import to include:

```ts
import {
  assertLocalGitRepository,
  fetchLocalCommits,
  fetchLocalComparisonDiff,
} from "~/src/util/local-git.js";
```

- [ ] **Step 2: Replace `generate` implementation**

Replace `export async function generate(opts: { logger: Logger.Instance }) { ... }` with:

```ts
  export async function generate(opts: {
    logger: Logger.Instance;
    tasksDir?: string;
  }) {
    const taskPath = getTaskPath(opts);
    opts.logger.log(`Starting dataset generation from ${taskPath}...`);
    const folders = await listNames({ tasksDir: taskPath });
    opts.logger.log(`Found ${folders.length} tasks`);

    for (const folderName of folders) {
      const logger = opts.logger.child(`[${folderName}]`);

      try {
        logger.log(`Parsing task definition...`);
        const defYml = await readFile(
          join(taskPath, folderName, "definition.yml"),
          "utf-8",
        );
        const def = definitionSchema.parse(parseYaml(defYml));
        const source = def.source;

        const diffPath = join(taskPath, folderName, "diff.patch");
        if (!(await fileExists(diffPath))) {
          logger.log(`Fetching task diff...`);
          const diff =
            source.type === "github"
              ? await fetchGithubComparisonDiff(source)
              : await fetchLocalComparisonDiff(source.repo, source.from, source.to);
          if (diff.trim().length === 0)
            throw new Error(logger.format(`Diff is empty for ${source.repo}`));
          await writeFile(diffPath, diff, "utf-8");
        }

        const promptPath = join(taskPath, folderName, "prompt.yml");
        if (!(await fileExists(promptPath))) {
          logger.log(`Generating task prompts...`);
          const commits =
            source.type === "github"
              ? await fetchGithubCommits(source)
              : await fetchLocalCommits(source.repo, source.from, source.to);
          if (commits.length === 0)
            throw new Error(logger.format("No commits found"));

          const prompts = await Promise.all(
            commits.map((diff) =>
              generatePrompt(def, diff, {
                logger: logger.child(`[commit ${diff.sha.slice(0, 7)}]`),
              }),
            ),
          );

          await writeFile(
            promptPath,
            stringifyYaml(
              { generated_at: new Date().toISOString(), prompts },
              { lineWidth: 0 },
            ),
            "utf-8",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to generate dataset: ${message}`);
        throw error;
      }
    }
  }

  async function fetchGithubComparisonDiff(source: Extract<Source, { type: "github" }>) {
    const [owner, repo] = source.repo.split("/", 2);
    return await fetchComparisonDiff(owner, repo, source.from, source.to);
  }

  async function fetchGithubCommits(source: Extract<Source, { type: "github" }>) {
    const [owner, repo] = source.repo.split("/", 2);
    return await fetchCommits(owner, repo, source.from, source.to);
  }
```

- [ ] **Step 3: Run typecheck**

Run: `bun run check`

Expected: remaining type errors should be limited to eval/CLI call sites updated in later tasks.

---

### Task 4: Route evaluation cloning by source type

**Files:**
- Modify: `src/eval.ts:21-58`
- Modify: `src/eval.ts` imports

**Interfaces:**
- Consumes:
  - `Task.get(taskId, { tasksDir })`
  - `cloneRepositoryAtCommit(repo, commit)` existing GitHub helper from `src/util/github.ts` or current `src/eval.ts` helper if present
  - `cloneLocalRepositoryAtCommit(repoPath, commit, destination)` from `src/util/local-git.ts`
- Produces:
  - `Eval.run(agentName, modelId, taskId, opts: { logger; tasksDir? })`
  - `runOnce(agentName, modelId, taskId, opts: { logger; tasksDir? })`

- [ ] **Step 1: Inspect existing clone helper**

Read the top and bottom of `src/eval.ts` to find the existing `cloneRepositoryAtCommit` implementation and imports. Preserve existing GitHub clone behavior exactly except for wrapping it behind source dispatch.

- [ ] **Step 2: Update imports and option types**

Add:

```ts
import { cloneLocalRepositoryAtCommit } from "~/src/util/local-git.js";
```

Change `Eval.run` opts type from:

```ts
opts: {
  logger: Logger.Instance;
},
```

to:

```ts
opts: {
  logger: Logger.Instance;
  tasksDir?: string;
},
```

Make the same change for `runOnce` opts.

- [ ] **Step 3: Pass tasksDir into retry and task lookup**

Change:

```ts
() => runOnce(agentName, modelId, taskId, { logger: opts.logger }),
```

To:

```ts
() => runOnce(agentName, modelId, taskId, { logger: opts.logger, tasksDir: opts.tasksDir }),
```

Change:

```ts
const task = await Task.get(taskId);
```

To:

```ts
const task = await Task.get(taskId, { tasksDir: opts.tasksDir });
```

- [ ] **Step 4: Replace repository clone block**

Replace:

```ts
opts.logger.log(`Cloning repository to ${cwd}...`);
await cloneRepositoryAtCommit(task.source.repo, task.source.from);
```

with:

```ts
opts.logger.log(`Cloning repository to ${cwd}...`);
if (task.source.type === "local") {
  await cloneLocalRepositoryAtCommit(task.source.repo, task.source.from, cwd);
  $.cwd(cwd);
} else {
  await cloneRepositoryAtCommit(task.source.repo, task.source.from);
}
```

Keep `$.cwd(cwd);` before the try block if the existing clone helper expects Bun shell cwd to be the temp dir. The local branch resets it after clone because `git clone <repo> <cwd>` creates the working tree directly at `cwd`.

- [ ] **Step 5: Run typecheck**

Run: `bun run check`

Expected: remaining type errors should be CLI-only if any.

---

### Task 5: Add CLI `--tasks-dir`

**Files:**
- Modify: `cli.ts:24-63`

**Interfaces:**
- Consumes:
  - `Task.generate({ logger, tasksDir })`
  - `Eval.run(agentName, modelId, taskId, { logger, tasksDir })`
- Produces:
  - `orvl generate --tasks-dir ./bench-tasks`
  - `orvl opencode --model ... --task my-task --tasks-dir ./bench-tasks`

- [ ] **Step 1: Add option to generate command**

Change generate command builder from:

```ts
async (yargs) =>
  yargs.example([["orvl generate", "Generate dataset for all tasks"]]),
async () => {
  const logger = Logger.create("[generate]");
  await Task.generate({ logger });
},
```

to:

```ts
async (yargs) =>
  yargs
    .option("tasks-dir", {
      type: "string",
      description: "directory containing benchmark task folders",
    })
    .example([["orvl generate --tasks-dir ./bench-tasks", "Generate dataset for custom tasks"]]),
async ({ tasksDir }) => {
  const logger = Logger.create("[generate]");
  await Task.generate({ logger, tasksDir });
},
```

- [ ] **Step 2: Add option to benchmark command**

After the existing `.option("task", ...)`, add:

```ts
      .option("tasks-dir", {
        type: "string",
        description: "directory containing benchmark task folders",
      })
```

Change handler signature from:

```ts
async ({ agent: agentName, model: modelId, task: taskId }) => {
```

to:

```ts
async ({ agent: agentName, model: modelId, task: taskId, tasksDir }) => {
```

Change:

```ts
const result = await Eval.run(agentName, modelId, taskId, { logger });
```

to:

```ts
const result = await Eval.run(agentName, modelId, taskId, { logger, tasksDir });
```

- [ ] **Step 3: Run typecheck**

Run: `bun run check`

Expected: PASS.

---

### Task 6: Smoke-test external local task generation

**Files:**
- No source files modified unless a bug is found.

**Interfaces:**
- Consumes: CLI from Tasks 1-5.
- Produces: evidence that `--tasks-dir` plus `source.type: local` generates `diff.patch` and `prompt.yml`.

- [ ] **Step 1: Create a temporary local git fixture**

Run:

```bash
fixture=$(mktemp -d)
repo="$fixture/repo"
tasks="$fixture/tasks"
mkdir -p "$repo" "$tasks/local-fixture"
git -C "$repo" init
git -C "$repo" config user.email bench@example.com
git -C "$repo" config user.name bench
printf 'export function value() { return 1; }\n' > "$repo/index.ts"
git -C "$repo" add index.ts
git -C "$repo" commit -m 'initial'
from=$(git -C "$repo" rev-parse HEAD)
printf 'export function value() { return 2; }\n' > "$repo/index.ts"
git -C "$repo" add index.ts
git -C "$repo" commit -m 'change value'
to=$(git -C "$repo" rev-parse HEAD)
cat > "$tasks/local-fixture/definition.yml" <<EOF
source:
  type: local
  repo: $repo
  from: $from
  to: $to
metrics:
  - name: checks
    weight: 1
    args:
      setup: []
      commands:
        - test -f index.ts
EOF
printf '%s\n' "$fixture"
```

Expected: command prints the fixture directory path.

- [ ] **Step 2: Run generation**

Use the printed fixture path:

```bash
bun run dev -- generate --tasks-dir "$fixture/tasks"
```

Expected: command succeeds, creates `$fixture/tasks/local-fixture/diff.patch`, and creates `$fixture/tasks/local-fixture/prompt.yml`. If model credentials for prompt generation are unavailable, record the failure and instead manually create a minimal `prompt.yml` to continue loader smoke tests.

- [ ] **Step 3: Verify task can be listed via loader indirectly**

Run:

```bash
bun run check
```

Expected: PASS.

---

### Task 7: Document custom tasks

**Files:**
- Modify: `README.md:29-53` and add a new section after Basic Usage or Development Mode.

**Interfaces:**
- Consumes: CLI behavior from Tasks 1-5.
- Produces: documented examples for GitHub custom tasks, local custom tasks, and `--tasks-dir`.

- [ ] **Step 1: Add custom task documentation**

Add this section after Development Mode:

```md
### Custom Task Sets

By default, OpenCode Bench loads benchmark tasks from `src/tasks`. You can keep your own task set outside the source tree with `--tasks-dir`:

```bash
bun run dev -- generate --tasks-dir ./bench-tasks
bun run dev -- opencode --model opencode-go/deepseek-v4-pro --task my-task --tasks-dir ./bench-tasks
```

Each task is a folder containing `definition.yml`, `prompt.yml`, and `diff.patch`. The folder name is the task id used by `--task`.

GitHub tasks can use the existing format:

```yaml
source:
  repo: DataDog/datadog-lambda-python
  from: 93d4a07fa61a4d4d2feec08e722505a9e0cc8657
  to: d7763789f262b2da228f8210509e302e6e510d0a
metrics:
  - name: checks
    weight: 1
    args:
      setup: []
      commands:
        - pytest
```

Local git repository tasks use `source.type: local`:

```yaml
source:
  type: local
  repo: /home/me/repos/internal-service
  from: abc123
  to: def456
context: |
  Optional maintainer context used when generating prompts.
metrics:
  - name: checks
    weight: 1
    args:
      setup:
        - bun install
      commands:
        - bun test
```

Run `generate` after adding a task definition to create missing `diff.patch` and `prompt.yml` files. Existing generated files are left unchanged.
```

- [ ] **Step 2: Fix stale timeout text if still present**

If `README.md` still says the agent runs with a 30-minute timeout, update it to 40 minutes to match the current code.

- [ ] **Step 3: Run final verification**

Run:

```bash
bun run check
```

Expected: PASS.

---

## Self-Review

Spec coverage:
- External `--tasks-dir`: Tasks 2, 3, 5, 7.
- GitHub compatibility/default source type: Tasks 2, 3, 5.
- Local git source generation: Tasks 1, 3, 6.
- Local git source evaluation: Tasks 1, 4.
- Error handling: Tasks 1 and 2 validate local repositories and task paths through existing filesystem errors with clearer task-not-found messages.
- Documentation: Task 7.

Placeholder scan: no TBD/TODO placeholders remain; every implementation task names concrete files, functions, commands, and expected results.

Type consistency: `LoadOptions`, `Source`, `fetchLocalComparisonDiff`, `fetchLocalCommits`, and `cloneLocalRepositoryAtCommit` are consistently named across tasks.
