import { execSync } from "node:child_process";

let _cwd: string | undefined;

function shell(strings: TemplateStringsArray, ...values: unknown[]) {
  const cmd = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), "");

  return {
    quiet: async () => {
      try {
        execSync(cmd, { stdio: "ignore", cwd: _cwd });
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
          cwd: _cwd,
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

shell.cwd = (path: string) => {
  _cwd = path;
};

export const $ = shell;
