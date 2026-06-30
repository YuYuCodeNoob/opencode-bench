#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-local-task.sh \
    --repo /path/to/local/repo \
    [--from <base-commit>] \
    [--to <target-commit>] \
    --task <task-id> \
    [--setup "command"]... \
    [--check "command"]... \
    [--limit 30] \
    [--force]

Generates a benchmark task in src/tasks/<task-id>/ using the existing task
format:
  - definition.yml: local repo metadata and metric commands
  - diff.patch: git diff --binary <from>..<to>
  - prompt.yml: prompts generated directly from commit messages

If --from or --to is omitted in an interactive terminal, the script lists
recent commits and lets you choose by number or enter a commit SHA (Ctrl+C to exit).

Examples:
  scripts/generate-local-task.sh \
    --repo ~/repos/my-project \
    --task my-project-feature \
    --setup "bun install" \
    --check "bun test"

  scripts/generate-local-task.sh \
    --repo ~/repos/my-project \
    --from abc123 \
    --to def456 \
    --task my-project-feature \
    --setup "bun install" \
    --check "bun test"
USAGE
}

repo=""
from=""
to=""
task=""
force=0
limit=30
setup_cmds=()
check_cmds=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --from)
      from="${2:-}"
      shift 2
      ;;
    --to)
      to="${2:-}"
      shift 2
      ;;
    --task)
      task="${2:-}"
      shift 2
      ;;
    --setup)
      setup_cmds+=("${2:-}")
      shift 2
      ;;
    --check)
      check_cmds+=("${2:-}")
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    --limit)
      limit="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$repo" || -z "$task" ]]; then
  echo "Missing required --repo or --task." >&2
  usage >&2
  exit 2
fi

if [[ ! "$task" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid task id '$task'. Use only letters, numbers, dot, underscore, and dash." >&2
  exit 2
fi

if [[ ! "$limit" =~ ^[0-9]+$ || "$limit" -lt 1 ]]; then
  echo "--limit must be a positive integer." >&2
  exit 2
fi

if [[ "$repo" =~ ^[A-Za-z][A-Za-z0-9+.-]*:// || "$repo" =~ ^[^@[:space:]]+@[^:[:space:]]+: ]]; then
  echo "--repo must be a local filesystem path, not a remote git URL." >&2
  exit 2
fi

repo_abs=$(python3 -c 'import os, sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$repo")

if [[ ! -d "$repo_abs" ]]; then
  echo "Repository path does not exist: $repo_abs" >&2
  exit 2
fi

if [[ "$(git -C "$repo_abs" rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]]; then
  echo "Not a git repository: $repo_abs" >&2
  exit 2
fi

# Interactive commit selection when --from or --to is not provided
select_commit() {
  local label="$1"
  local selected=""
  local full_sha=""

  if [[ ! -t 0 ]]; then
    echo "--$label is required when not running interactively." >&2
    exit 2
  fi

  echo "Select --$label commit from $repo_abs:" >&2
  mapfile -t commit_lines < <(git -C "$repo_abs" log --date=short --pretty=format:'%h %ad %s' -n "$limit")
  if [[ ${#commit_lines[@]} -eq 0 ]]; then
    echo "No commits found in $repo_abs" >&2
    exit 2
  fi

  local i=1
  for line in "${commit_lines[@]}"; do
    printf '  %2d) %s\n' "$i" "$line" >&2
    i=$((i + 1))
  done

  while true; do
    printf 'Enter number or commit SHA (Ctrl+C to exit): ' >&2
    IFS= read -r selected
    if [[ -z "$selected" ]]; then
      echo "Please enter a number or commit SHA." >&2
      continue
    fi

    if [[ "$selected" =~ ^[0-9]+$ && "$selected" -ge 1 && "$selected" -le ${#commit_lines[@]} ]]; then
      selected="${commit_lines[$((selected - 1))]%% *}"
    fi

    if full_sha=$(git -C "$repo_abs" rev-parse --verify "$selected^{commit}" 2>/dev/null); then
      printf '%s\n' "$full_sha"
      return 0
    fi

    echo "Commit not found: $selected" >&2
  done
}

if [[ -z "$from" ]]; then
  from=$(select_commit from)
fi
if [[ -z "$to" ]]; then
  to=$(select_commit to)
fi

git -C "$repo_abs" rev-parse --verify "$from^{commit}" >/dev/null
git -C "$repo_abs" rev-parse --verify "$to^{commit}" >/dev/null

if [[ ${#check_cmds[@]} -eq 0 ]]; then
  check_cmds=("true")
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
task_dir="$repo_root/src/tasks/$task"

if [[ -e "$task_dir" && "$force" -ne 1 ]]; then
  echo "Task directory already exists: $task_dir" >&2
  echo "Pass --force to replace it." >&2
  exit 2
fi

if [[ "$force" -eq 1 ]]; then
  rm -rf -- "$task_dir"
fi

mkdir -p -- "$task_dir"

git -C "$repo_abs" diff --binary "$from..$to" > "$task_dir/diff.patch"
if [[ ! -s "$task_dir/diff.patch" ]]; then
  echo "Generated diff.patch is empty for $from..$to" >&2
  exit 1
fi

python3 - "$task_dir" "$repo_abs" "$from" "$to" "${setup_cmds[@]}" -- "${check_cmds[@]}" <<'PY'
import datetime
import re
import subprocess
import sys
from pathlib import Path

task_dir = Path(sys.argv[1])
repo = sys.argv[2]
from_ref = sys.argv[3]
to_ref = sys.argv[4]
rest = sys.argv[5:]
sep = rest.index("--")
setup_cmds = rest[:sep]
check_cmds = rest[sep + 1:]

raw = subprocess.check_output(
    ["git", "-C", repo, "log", "--reverse", "--format=%H%x00%B%x00%x1e", f"{from_ref}..{to_ref}"],
    text=True,
)

prompts = []
for record in raw.split("\x1e"):
    record = record.strip("\n")
    if not record:
        continue
    parts = record.split("\x00", 2)
    if len(parts) < 2:
        continue
    commit = parts[0].strip()
    message = parts[1].strip()
    if not message:
        message = f"Implement commit {commit}"
    prompts.append((commit, message))

if not prompts:
    raise SystemExit(f"No commits found in range {from_ref}..{to_ref}")

def yaml_quote(value: str) -> str:
    # Force quote YAML booleans and numbers to prevent type coercion
    if value.lower() in ("true", "false", "yes", "no", "on", "off"):
        return f"'{value}'"
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][+-]?\d+)?", value):
        return f"'{value}'"
    if value == "":
        return "''"
    if any(ch in value for ch in ":#{}[],&*?|-<>=!%@`\\\"'") or value.strip() != value:
        return "'" + value.replace("'", "''") + "'"
    return value

def block_scalar(value: str, indent: int) -> str:
    pad = " " * indent
    lines = value.splitlines() or [""]
    return "|\n" + "\n".join(f"{pad}{line}" if line else pad for line in lines)

with (task_dir / "prompt.yml").open("w", encoding="utf-8") as f:
    f.write(f"generated_at: {datetime.datetime.now(datetime.UTC).isoformat()}\n")
    f.write("prompts:\n")
    for commit, message in prompts:
        f.write(f"  - commit: {commit}\n")
        f.write("    prompt: ")
        f.write(block_scalar(message, 6))
        f.write("\n")

with (task_dir / "definition.yml").open("w", encoding="utf-8") as f:
    f.write("source:\n")
    f.write("  type: local\n")
    f.write(f"  repo: {yaml_quote(repo)}\n")
    f.write(f"  from: {yaml_quote(from_ref)}\n")
    f.write(f"  to: {yaml_quote(to_ref)}\n")
    f.write("metrics:\n")
    f.write("  - name: api-signature\n    weight: 0.2\n")
    f.write("  - name: logic-equivalence\n    weight: 0.3\n")
    f.write("  - name: integration-points\n    weight: 0.2\n")
    f.write("  - name: test-coverage\n    weight: 0.2\n")
    f.write("  - name: checks\n    weight: 0.1\n    args:\n      setup:\n")
    if setup_cmds:
        for cmd in setup_cmds:
            f.write(f"        - {yaml_quote(cmd)}\n")
    else:
        f.write("        []\n")
    f.write("      commands:\n")
    for cmd in check_cmds:
        f.write(f"        - {yaml_quote(cmd)}\n")
PY

cat <<EOF
Generated task: $task
Task directory: $task_dir
Repository: $repo_abs
Range: $from..$to
Next:
  bun run dev -- opencode --model <provider/model> --task $task
EOF
