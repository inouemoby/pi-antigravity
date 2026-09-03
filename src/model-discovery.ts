import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityLoadCodeAssistMetadata,
  ensureProjectContext,
} from "@cortexkit/antigravity-auth-core";
import type { OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";

const ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];
const MODEL_ID = /^(gemini-|claude-|gpt-oss-)/i;

type RawModelInfo = {
  displayName?: unknown;
  label?: unknown;
  name?: unknown;
  modelName?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  inputModalities?: unknown;
  contextWindow?: unknown;
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

function modelDefinition(id: string, info: RawModelInfo) {
  // Keep the exact runtime id returned by Antigravity. Do not add an
  // antigravity- prefix or replace it with a display alias.
  const name = stringValue(info.displayName)
    ?? stringValue(info.label)
    ?? stringValue(info.name)
    ?? stringValue(info.modelName)
    ?? id;
  const reasoning = info.supportsThinking === true
    || info.supportsThinking === undefined && /gemini|claude|gpt-oss/i.test(id);

  return {
    id,
    name,
    reasoning,
    input: hasImageInput(info) ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: numberValue(info.contextWindow, 1_048_576),
    maxTokens: numberValue(info.maxOutputTokens ?? info.maxOutputTokenCount, 65_536),
  };
}

function extractModels(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as AvailableModelsResponse).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  return Object.entries(models)
    .filter(([id]) => MODEL_ID.test(id) && !/\s/.test(id))
    .map(([id, info]) => modelDefinition(id, info ?? {}));
}

function storedModels(context: Pick<RefreshModelsContext, "stored">) {
  return (context.stored?.models ?? [])
    .filter((model) => Boolean(model && typeof model.id === "string"))
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
}

export async function fetchAntigravityModels(context: RefreshModelsContext) {
  const credential = context.credential?.type === "oauth" ? context.credential as OAuthCredentials : undefined;
  if (!credential?.access) return storedModels(context);
  if (!context.allowNetwork || context.signal.aborted) return storedModels(context);

  const project = await ensureProjectContext({
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  });
  if (!project.effectiveProjectId) return storedModels(context);

  const headers = {
    ...buildAntigravityHarnessBootstrapHeaders(credential.access),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata()),
  };
  let lastError: Error | undefined;

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: project.effectiveProjectId }),
        signal: context.signal,
      });
      if (!response.ok) {
        lastError = new Error(`Model discovery failed: HTTP ${response.status}`);
        continue;
      }
      const models = extractModels(await response.json());
      if (models.length > 0) return models;
      lastError = new Error("Antigravity returned no usable models");
    } catch (error) {
      if (context.signal.aborted) return storedModels(context);
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Keep the last good catalog on transient endpoint failures. The caller will
  // surface a refresh error while Pi can continue using the cached models.
  if (lastError && storedModels(context).length > 0) return storedModels(context);
  throw lastError ?? new Error("Antigravity model discovery failed");
}
