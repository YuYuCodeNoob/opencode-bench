import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import detectPort from "detect-port";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Agent } from "./index.js";

// `workspace` (`ws`) is the internal opencode-derived CLI. It is invoked as a
// CLI process (`ws serve`) and talked to over HTTP — there is no npm SDK to
// import. The `ws run --model` CLI flag is ignored by the binary, but the
// HTTP `/session/{id}/message` body's `model` field IS honored, so we drive
// model selection from there.
const WS_BIN = process.env.WORKSPACE_CLI_BIN?.trim() || "ws";

const PROVIDER_ID = "workspace";

// Open-weight models exposed by `ws serve` at `/config/providers`. The
// benchmark compares the *same* LLM under different agents, so closed models
// (claude / gpt / gemini) and `auto_router` are intentionally excluded to keep
// cost predictable and the comparison apples-to-apples.
export const models: string[] = [
  "deepseek_v4",
  "DeepSeek-V3.2",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "hw-glm-5",
  "glm-5",
].map((m) => `${PROVIDER_ID}/${m}`);

let serverPromise: Promise<{ baseUrl: string; child: ChildProcess }> | null =
  null;

function startServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      const port = await detectPort(7437);
      const child = spawn(WS_BIN, ["serve", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      // Drain stdio so the child process never blocks on a full pipe.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});

      const baseUrl = `http://127.0.0.1:${port}`;
      const startupTimeoutMs = 60_000;
      const start = Date.now();
      while (Date.now() - start < startupTimeoutMs) {
        if (child.exitCode !== null) {
          throw new Error(
            `\`${WS_BIN} serve\` exited with code ${child.exitCode} before becoming healthy.`,
          );
        }
        try {
          const response = await fetch(`${baseUrl}/global/health`);
          if (response.ok) {
            return { baseUrl, child };
          }
        } catch {
          // Not ready yet — keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      child.kill("SIGTERM");
      throw new Error(
        `Timed out waiting for \`${WS_BIN} serve\` to become healthy on ${baseUrl}.`,
      );
    })();
  }
  return serverPromise;
}

const sessionCache = new Map<string, string>();

function sessionKey(model: string, cwd: string): string {
  return `${cwd}::${model}`;
}

const workspaceAgent: Agent.Definition = {
  async run(model, prompt, options) {
    const { baseUrl } = await startServer();
    options.logger.log(`workspace --model ${model} ${prompt}`);

    const client = createOpencodeClient({ baseUrl, directory: options.cwd });

    const cacheKey = sessionKey(model, options.cwd);

    options.logger.log(`Creating session...`);
    let sessionID = sessionCache.get(cacheKey);
    if (!sessionID) {
      const { data: session } = await client.session.create({
        query: { directory: options.cwd },
        throwOnError: true,
      });
      sessionID = session.id;
      sessionCache.set(cacheKey, sessionID);
    }

    options.logger.log(`Prompting session ${sessionID}...`);
    const [providerID, modelID] = model.split("/");
    const actions: string[] = [];
    const usage = {
      input: 0,
      output: 0,
      cost: 0,
    };
    try {
      const { data, error } = await client.session.prompt({
        path: { id: sessionID! },
        query: { directory: options.cwd },
        body: {
          model: { providerID, modelID },
          parts: [{ type: "text", text: prompt }],
        },
      });

      if (error) throw error;
      options.logger.debug(`Data: ${JSON.stringify(data)}`);

      const info = data.info;
      if (info) actions.push(JSON.stringify(info));
      usage.input = info?.tokens?.input ?? 0;
      usage.output = info?.tokens?.output ?? 0;
      usage.cost = info?.cost ?? 0;
      options.logger.debug(`Usage: ${JSON.stringify(usage)}`);

      if (!data.parts?.length)
        throw new Error(
          options.logger.format("Response did not include assistant parts."),
        );
      data.parts.forEach((part) => actions.push(JSON.stringify(part)));
      options.logger.debug(`Actions: ${JSON.stringify(actions)}`);
    } catch (error: any) {
      sessionCache.delete(cacheKey);
      options.logger.error("Error in workspace agent: ", error);
      throw error;
    }

    return { actions, usage };
  },
  async cleanup() {
    if (!serverPromise) return;
    try {
      const { child } = await serverPromise;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const onExit = () => resolve();
          child.once("exit", onExit);
          setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2_000);
        });
      }
    } finally {
      serverPromise = null;
    }
  },
};

export default workspaceAgent;
