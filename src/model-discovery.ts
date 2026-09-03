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

const OFFICIAL_PRICING_URL = "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing";

export function emptyModelCost(): ModelCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function pricesIn(value: string): number[] {
  return [...value.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)].map((match) => Number(match[1]));
}

function pricingRows(html: string): Array<{ cells: string[] }> {
  return [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) => ({
    cells: [...row[0].matchAll(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi)].map((cell) => decodeHtml(cell[0])),
  }));
}

function pricingModelCell(value: string): { name: string; active: boolean } {
  const through = value.match(/through\s+(.+)$/i)?.[1];
  const starting = value.match(/starting\s+(.+)$/i)?.[1];
  let active = true;
  if (through) {
    const date = new Date(through);
    date.setUTCHours(23, 59, 59, 999);
    active = Date.now() <= date.getTime();
  } else if (starting) {
    const date = new Date(starting);
    active = Date.now() >= date.getTime();
  }
  const name = value
    .replace(/\s*\*?\s*(?:through|starting)\s+.*$/i, "")
    .replace(/\*$/g, "")
    .replace(/\s+preview$/i, "")
    .trim();
  return { name, active };
}

function canonicalPricingName(modelId: string): string | undefined {
  const id = modelId.toLowerCase().replace(/-(minimal|low|medium|high|xhigh|max|tiered)$/i, "");
  if (id.startsWith("gemini-3.8-flash")) return "Gemini 3.8 Flash";
  if (id.startsWith("gemini-3.7-flash")) return "Gemini 3.7 Flash";
  if (id.startsWith("gemini-3.6-flash")) return "Gemini 3.6 Flash";
  if (id.startsWith("gemini-3.5-flash")) return "Gemini 3.5 Flash";
  if (id.startsWith("gemini-3.1-flash-lite")) return "Gemini 3.1 Flash-Lite";
  if (id.startsWith("gemini-3.1-pro")) return "Gemini 3.1 Pro";
  if (id.startsWith("gemini-2.5-pro")) return "Gemini 2.5 Pro";
  if (id.startsWith("gemini-2.5-flash")) return "Gemini 2.5 Flash";
  if (id.startsWith("claude-sonnet-4-6")) return "Claude Sonnet 4.6";
  if (id.startsWith("claude-opus-4-6")) return "Claude Opus 4.6";
  if (id.startsWith("gpt-oss-120b")) return "gpt-oss-120b";
  return undefined;
}

/**
 * Read the current official Agent Platform pricing page. Antigravity's
 * subscription quota itself is not a dollar bill; these rates are only used
 * for Pi's equivalent cost estimate. No numeric prices are embedded here.
 */
export async function fetchOfficialModelPricing(signal?: AbortSignal): Promise<Map<string, ModelCost>> {
  const response = await fetch(OFFICIAL_PRICING_URL, {
    signal: signal ?? AbortSignal.timeout(10_000),
    headers: { "User-Agent": "pi-antigravity" },
  });
  if (!response.ok) throw new Error(`Official pricing request failed: HTTP ${response.status}`);

  const rows = pricingRows(await response.text());
  const result = new Map<string, ModelCost>();
  let currentModel: string | undefined;
  const pending = new Map<string, { input?: number[]; output?: number[]; cacheRead?: number; cacheWrite?: number }>();

  for (const row of rows) {
    if (row.cells.length < 2) continue;
    const modelCell = row.cells[0];
    if (modelCell) {
      const marker = pricingModelCell(modelCell);
      // The official page repeats the same model for Standard, Batch, Flex,
      // Priority, and regional tables. Keep the first active Standard entry;
      // later duplicate tables must not overwrite it.
      const existing = pending.get(marker.name);
      const complete = Boolean(existing?.input?.length && existing?.output?.length);
      currentModel = marker.active && !complete ? marker.name : undefined;
    }
    const type = row.cells[1].toLowerCase();
    if (!currentModel) continue;

    const prices = pricesIn(row.cells.slice(2).join(" "));
    if (!prices.length) continue;
    const item = pending.get(currentModel) ?? {};
    let recognized = false;
    if (type === "input" || type.startsWith("input ") && !type.startsWith("input (audio") && !type.startsWith("input audio")) {
      item.input = prices;
      recognized = true;
    } else if (type === "output" || type.startsWith("text output")) {
      item.output = prices;
      recognized = true;
    } else if (type === "cache hit") {
      if (item.cacheRead === undefined) item.cacheRead = prices[0];
      recognized = true;
    } else if (type.includes("cache write")) {
      if (item.cacheWrite === undefined) item.cacheWrite = prices[0];
      recognized = true;
    }
    // Gemini tables put cached-input prices in the Input row's last columns.
    if ((type === "input" || type.startsWith("input ") && !type.startsWith("input (audio") && !type.startsWith("input audio")) && prices.length >= 4) item.cacheRead = prices[2];
    if (recognized) pending.set(currentModel, item);
  }

  for (const [name, value] of pending) {
    if (!value.input?.length || !value.output?.length) continue;
    const cost: ModelCost = {
      input: value.input[0],
      output: value.output[0],
      cacheRead: value.cacheRead ?? 0,
      cacheWrite: value.cacheWrite ?? 0,
    };
    if (value.input.length >= 4 && value.output.length >= 2 && (value.input[0] !== value.input[1] || value.output[0] !== value.output[1])) {
      cost.tiers = [{
        inputTokensAbove: 200_000,
        input: value.input[1],
        output: value.output[1],
        cacheRead: value.input[3],
        cacheWrite: cost.cacheWrite,
      }];
    }
    // The page contains separate global and non-global/partner tables. The
    // first complete entry is the global Agent Platform rate used by this
    // provider; do not let a later regional table overwrite it.
    const key = name.toLowerCase();
    if (!result.has(key)) result.set(key, cost);
  }
  return result;
}

function costForPricingName(modelId: string, pricing: Map<string, ModelCost>): ModelCost {
  const name = canonicalPricingName(modelId);
  return name ? pricing.get(name.toLowerCase()) ?? emptyModelCost() : emptyModelCost();
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

function modelDefinition(id: string, info: RawModelInfo, pricing: Map<string, ModelCost>): DiscoveredModel {
  const name = normalizeModelName(id, info);
  const reasoning = info.supportsThinking === true
    || info.supportsThinking === undefined && /gemini|claude|gpt-oss/i.test(id);

  return {
    id,
    name,
    reasoning,
    input: hasImageInput(info) ? ["text", "image"] : ["text"],
    cost: costForPricingName(id, pricing),
    contextWindow: numberValue(info.contextWindow, 1_048_576),
    maxTokens: numberValue(info.maxOutputTokens ?? info.maxOutputTokenCount ?? info.maxTokens, 65_536),
  };
}

function extractModels(payload: unknown, pricing: Map<string, ModelCost>): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as AvailableModelsResponse).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  return Object.entries(models)
    .filter(([id]) => MODEL_ID.test(id) && !/\s/.test(id))
    .map(([id, info]) => modelDefinition(id, info ?? {}, pricing));
}

export function getCacheFilePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
  return path.join(agentDir, "antigravity-models.json");
}

export function mergeModels(discovered: DiscoveredModel[], pricing?: Map<string, ModelCost>): DiscoveredModel[] {
  const map = new Map<string, DiscoveredModel>();
  for (const m of BASELINE_MODELS) {
    map.set(m.id, m);
  }
  for (const m of discovered) {
    map.set(m.id, m);
  }
  return Array.from(map.values(), (model) => pricing
    ? { ...model, cost: costForPricingName(model.id, pricing) }
    : model);
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
      const pricing = await fetchOfficialModelPricing(signal);
      const models = mergeModels(extractModels(await response.json(), pricing), pricing);
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
