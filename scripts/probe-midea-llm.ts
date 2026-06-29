#!/usr/bin/env bun
/**
 * 小脚本：用怀疑的 auth token 探测 Midea 内部 LiteLLM 网关的 OpenAI 兼容端点。
 *
 * 用法：
 *   MIDEA_LLM_TOKEN=<your token>  bun run scripts/probe-midea-llm.ts
 *   # 可选：覆盖默认参数
 *   MIDEA_LLM_TOKEN=xxx  MIDEA_LLM_MODEL=deepseek_v4  bun run scripts/probe-midea-llm.ts
 *   MIDEA_LLM_TOKEN=xxx  MIDEA_LLM_BASE_URL=https://.../v1  bun run scripts/probe-midea-llm.ts
 *
 * 输出三段：
 *   1. GET /v1/models      → token 是否被网关认 (200 = 可用)
 *   2. POST /v1/chat/completions (普通)
 *   3. POST /v1/chat/completions (stream)
 */

const BASE_URL =
  process.env.MIDEA_LLM_BASE_URL?.replace(/\/+$/, "") ||
  "https://apiprod.midea.com/llm/f-devops-python-litellm/v1";
const TOKEN = process.env.MIDEA_LLM_TOKEN ?? "wrk-01KVSDXK8JP2RNQRMK6A918Z3S";
const MODEL = process.env.MIDEA_LLM_MODEL || "deepseek_v4";

if (!TOKEN) {
  console.error("❌ MIDEA_LLM_TOKEN is not set. Export it before running.");
  console.error("   export MIDEA_LLM_TOKEN='<paste token here>'");
  process.exit(1);
}

console.log(`base_url : ${BASE_URL}`);
console.log(`model    : ${MODEL}`);
console.log(`token    : ${TOKEN.slice(0, 8)}…${TOKEN.slice(-4)}  (len=${TOKEN.length})`);
console.log();

const auth = { Authorization: `Bearer ${TOKEN}` };

function divider(title: string) {
  console.log(`\n──── ${title} ────`);
}

function previewBody(s: string, max = 600) {
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} bytes)` : s;
}

/* 1. GET /v1/models — 最廉价的鉴权验证 */
divider("1. GET /v1/models");
try {
  const r = await fetch(`${BASE_URL}/models`, { headers: auth });
  const body = await r.text();
  console.log(`HTTP ${r.status} ${r.statusText}`);
  console.log(`content-type: ${r.headers.get("content-type")}`);
  console.log(previewBody(body));
  if (r.status === 200) {
    try {
      const data = JSON.parse(body);
      const ids = (data.data || []).map((m: any) => m.id);
      console.log(`✓ token works — ${ids.length} models exposed`);
      if (ids.length) console.log(`  sample: ${ids.slice(0, 8).join(", ")}…`);
    } catch {}
  } else if (r.status === 401 || r.status === 403) {
    console.log("✗ auth rejected — token invalid or missing scope");
  } else {
    console.log("? unexpected status");
  }
} catch (e) {
  console.error("network error:", e);
}

/* 2. POST /v1/chat/completions — 普通调用 */
divider("2. POST /v1/chat/completions  (non-stream)");
try {
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: "Reply with exactly the word: pong" },
      ],
      max_tokens: 16,
      temperature: 0,
    }),
  });
  const body = await r.text();
  console.log(`HTTP ${r.status} ${r.statusText}`);
  console.log(previewBody(body));
  if (r.status === 200) {
    try {
      const data = JSON.parse(body);
      const content = data.choices?.[0]?.message?.content;
      const usage = data.usage;
      console.log(`✓ completion ok`);
      console.log(`  content: ${JSON.stringify(content)}`);
      if (usage) console.log(`  usage  : ${JSON.stringify(usage)}`);
    } catch {}
  }
} catch (e) {
  console.error("network error:", e);
}

/* 3. POST /v1/chat/completions — stream */
divider("3. POST /v1/chat/completions  (stream)");
try {
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Count: 1 2 3" }],
      max_tokens: 32,
      temperature: 0,
      stream: true,
    }),
  });
  console.log(`HTTP ${r.status} ${r.statusText}`);
  console.log(`content-type: ${r.headers.get("content-type")}`);
  if (!r.ok || !r.body) {
    console.log(previewBody(await r.text()));
  } else {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let firstChunkAt = 0;
    const startedAt = Date.now();
    let accumulated = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstChunkAt) firstChunkAt = Date.now() - startedAt;
      const text = decoder.decode(value);
      accumulated += text;
      chunks++;
      if (chunks <= 3) console.log(`  chunk #${chunks}: ${previewBody(text, 200)}`);
    }
    console.log(`✓ stream ok — ${chunks} chunks, first chunk at ${firstChunkAt}ms`);
    console.log(`  total bytes: ${accumulated.length}`);
  }
} catch (e) {
  console.error("network error:", e);
}

console.log("\nDone.");
