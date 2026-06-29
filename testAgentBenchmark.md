# Agent Benchmark 测试命令

记录所有 agent + model + task 组合的运行命令。目标：**用同一个 LLM 对比不同 agent 的效果**，所以只跑开源模型（DeepSeek / Qwen / GLM），闭源 Claude/GPT/Gemini 已从注册列表里剔除。

Judge 走 `judge-providers.json` 里配置的 DeepSeek 直连（`DEEPSEEK_API_KEY`），不再依赖 OpenCode Zen 余额。

---

## 调用形式

```bash
bun run cli.ts <agent> --model <provider/model> --task <repo@from..to>
```

| Task ID | 仓库 |
|---|---|
| `DataDog/datadog-lambda-python@93d4a07..d776378` | DataDog/datadog-lambda-python |
| `sst/opencode@090d27d..b3c6d0b` | sst/opencode (formatting) |
| `sst/opencode@5f7e1e0..a96365f` | sst/opencode (session-rename) |
| `getsentry/sentry@62c4c65..b950f76` | getsentry/sentry (uptime-detector) |
| `getsentry/sentry@e7968da..6ceee3b` | getsentry/sentry (product-trial-banner) |
| `HelixDB/helix-db@35a9e73..12ebac2` | HelixDB/helix-db (cli-update-blocking) |
| `HelixDB/helix-db@ac6d036..651aef3` | HelixDB/helix-db (cli-update) |

下面统一以 `DataDog/datadog-lambda-python@93d4a07..d776378` 为例，换 task 时替换 `--task`。

---

## 🔁 跨 agent 同模型对比（最有价值）

opencode 和 workspace 都有 DeepSeek 系列；workspace 是内部 v4/V3.2，opencode 是 deepseek 官方 v4-flash/pro。严格"同名同型"对比目前没有重合，但**DeepSeek v4 家族**横跨两边可作为最接近的对比组：

```bash
# opencode 走 deepseek 直连
bun run cli.ts opencode  --model deepseek/deepseek-v4-pro   --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts opencode  --model deepseek/deepseek-v4-flash --task DataDog/datadog-lambda-python@93d4a07..d776378

# workspace 走内部 LLM 网关
bun run cli.ts workspace --model workspace/deepseek_v4      --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts workspace --model workspace/DeepSeek-V3.2    --task DataDog/datadog-lambda-python@93d4a07..d776378
```

---

## opencode agent

```bash
# 走 OpenCode Zen Go (deepseek 路由)
bun run cli.ts opencode --model opencode-go/deepseek-v4-pro   --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts opencode --model opencode-go/deepseek-v4-flash --task DataDog/datadog-lambda-python@93d4a07..d776378

# 走 DeepSeek 官方直连 (DEEPSEEK_API_KEY)
bun run cli.ts opencode --model deepseek/deepseek-v4-pro      --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts opencode --model deepseek/deepseek-v4-flash    --task DataDog/datadog-lambda-python@93d4a07..d776378
```

注：opencode 的 `src/agents/opencode.ts` 内置了 `deepseek` 自定义 provider，base URL `https://api.deepseek.com`，鉴权读 `DEEPSEEK_API_KEY` 环境变量。

---

## workspace agent

通过 `ws serve` 起本地 HTTP 服务器，benchmark 用 `@opencode-ai/sdk` 的客户端调用。**注意：`ws run --model` CLI 路径无效，但我们走的是 HTTP body 的 `model` 字段，它生效**。

```bash
# DeepSeek
bun run cli.ts workspace --model workspace/deepseek_v4     --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts workspace --model workspace/DeepSeek-V3.2   --task DataDog/datadog-lambda-python@93d4a07..d776378

# Qwen
bun run cli.ts workspace --model workspace/qwen3.7-max     --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts workspace --model workspace/qwen3.7-plus    --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts workspace --model workspace/qwen3.6-plus    --task DataDog/datadog-lambda-python@93d4a07..d776378

# GLM
bun run cli.ts workspace --model workspace/hw-glm-5        --task DataDog/datadog-lambda-python@93d4a07..d776378
bun run cli.ts workspace --model workspace/glm-5           --task DataDog/datadog-lambda-python@93d4a07..d776378
```

### 注意事项

- 进程第一次调用 workspace 时会 spawn `ws serve`（端口从 7437 起检测），结束时 SIGTERM。
- 若 `ws` 不在 `$PATH`：`WORKSPACE_CLI_BIN=/path/to/ws bun run cli.ts workspace ...`
- workspace 模型 ID 含**点号**：`qwen3.7-max` 不是 `qwen3-7-max`，`DeepSeek-V3.2` 大小写敏感。
- workspace 内部 LLM 不收外部账户费用，但 token usage 字段返回 0（因为内部接口不暴露 cost）。

---

## Judge 配置

`src/judges.ts` 当前用三遍 `deepseek/deepseek-v4-pro` 做评分（同一模型多次以抑制 variance penalty）。provider 路由读 `judge-providers.json`：

```json
{
  "providers": {
    "deepseek": {
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "api": "openai-compatible"
    }
  }
}
```

跑前确保 `DEEPSEEK_API_KEY` 已 export，否则 judging 阶段会报 `Missing API key`。

要切回 OpenCode Zen 判分（不推荐，会再次撞 "Insufficient balance"）只需把 judges.ts 里改回 `opencode/...` 并删 `judge-providers.json`，会落到 `zenModels.ts` 的 `OPENCODE_FALLBACK`。

---

## 批量

```bash
# 列出全部 agent × model × task 组合
bun run scripts/generate-benchmark-matrix.ts | jq .

# 转成可执行命令清单
bun run scripts/generate-benchmark-matrix.ts \
  | jq -r '.include[] | "bun run cli.ts \(.agent) --model \(.model) --task \(.eval)"'
```

当前矩阵：opencode 4 模型 + workspace 7 模型 × 7 task = **77 组合**。

---

## codex / claude-code agent

仍在 `agentLoaders` 注册中但只含闭源模型，不在本次开源对比范围内，保留 loader 仅为兼容。要跑就直接：

```bash
bun run cli.ts codex       --model gpt-5-codex          --task ...
bun run cli.ts claude-code --model claude-sonnet-4-5    --task ...
```
