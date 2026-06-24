import { execSync } from "node:child_process";

export function $(strings: TemplateStringsArray, ...values: unknown[]) {
  const cmd = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), "");

  return {
    quiet: async () => {
      try {
        execSync(cmd, { stdio: "ignore" });
      } catch (e: any) {
        const err = new Error(e.message || "Command failed") as any;
        err.status = e.status || 1;
        err.exitCode = e.status || 1;
        throw err;
      }
    },
    text: async () => {
      try {
        return execSync(cmd, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch (e: any) {
        const err = new Error(e.message || "Command failed") as any;
        err.status = e.status || 1;
        err.exitCode = e.status || 1;
        throw err;
      }
    },
  };
}
