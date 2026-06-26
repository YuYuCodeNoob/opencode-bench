import { strict as assert } from "node:assert";
import { Logger } from "../util/logger.js";

export namespace Agent {
  export type Prompt = string;

  export type CommandSpec =
    | string
    | {
        command: string;
        args?: string[];
        shell?: boolean;
      };

  export type Executor = (
    model: string,
    prompt: Prompt,
  ) => CommandSpec | Promise<CommandSpec>;

  export interface Definition<TModel extends string = string> {
    run: (
      model: TModel,
      prompt: Prompt,
      options: RunOptions,
    ) => Promise<RunResult>;
    cleanup?: () => void | Promise<void>;
  }

  export interface RunResult {
    actions: string[];
    usage: {
      input: number;
      output: number;
      cost: number;
    };
  }

  export interface RunOptions {
    cwd: string;
    logger: Logger.Instance;
  }

  export interface Registration<TModel extends string = string> {
    name: string;
    definition: Definition<TModel>;
    models: ReadonlyArray<TModel>;
  }

  function createRegistration<TModel extends string>(
    name: string,
    module: {
      default?: Definition<TModel>;
      models?: ReadonlyArray<TModel>;
    },
  ): Registration<TModel> {
    const definition = module.default;
    const models = module.models;

    assert(definition, `Agent module ${name} is missing a default export.`);
    assert(models, `Agent module ${name} is missing the exported models list.`);

    return { name, definition, models };
  }

  const agents: Record<string, Registration<any>> = {};

  async function loadOpenCodeAgent(): Promise<Registration> {
    const module = await import("./opencode.js");
    return createRegistration("opencode", module);
  }

  const agentLoaders: Record<string, () => Promise<Registration>> = {
    opencode: loadOpenCodeAgent,
    "claude-code": () =>
      import("./claude-code.js").then((m) => createRegistration("claude-code", m)),
    codex: () => import("./codex.js").then((m) => createRegistration("codex", m)),
  };

  export function list(): Registration[] {
    // Return preloaded agents; full list requires async load
    return Object.values(agents);
  }

  export async function get(name: string): Promise<Registration> {
    const cached = agents[name];
    if (cached) return cached;

    const loader = agentLoaders[name];
    if (!loader) throw new Error(`Agent ${name} was not found.`);

    const registration = await loader();
    agents[name] = registration;
    return registration;
  }

  export async function loadAll(): Promise<void> {
    for (const [name, loader] of Object.entries(agentLoaders)) {
      if (!agents[name]) {
        try {
          agents[name] = await loader();
        } catch (e) {
          // Agent unavailable; skip
        }
      }
    }
  }

  export function validateModel(agent: Registration, model: string) {
    if (agent.models.includes("*")) return; // wildcard: accept any model
    if (!agent.models.find((entry) => entry === model))
      throw new Error(
        `Model ${model} is not registered for agent ${agent.name}.`,
      );
  }
}
