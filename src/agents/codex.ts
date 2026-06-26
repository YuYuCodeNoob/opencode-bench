import { execFileSync } from "node:child_process";

import { Codex, type Thread, type ThreadItem } from "@openai/codex-sdk";

import type { Agent } from "./index.js";

export const models = ["*"];

const threadCache = new Map<string, Thread>();

function sessionKey(cwd: string): string {
  return cwd;
}

function findCodexPath(): string {
  try {
    return execFileSync("which", ["codex"]).toString().trim();
  } catch {
    return "codex";
  }
}

const codexClient = new Codex({ codexPathOverride: findCodexPath() });

function extractTextFromItems(items: ThreadItem[]): string[] {
  const texts: string[] = [];
  for (const item of items) {
    if (item.type === "agent_message") {
      texts.push(item.text);
    }
  }
  return texts;
}

const codexAgent: Agent.Definition = {
  async run(model, prompt, options) {
    options.logger.log(
      `codex --cd ${options.cwd} (config.toml default model) "${prompt.slice(0, 80)}..."`,
    );

    const key = sessionKey(options.cwd);
    const cached = threadCache.get(key);

    let thread: Thread;
    if (cached) {
      thread = cached;
    } else {
      thread = codexClient.startThread({
        sandboxMode: "danger-full-access",
        workingDirectory: options.cwd,
      });
      threadCache.set(key, thread);
    }

    let usage = { input: 0, output: 0, cost: 0 };

    try {
      const turn = await thread.run(prompt);
      const actions = turn.items.map((item) => JSON.stringify(item));

      if (turn.usage) {
        usage.input = turn.usage.input_tokens;
        usage.output = turn.usage.output_tokens;
      }

      const textParts = extractTextFromItems(turn.items);
      options.logger.log(
        `Done: ${textParts.length} messages, input=${usage.input}, output=${usage.output}`,
      );

      return { actions, usage };
    } catch (error) {
      threadCache.delete(key);
      options.logger.error("Error in codex agent:", error);
      throw error;
    }
  },

  cleanup() {
    threadCache.clear();
  },
};

export default codexAgent;
