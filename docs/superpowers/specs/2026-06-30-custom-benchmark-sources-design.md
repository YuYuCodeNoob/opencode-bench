# Custom Benchmark Task Sources Design

## Goal

Support custom benchmark task sets without forcing users to add every task under `src/tasks`, and allow task generation/evaluation from both GitHub repositories and local git repositories.

## Scope

This change supports three task workflows:

1. Existing built-in tasks under `src/tasks`.
2. External task directories passed with `--tasks-dir`.
3. Local git repository sources in task definitions.

The first implementation intentionally does not add arbitrary remote git URL support such as GitLab or SSH URLs. The data model should leave room for a future `type: git` source, but only `github` and `local` are implemented now.

## Task directory model

A task directory remains a folder containing:

- `definition.yml`
- `prompt.yml`
- `diff.patch`

The task id is still the folder name. If users pass `--tasks-dir ./bench-tasks`, a task at `./bench-tasks/my-task` is selected with `--task my-task`.

If `--tasks-dir` is omitted, the benchmark behaves as it does today and loads from the built-in `src/tasks` directory. The `_sample` folder remains excluded from task listing/generation.

## Task definition schema

Existing GitHub definitions stay valid:

```yaml
source:
  repo: DataDog/datadog-lambda-python
  from: 93d4a07fa61a4d4d2feec08e722505a9e0cc8657
  to: d7763789f262b2da228f8210509e302e6e510d0a
```

They are treated as:

```yaml
source:
  type: github
  repo: DataDog/datadog-lambda-python
  from: 93d4a07fa61a4d4d2feec08e722505a9e0cc8657
  to: d7763789f262b2da228f8210509e302e6e510d0a
```

Local repository definitions use:

```yaml
source:
  type: local
  repo: /home/yuyx51/repos/my-internal-repo
  from: abc123
  to: def456
context: |
  Optional maintainer context for prompt generation.
metrics:
  - name: checks
    weight: 1
    args:
      setup:
        - bun install
      commands:
        - bun test
```

For `type: github`, `repo` must keep the `owner/name` format. For `type: local`, `repo` is a local filesystem path to an existing git repository.

## CLI behavior

Add `--tasks-dir` to both commands:

```bash
bun run dev -- generate --tasks-dir ./bench-tasks
bun run dev -- opencode --model opencode-go/deepseek-v4-pro --task my-task --tasks-dir ./bench-tasks
```

`--tasks-dir` defaults to the built-in task directory, preserving current behavior. CI scripts and matrix generation can continue using the default unless the caller opts into an external task set.

## Generation behavior

For GitHub tasks, generation continues to use the existing GitHub API path:

- compare `from...to` to produce `diff.patch`
- fetch commits between the range
- generate one prompt per commit

For local tasks, generation uses local git commands in `source.repo`:

- `git diff --binary from..to` or equivalent to produce `diff.patch`
- `git log --reverse --format` to list commits in `from..to`
- for each commit, fetch title and per-commit diff from the local repository
- feed those local commit diffs into the existing prompt-generation logic

Existing generated files are not overwritten, matching the current `generate` behavior.

## Evaluation behavior

Evaluation clones the source repository into the benchmark temp directory and checks out `source.from`.

- GitHub source: keep the existing GitHub clone behavior.
- Local source: clone from the local path with `git clone <local-path> <temp-dir>` and checkout `source.from`.

The rest of evaluation remains unchanged: run setup/check commands, run agent prompts, commit the agent snapshot, generate the actual diff against `source.from`, and score against `diff.patch`.

## Error handling

Validation should fail early with clear messages when:

- `--tasks-dir` does not exist or is not readable.
- A requested task id is not found in the selected task directory.
- `type: github` has a repo that is not `owner/name`.
- `type: local` points to a missing path or non-git repository.
- local git commands fail for invalid commits or malformed history ranges.

## Tests and verification

Use typechecking and targeted CLI smoke checks:

- `bun run check`
- `bun run dev -- generate --tasks-dir <temporary-task-dir>` with a small local git fixture if practical
- `bun run dev -- <agent> --model <model> --task <task> --tasks-dir <dir>` only if credentials/model setup are available; otherwise verify the task loader and generation path without running a full model benchmark

## Compatibility

The implementation must preserve existing commands and built-in tasks. Existing `definition.yml` files do not need to be edited. Existing CI scripts should keep working because default task discovery remains `src/tasks`.
