# Task 5 Report: Add CLI `--tasks-dir` option

## Summary
I successfully implemented the `--tasks-dir` CLI option for both the `generate` and benchmark commands as requested in Task 5.

## Changes Made
1. **Modified `cli.ts`**:
   - Added `--tasks-dir` option to the `generate` command with appropriate description
   - Passed the `tasksDir` parameter to `Task.generate({ logger, tasksDir })`
   - Added `--tasks-dir` option to the benchmark command with the same description
   - Passed the `tasksDir` parameter to `Eval.run(agentName, modelId, taskId, { logger, tasksDir })`

2. **Verified build**:
   - Ran `bun run build` successfully
   - The build process completed without errors

## Usage Examples
```bash
# Generate dataset with custom tasks directory
orvl generate --tasks-dir ./bench-tasks

# Run benchmark with custom tasks directory
orvl opencode --model opencode/gpt-5-codex --task DataDog/datadog-lambda-python@93d4a07..d776378 --tasks-dir ./bench-tasks
```

## Technical Details
- The `--tasks-dir` option is optional and maintains backward compatibility
- Default behavior remains unchanged when the option is not specified
- The parameter is properly passed through to both `Task.generate()` and `Eval.run()` functions
- Both commands now support specifying a custom directory containing benchmark task folders

## Commit Information
The changes have been committed with Co-Authored-By trailer.

## Build Summary
Successfully built the project with `bun run build`. The output bundle is located at `dist/cli.js`.

## Concerns
No concerns identified. The implementation follows all requirements and maintains backward compatibility.