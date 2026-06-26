import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./index.js";

export const models = ["*"];

const sessionCache = new Map<string, string>();

function sessionKey(model: string, cwd: string): string {
  return `${cwd}::${model}`;
}

function resolveClaudeModel(model: string): string {
  const modelName = model.includes("/") ? model.split("/").slice(1).join("/") : model;

  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const env = settings.env || {};

    const slots: [string, string][] = [
      ["sonnet", env.ANTHROPIC_MODEL],
      ["opus", env.ANTHROPIC_OPUS_MODEL],
      ["haiku", env.ANTHROPIC_HAIKU_MODEL],
    ].filter(([, v]) => v) as [string, string][];

    for (const [slot, configured] of slots) {
      const baseName = configured.replace(/\[.*?\]/g, "");
      if (baseName === modelName || configured.startsWith(modelName)) {
        return slot;
      }
    }
  } catch {}

  return modelName;
}

const claudeCodeAgent: Agent.Definition = {
  async run(model, prompt, options) {
    const cacheKey = sessionKey(model, options.cwd);
    const existingSessionId = sessionCache.get(cacheKey);

    options.logger.log(
      `claude-code --model ${model} ${existingSessionId ? `(resume ${existingSessionId.slice(0, 8)})` : "(new session)"} "${prompt.slice(0, 80)}..."`,
    );

    const actions: string[] = [];
    const usage = { input: 0, output: 0, cost: 0 };
    let sessionId: string | undefined;
    let result: SDKResultMessage | undefined;

    const cliModel = resolveClaudeModel(model);

    const queryStream = query({
      prompt,
      options: {
        model: cliModel,
        cwd: options.cwd,
        permissionMode: "bypassPermissions",
        maxTurns: 50,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        ...(existingSessionId ? { resume: existingSessionId } : {}),
        stderr: (data: string) => {
          options.logger.error(`[claude stderr] ${data.trim()}`);
        },
      },
    });

    try {
      for await (const message of queryStream) {
        if (!sessionId && "session_id" in message) {
          sessionId = message.session_id;
        }

        if (message.type === "assistant") {
          const textParts = message.message.content.filter(
            (block: { type: string }): block is { type: "text"; text: string } =>
              block.type === "text",
          );
          for (const part of textParts) {
            if (part.text) actions.push(part.text);
          }
        }

        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      sessionCache.delete(cacheKey);
      options.logger.error("Error in claude-code agent:", error);
      throw error;
    }

    if (sessionId) {
      sessionCache.set(cacheKey, sessionId);
    }

    if (result) {
      usage.cost = result.total_cost_usd;
      usage.input = result.usage.input_tokens ?? 0;
      usage.output = result.usage.output_tokens ?? 0;

      if (result.subtype === "success" && result.result) {
        actions.push(result.result);
      }

      options.logger.log(
        `Done: ${result.num_turns} turns, $${result.total_cost_usd.toFixed(4)}, ${(result.duration_ms / 1000).toFixed(1)}s`,
      );
    } else {
      sessionCache.delete(cacheKey);
      throw new Error("Claude Code query did not return a result");
    }

    return { actions, usage };
  },

  cleanup() {
    sessionCache.clear();
  },
};

export default claudeCodeAgent;
