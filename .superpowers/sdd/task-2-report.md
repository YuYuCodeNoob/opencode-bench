# Task 2 Report: Make task loading path-configurable and source-type-aware

## Summary

Successfully implemented Task 2 requirements:

1. **Updated imports**: Added `resolve` from `node:path` and `assertLocalGitRepository`, `fetchLocalCommits` from `~/src/util/local-git.js`
2. **Updated source schema**: Created discriminated union for GithubSource and LocalSource with default type "github"
3. **Added LoadOptions interface**: Added `{ tasksDir?: string }` for configurable task loading
4. **Updated core functions**:
   - `get`: Now accepts LoadOptions, caches by resolved task path, and includes task path in error messages
   - `listNames`: Now accepts LoadOptions and uses specified tasksDir
   - `load`: Now accepts LoadOptions, uses resolved task path, and validates local Git repositories
   - `generate`: Now accepts LoadOptions and supports both GitHub and local source types
5. **Backward compatibility**: Existing task definitions without `source.type` work as GitHub
6. **Build verification**: `bun run build` passes successfully

## Changes Made

- Modified `src/tasks/index.ts`: Updated task loading logic to be path-configurable and source-type-aware
- Modified `src/eval.ts`: Fixed references to `task.source.repo` for both GitHub and local sources
- Modified `src/summarizer.ts`: Fixed reference to `task.source.repo` for both GitHub and local sources

## Commit

Commit hash: 8dad309

## Build Summary

`bun run build` completed successfully. The TypeScript check has some unrelated module resolution errors from dependencies, but the core functionality we modified compiles correctly.

## Concerns

- The `bun run check` command has many pre-existing errors unrelated to our changes (module resolution, missing types, etc.)
- We had to fix references to `source.repo` in multiple files that don't know about the source type discrimination
- Local source type support is fully implemented but hasn't been tested with actual local repositories