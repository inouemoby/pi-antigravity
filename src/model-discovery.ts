import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityLoadCodeAssistMetadata,
  ensureProjectContext,
} from "@cortexkit/antigravity-auth-core";
import type { OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

const ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];
const MODEL_ID = /^(gemini-|claude-|gpt-oss-)/i;

export interface ModelCostRates {
  /** USD per 1 million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
  /** Apply this rate set when total input usage exceeds this token count. */
  inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[];
}

export interface DiscoveredModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

const GEMINI_FLASH_INTRO_END = Date.UTC(2027, 0, 1);

function geminiFlashCost(output: number): ModelCost {
  const introductory = Date.now() < GEMINI_FLASH_INTRO_END;
  return {
    input: introductory ? 0.75 : 1.5,
    output: introductory ? output : output * 2,
    cacheRead: introductory ? 0.075 : 0.15,
    // Google lists cached-input token rates, but no separate cache-write
    // token rate for these Gemini models. Explicit cache storage is billed
    // hourly and is not represented by Pi's per-token cacheWrite field.
    cacheWrite: 0,
  };
}

/**
 * Official Google Agent Platform equivalent rates, in USD per 1M tokens.
 * Antigravity's Pro/Ultra baseline quota is subscription-based, so these
 * values are only an equivalent estimate for Pi's cost display; they are not
 * a charge made to the user's account.
 */
export function officialCostForModel(modelId: string): ModelCost {
  const id = modelId.toLowerCase().replace(/-(minimal|low|medium|high|xhigh|max|tiered)$/i, "");

  if (/^gemini-3\.(8|7|6)-flash/.test(id)) return geminiFlashCost(3.75);
  if (/^gemini-3\.5-flash/.test(id)) {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 };
  }
  if (/^gemini-3\.1-flash-lite/.test(id)) {
    return { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 };
  }
  if (/^gemini-3\.1-pro/.test(id)) {
    return {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
    };
  }
  if (/^gemini-2\.5-pro/.test(id)) {
    return {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
    };
  }
  if (/^gemini-2\.5-flash/.test(id)) {
    return { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 };
  }
  if (/^claude-sonnet-4-6/.test(id)) {
    return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  }
  if (/^claude-opus-4-6/.test(id)) {
    return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  }
  if (/^gpt-oss-120b/.test(id)) {
    return { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 };
  }

  // Unknown models must remain free rather than being assigned a price for
  // a different model. They can be added here when Google publishes rates.
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export const BASELINE_MODELS: DiscoveredModel[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_535,
  },
  {
    id: "claude-sonnet-4-6-thinking",
    name: "Claude Sonnet 4.6 Thinking",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250_000,
    maxTokens: 64_000,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 32_768,
  },
];

// Keep exported baseline entries and every provider registration priced too.
for (const model of BASELINE_MODELS) {
  model.cost = officialCostForModel(model.id);
}

type RawModelInfo = {
  displayName?: unknown;
  label?: unknown;
  name?: unknown;
  modelName?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  inputModalities?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  maxOutputTokenCount?: unknown;
};

type AvailableModelsResponse = {
  models?: Record<string, RawModelInfo>;
  defaultAgentModelId?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasImageInput(info: RawModelInfo): boolean {
  if (info.supportsImages === true) return true;
  if (Array.isArray(info.inputModalities)) {
    return info.inputModalities.some((value) => String(value).toLowerCase().includes("image"));
  }
  return false;
}

function normalizeModelName(id: string, info: RawModelInfo): string {
  const custom = stringValue(info.displayName)
    ?? stringValue(info.label)
    ?? stringValue(info.name)
    ?? stringValue(info.modelName);
  if (custom) return custom;

  // Format id nicely if no display name
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function modelDefinition(id: string, info: RawModelInfo): DiscoveredModel {
  const name = normalizeModelName(id, info);
  const reasoning = info.supportsThinking === true
    || info.supportsThinking === undefined && /gemini|claude|gpt-oss/i.test(id);

  return {
    id,
    name,
    reasoning,
    input: hasImageInput(info) ? ["text", "image"] : ["text"],
    cost: officialCostForModel(id),
    contextWindow: numberValue(info.contextWindow, 1_048_576),
    maxTokens: numberValue(info.maxOutputTokens ?? info.maxOutputTokenCount ?? info.maxTokens, 65_536),
  };
}

function extractModels(payload: unknown): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as AvailableModelsResponse).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  return Object.entries(models)
    .filter(([id]) => MODEL_ID.test(id) && !/\s/.test(id))
    .map(([id, info]) => modelDefinition(id, info ?? {}));
}

export function getCacheFilePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
  return path.join(agentDir, "antigravity-models.json");
}

function mergeModels(discovered: DiscoveredModel[]): DiscoveredModel[] {
  const map = new Map<string, DiscoveredModel>();
  for (const m of BASELINE_MODELS) {
    map.set(m.id, m);
  }
  for (const m of discovered) {
    map.set(m.id, m);
  }
  return Array.from(map.values(), (model) => ({
    ...model,
    cost: officialCostForModel(model.id),
  }));
}

export function loadCachedModels(): DiscoveredModel[] {
  try {
    const cacheFile = getCacheFilePath();
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        return mergeModels(data);
      }
    }
  } catch {
    // Ignore read errors
  }
  return BASELINE_MODELS;
}

export function saveCachedModels(models: DiscoveredModel[]): void {
  try {
    const cacheFile = getCacheFilePath();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(models, null, 2), "utf-8");
  } catch {
    // Ignore write errors
  }
}

export async function queryAntigravityModels(
  accessToken: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const project = await ensureProjectContext({
    type: "oauth",
    refresh: refreshToken,
    access: accessToken,
    expires: Date.now() + 60_000,
  });
  if (!project.effectiveProjectId) return [];

  const headers = {
    ...buildAntigravityHarnessBootstrapHeaders(accessToken),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata()),
  };

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: project.effectiveProjectId }),
        signal,
      });
      if (!response.ok) continue;
      const models = extractModels(await response.json());
      if (models.length > 0) return models;
    } catch {
      // Continue to next endpoint
    }
  }
  return [];
}

export async function fetchAntigravityModels(context: RefreshModelsContext): Promise<DiscoveredModel[]> {
  const credential = context.credential?.type === "oauth" ? context.credential as OAuthCredentials : undefined;
  if (!credential?.access || !context.allowNetwork || context.signal.aborted) {
    return loadCachedModels();
  }

  try {
    const models = await queryAntigravityModels(credential.access, credential.refresh, context.signal);
    if (models.length > 0) {
      const merged = mergeModels(models);
      saveCachedModels(merged);
      return merged;
    }
  } catch {
    // Fall back to cached models
  }
  return loadCachedModels();
}
