import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { generateObject } from "ai";

type GenerateObjectOptions = Parameters<typeof generateObject>[0];
type SupportedModel = NonNullable<GenerateObjectOptions["model"]>;

type ProviderConfig = {
  baseURL: string;
  apiKeyEnv: string;
  api: "openai" | "openai-compatible" | "anthropic";
};

type ConfigFile = {
  providers: Record<string, ProviderConfig>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "judge-providers.json");

const OPENCODE_FALLBACK: ProviderConfig = {
  baseURL: "https://opencode.ai/zen/go/v1",
  apiKeyEnv: "OPENCODE_API_KEY",
  api: "openai-compatible",
};

const modelCache = new Map<string, SupportedModel>();
const providerInstanceCache = new Map<string, (modelId: string) => SupportedModel>();
let config: ConfigFile | undefined;

function loadConfig(): ConfigFile {
  if (config) return config;

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    config = JSON.parse(raw) as ConfigFile;
  } catch {
    config = { providers: {} };
  }

  return config;
}

function resolveProvider(prefix: string): ProviderConfig {
  const cfg = loadConfig();

  if (cfg.providers[prefix]) {
    return cfg.providers[prefix];
  }

  if (prefix === "opencode-go") {
    return OPENCODE_FALLBACK;
  }

  const available = Object.keys(cfg.providers).join(", ");
  assert(
    false,
    `Unknown provider "${prefix}". ` +
      `Add it to judge-providers.json. ` +
      `Available: ${available || "(none)"}`,
  );
}

function resolveApiKey(provider: ProviderConfig): string {
  const value = process.env[provider.apiKeyEnv]?.trim();
  assert(
    value,
    `Missing API key for provider. Set ${provider.apiKeyEnv} environment variable.`,
  );
  return value;
}

function getProviderFn(prefix: string, provider: ProviderConfig): (modelId: string) => SupportedModel {
  const cached = providerInstanceCache.get(prefix);
  if (cached) return cached;

  const apiKey = resolveApiKey(provider);
  const { baseURL, api } = provider;

  let fn: (modelId: string) => SupportedModel;

  switch (api) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey, baseURL });
      fn = (modelId) => anthropic(modelId) as unknown as SupportedModel;
      break;
    }
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      fn = (modelId) => openai(modelId) as unknown as SupportedModel;
      break;
    }
    case "openai-compatible":
    default: {
      const compat = createOpenAICompatible({
        apiKey,
        baseURL,
        name: prefix,
      });
      fn = (modelId) => compat(modelId) as unknown as SupportedModel;
      break;
    }
  }

  providerInstanceCache.set(prefix, fn);
  return fn;
}

export function getZenLanguageModel(modelId: string): SupportedModel {
  const trimmed = modelId.trim();
  assert(trimmed.length > 0, "Model identifier cannot be empty.");

  if (modelCache.has(trimmed)) {
    return modelCache.get(trimmed)!;
  }

  const slashIndex = trimmed.indexOf("/");
  assert(
    slashIndex > 0,
    `Model ID must have provider prefix: "provider/model", got "${trimmed}"`,
  );

  const prefix = trimmed.slice(0, slashIndex);
  const modelName = trimmed.slice(slashIndex + 1);

  const provider = resolveProvider(prefix);
  const providerFn = getProviderFn(prefix, provider);
  const model = providerFn(modelName);

  modelCache.set(trimmed, model);
  return model;
}
