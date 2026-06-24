import { spawn } from "node:child_process";
import process from "node:process";
import type { Agent } from "./index.js";

// Wildcard: accept any model name (validation skipped)
export const models = ["*"];

const claudeCodeAgent: Agent.Definition = {
  async run(model, prompt, options) {
    options.logger.log(`claude --model ${model} --print "${prompt.slice(0, 80)}..."`);

    return new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        ["--model", model, "--print", "--output-format", "json", prompt],
        {
          cwd: options.cwd,
          env: {
            ...process.env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `claude CLI exited with code ${code}\nstderr: ${stderr.slice(0, 1000)}`,
            ),
          );
          return;
        }

        const actions: string[] = [];
        if (stdout) actions.push(stdout);

        // Try to extract token usage if JSON output
        let input = 0;
        let output = 0;
        let cost = 0;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.usage) {
            input = parsed.usage.input_tokens ?? parsed.usage.input ?? 0;
            output = parsed.usage.output_tokens ?? parsed.usage.output ?? 0;
            cost = parsed.total_cost ?? parsed.total_cost_usd ?? 0;
          }
        } catch {
          // Non-JSON output; ignore usage extraction
        }

        resolve({ actions, usage: { input, output, cost } });
      });
    });
  },
};

export default claudeCodeAgent;
