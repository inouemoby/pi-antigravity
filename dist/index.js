// src/index.ts
import { createServer } from "node:http";
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAntigravityToken
} from "@cortexkit/antigravity-auth-core";

// src/credential-cache.ts
var packedRefreshByAccessToken = /* @__PURE__ */ new Map();
var MAX_ENTRIES = 4;
function rememberPackedRefresh(access, refresh2) {
  if (!access) return;
  if (packedRefreshByAccessToken.has(access)) packedRefreshByAccessToken.delete(access);
  while (packedRefreshByAccessToken.size >= MAX_ENTRIES) {
    const oldest = packedRefreshByAccessToken.keys().next().value;
    if (oldest === void 0) break;
    packedRefreshByAccessToken.delete(oldest);
  }
  packedRefreshByAccessToken.set(access, refresh2);
}
function getPackedRefresh(access) {
  return packedRefreshByAccessToken.get(access);
}

// src/model-discovery.ts
import {
  buildAntigravityHarnessBootstrapHeaders,
  buildAntigravityLoadCodeAssistMetadata,
  ensureProjectContext
} from "@cortexkit/antigravity-auth-core";
import * as fs from "node:fs";
import * as path from "node:path";
var ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com"
];
var MODEL_ID = /^(gemini-|claude-|gpt-oss-)/i;
var GEMINI_FLASH_INTRO_END = Date.UTC(2027, 0, 1);
function geminiFlashCost(output) {
  const introductory = Date.now() < GEMINI_FLASH_INTRO_END;
  return {
    input: introductory ? 0.75 : 1.5,
    output: introductory ? output : output * 2,
    cacheRead: introductory ? 0.075 : 0.15,
    // Google lists cached-input token rates, but no separate cache-write
    // token rate for these Gemini models. Explicit cache storage is billed
    // hourly and is not represented by Pi's per-token cacheWrite field.
    cacheWrite: 0
  };
}
function officialCostForModel(modelId) {
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
      tiers: [{ inputTokensAbove: 2e5, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }]
    };
  }
  if (/^gemini-2\.5-pro/.test(id)) {
    return {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 2e5, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }]
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
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
var BASELINE_MODELS = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  {
    id: "claude-sonnet-4-6-thinking",
    name: "Claude Sonnet 4.6 Thinking",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 25e4,
    maxTokens: 64e3
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 25e4,
    maxTokens: 64e3
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768
  }
];
for (const model of BASELINE_MODELS) {
  model.cost = officialCostForModel(model.id);
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function numberValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function hasImageInput(info) {
  if (info.supportsImages === true) return true;
  if (Array.isArray(info.inputModalities)) {
    return info.inputModalities.some((value) => String(value).toLowerCase().includes("image"));
  }
  return false;
}
function normalizeModelName(id, info) {
  const custom = stringValue(info.displayName) ?? stringValue(info.label) ?? stringValue(info.name) ?? stringValue(info.modelName);
  if (custom) return custom;
  return id.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function modelDefinition(id, info) {
  const name = normalizeModelName(id, info);
  const reasoning = info.supportsThinking === true || info.supportsThinking === void 0 && /gemini|claude|gpt-oss/i.test(id);
  return {
    id,
    name,
    reasoning,
    input: hasImageInput(info) ? ["text", "image"] : ["text"],
    cost: officialCostForModel(id),
    contextWindow: numberValue(info.contextWindow, 1048576),
    maxTokens: numberValue(info.maxOutputTokens ?? info.maxOutputTokenCount ?? info.maxTokens, 65536)
  };
}
function extractModels(payload) {
  if (!payload || typeof payload !== "object") return [];
  const models = payload.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  return Object.entries(models).filter(([id]) => MODEL_ID.test(id) && !/\s/.test(id)).map(([id, info]) => modelDefinition(id, info ?? {}));
}
function getCacheFilePath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
  return path.join(agentDir, "antigravity-models.json");
}
function mergeModels(discovered) {
  const map = /* @__PURE__ */ new Map();
  for (const m of BASELINE_MODELS) {
    map.set(m.id, m);
  }
  for (const m of discovered) {
    map.set(m.id, m);
  }
  return Array.from(map.values(), (model) => ({
    ...model,
    cost: officialCostForModel(model.id)
  }));
}
function loadCachedModels() {
  try {
    const cacheFile = getCacheFilePath();
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        return mergeModels(data);
      }
    }
  } catch {
  }
  return BASELINE_MODELS;
}
function saveCachedModels(models) {
  try {
    const cacheFile = getCacheFilePath();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(models, null, 2), "utf-8");
  } catch {
  }
}
async function queryAntigravityModels(accessToken, refreshToken, signal) {
  const project = await ensureProjectContext({
    type: "oauth",
    refresh: refreshToken,
    access: accessToken,
    expires: Date.now() + 6e4
  });
  if (!project.effectiveProjectId) return [];
  const headers = {
    ...buildAntigravityHarnessBootstrapHeaders(accessToken),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata())
  };
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: project.effectiveProjectId }),
        signal
      });
      if (!response.ok) continue;
      const models = extractModels(await response.json());
      if (models.length > 0) return models;
    } catch {
    }
  }
  return [];
}
async function fetchAntigravityModels(context) {
  const credential = context.credential?.type === "oauth" ? context.credential : void 0;
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
  }
  return loadCachedModels();
}

// src/stream.ts
import {
  AgyRequestSessionStore,
  ANTIGRAVITY_ENDPOINT,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  ensureProjectContext as ensureProjectContext2,
  fetchWithAgyCliTransport,
  orderAgyRequestPayloadInPlace,
  resolveModelForHeaderStyle
} from "@cortexkit/antigravity-auth-core";
import {
  createAssistantMessageEventStream,
  calculateCost
} from "@earendil-works/pi-ai";

// src/convert.ts
import { toGeminiSchema } from "@cortexkit/antigravity-auth-core";
function sanitize(value) {
  return value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}
function userParts(content) {
  const parts = [];
  for (const item of content) {
    if (item.type === "text" && item.text) parts.push({ text: sanitize(item.text) });
    if (item.type === "image" && item.data) {
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
    }
  }
  return parts;
}
function sameModel(message, provider, model) {
  if (!provider || !model) return true;
  return message.provider === provider && message.model === model;
}
function assistantParts(message, preserveSignatures) {
  const parts = [];
  for (const block of message.content) {
    if (block.type === "thinking" && preserveSignatures && block.thinking) {
      parts.push({
        text: sanitize(block.thinking),
        thought: true,
        ...block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}
      });
    } else if (block.type === "text" && block.text.trim()) {
      parts.push({
        text: sanitize(block.text),
        ...preserveSignatures && block.textSignature ? { thoughtSignature: block.textSignature } : {}
      });
    } else if (block.type === "toolCall") {
      parts.push({
        functionCall: { name: block.name, args: block.arguments ?? {}, id: block.id },
        ...preserveSignatures && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}
      });
    }
  }
  return parts;
}
function toolResponse(message) {
  const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return message.isError ? { error: text || "Error" } : { output: text };
}
function buildGeminiRequest(context, target) {
  const contents = [];
  const callTargets = /* @__PURE__ */ new Map();
  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    const matches = sameModel(message, target?.provider, target?.model);
    for (const block of message.content) {
      if (block.type === "toolCall") callTargets.set(block.id, matches);
    }
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      const parts = typeof message.content === "string" ? message.content.trim() ? [{ text: sanitize(message.content) }] : [] : userParts(message.content);
      if (parts.length) contents.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      const parts = assistantParts(message, sameModel(message, target?.provider, target?.model));
      if (parts.length) contents.push({ role: "model", parts });
    } else if (message.role === "toolResult") {
      const role = callTargets.get(message.toolCallId) === true ? "model" : "user";
      const part = {
        functionResponse: { name: message.toolName, response: toolResponse(message), id: message.toolCallId }
      };
      const previous = contents.at(-1);
      if (previous?.role === role && previous.parts.every((item) => "functionResponse" in item)) {
        previous.parts.push(part);
      } else {
        contents.push({ role, parts: [part] });
      }
    }
  }
  const request = { contents };
  if (context.systemPrompt?.trim()) request.systemInstruction = { parts: [{ text: sanitize(context.systemPrompt) }] };
  if (context.tools?.length) {
    request.tools = [{
      functionDeclarations: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters)
      }))
    }];
  }
  return request;
}

// src/stream.ts
var sessions = new AgyRequestSessionStore("");
function unwrap(value) {
  if (value && typeof value === "object" && "response" in value) {
    const response = value.response;
    if (response && typeof response === "object") return response;
  }
  return value;
}
async function* parseSse(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const text = line.slice(5).trim();
          if (!text || text === "[DONE]") continue;
          try {
            yield unwrap(JSON.parse(text));
          } catch {
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const text = line.slice(5).trim();
        if (!text || text === "[DONE]") continue;
        try {
          yield unwrap(JSON.parse(text));
        } catch {
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function outputFor(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "pending",
    timestamp: Date.now()
  };
}
function updateUsage(model, output, usage) {
  if (!usage) return;
  const prompt = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  output.usage.input = Math.max(0, prompt - cached);
  output.usage.cacheRead = cached;
  output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  output.usage.totalTokens = output.usage.input + output.usage.cacheRead + output.usage.output + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}
function modelForRequest(model, reasoning) {
  const id = model.id.toLowerCase();
  if (!reasoning) return resolveModelForHeaderStyle(model.id, "antigravity").actualModel;
  const tier = reasoning === "minimal" ? "low" : reasoning === "xhigh" ? "high" : reasoning;
  const base = model.id.replace(/-(minimal|low|medium|high|xhigh)$/i, "");
  if (id.includes("gemini-3") || id.includes("claude")) {
    return resolveModelForHeaderStyle(`${base}-${tier}`, "antigravity").actualModel;
  }
  return resolveModelForHeaderStyle(model.id, "antigravity").actualModel;
}
function thinkingConfig(model, options) {
  if (!model.reasoning) return void 0;
  if (!options.reasoning) return { thinkingBudget: 0 };
  const tier = options.reasoning === "minimal" ? "low" : options.reasoning === "xhigh" ? "high" : options.reasoning;
  if (model.id.toLowerCase().includes("gemini-3")) {
    return { includeThoughts: true, thinkingLevel: tier.toUpperCase() };
  }
  const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576 };
  return { includeThoughts: true, thinkingBudget: budgets[options.reasoning] ?? 8192 };
}
function requestSessionKey(context, options) {
  if (options?.sessionId) return options.sessionId;
  const timestamp = context.messages[0]?.timestamp;
  return timestamp === void 0 ? "__default__" : `message:${timestamp}`;
}
function embeddedError(chunk) {
  if (chunk.error === void 0) return void 0;
  if (typeof chunk.error === "string") return chunk.error;
  if (chunk.error && typeof chunk.error === "object" && "message" in chunk.error) {
    return String(chunk.error.message ?? "Antigravity request failed");
  }
  return "Antigravity request failed";
}
function finishReason(value) {
  if (value === "MAX_TOKENS") return "length";
  return "stop";
}
function streamAntigravity(model, context, options) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = outputFor(model);
    let response;
    try {
      const accessToken = options?.apiKey ?? "";
      if (!accessToken) throw new Error("Antigravity requires OAuth authentication. Use /login.");
      const packedRefresh = getPackedRefresh(accessToken) ?? accessToken;
      const project = await ensureProjectContext2({
        type: "oauth",
        refresh: packedRefresh,
        access: accessToken,
        expires: Date.now() + 6e4
      });
      if (!project.effectiveProjectId) throw new Error("Antigravity did not provide a project context.");
      const request = buildGeminiRequest(context, { provider: model.provider, model: model.id });
      const generationConfig = {};
      if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
      const thinking = thinkingConfig(model, options ?? {});
      if (thinking) generationConfig.thinkingConfig = thinking;
      if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
      const scope = sessions.beginRequest(requestSessionKey(context, options));
      const wireModel = modelForRequest(model, options?.reasoning);
      const metadata = buildAgyAgentRequestMetadata(scope.session, request, wireModel, Date.now(), { stepCountMode: "cli" });
      request.labels = metadata.labels;
      request.sessionId = metadata.sessionId;
      orderAgyRequestPayloadInPlace(request);
      const envelope = {
        project: project.effectiveProjectId,
        requestId: metadata.requestId,
        request,
        model: wireModel,
        userAgent: "antigravity",
        requestType: "agent"
      };
      response = await fetchWithAgyCliTransport(
        `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": buildAntigravityHarnessUserAgent()
          },
          body: JSON.stringify(envelope)
        },
        { signal: options?.signal ?? null }
      );
      if (!response.ok) throw new Error(`Antigravity request failed: HTTP ${response.status} ${await response.text()}`);
      stream.push({ type: "start", partial: output });
      let textIndex = -1;
      let thinkingIndex = -1;
      let terminal = false;
      let sawContent = false;
      const toolSignatures = /* @__PURE__ */ new Map();
      const closeText = () => {
        if (textIndex < 0) return;
        const block = output.content[textIndex];
        if (block?.type === "text") stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
        textIndex = -1;
      };
      const closeThinking = () => {
        if (thinkingIndex < 0) return;
        const block = output.content[thinkingIndex];
        if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: output });
        thinkingIndex = -1;
      };
      for await (const chunk of parseSse(response)) {
        const failure = embeddedError(chunk);
        if (failure) throw new Error(failure);
        const inner = chunk.response ?? chunk;
        updateUsage(model, output, inner.usageMetadata);
        const candidate = inner.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
            closeText();
            closeThinking();
            const id = part.functionCall.id ?? `${part.functionCall.name ?? "tool"}-${Date.now()}`;
            const signature = part.thoughtSignature ?? toolSignatures.get(id);
            const toolCall = {
              type: "toolCall",
              id,
              name: part.functionCall.name ?? "",
              arguments: part.functionCall.args ?? {},
              ...signature ? { thoughtSignature: signature } : {}
            };
            output.content.push(toolCall);
            const index = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: output });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
            output.stopReason = "toolUse";
            sawContent = true;
            continue;
          }
          if (part.thought && part.text) {
            closeText();
            if (thinkingIndex < 0) {
              output.content.push({ type: "thinking", thinking: "" });
              thinkingIndex = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
            }
            const block = output.content[thinkingIndex];
            block.thinking += part.text;
            if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature;
            stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: part.text, partial: output });
            sawContent = true;
          } else if (part.text) {
            closeThinking();
            if (textIndex < 0) {
              output.content.push({ type: "text", text: "" });
              textIndex = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
            }
            const block = output.content[textIndex];
            block.text += part.text;
            if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
            stream.push({ type: "text_delta", contentIndex: textIndex, delta: part.text, partial: output });
            sawContent = true;
          } else if (part.thoughtSignature) {
            toolSignatures.set("pending", part.thoughtSignature);
          }
        }
        if (candidate?.finishReason) {
          closeText();
          closeThinking();
          if (output.stopReason !== "toolUse") output.stopReason = finishReason(candidate.finishReason);
          terminal = true;
          break;
        }
      }
      if (!terminal) throw new Error("Antigravity stream ended without a terminal response");
      if (!sawContent) throw new Error("Antigravity returned an empty response");
      stream.push({ type: "done", reason: output.stopReason, message: output });
      sessions.completeExecution(requestSessionKey(context, options));
      stream.end();
    } catch (error) {
      await response?.body?.cancel().catch(() => {
      });
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

// src/index.ts
var PROVIDER = "google-antigravity";
var BASE_URL = "https://cloudcode-pa.googleapis.com";
function renderCallbackHtml(heading, message, isError = false) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${heading}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${isError ? "#180808" : "#090d16"};
      color: #f0f6fc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .card {
      background: ${isError ? "#281212" : "#111827"};
      border: 1px solid ${isError ? "#6b2121" : "#1f293d"};
      border-radius: 12px;
      padding: 32px 40px;
      max-width: 440px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 20px;
      color: ${isError ? "#ff7b72" : "#58a6ff"};
    }
    p {
      margin: 0;
      color: #9ca3af;
      font-size: 14px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
function startCallbackServer(signal) {
  return new Promise((resolve, reject) => {
    let settleResolve;
    let settleReject;
    const codePromise = new Promise((res, rej) => {
      settleResolve = res;
      settleReject = rej;
    });
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://127.0.0.1:51121");
        if (url.pathname === "/oauth-callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDesc = url.searchParams.get("error_description");
          if (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderCallbackHtml("Authentication Failed", errorDesc || error, true));
            settleReject?.(new Error(`Google authentication failed: ${errorDesc || error}`));
            return;
          }
          if (code && state) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderCallbackHtml("Authentication Successful", "Sign-in completed! You can close this browser tab and return to Pi."));
            settleResolve?.({ code, state });
          } else {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderCallbackHtml("Invalid Request", "The OAuth callback is missing authorization parameters.", true));
          }
        } else {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml("Not Found", "OAuth route not found.", true));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml("Server Error", String(err), true));
      }
    });
    const host = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
    server.on("error", (err) => {
      reject(err);
    });
    server.listen(51121, host, () => {
      resolve({
        server,
        waitForCode: () => codePromise,
        close: () => {
          server.close();
        }
      });
    });
    signal?.addEventListener(
      "abort",
      () => {
        server.close();
        settleReject?.(new Error("Login cancelled"));
      },
      { once: true }
    );
  });
}
function parseCodeInput(input, fallbackState) {
  let code = input.trim();
  let state = fallbackState;
  try {
    const callbackUrl = new URL(code);
    const callbackCode = callbackUrl.searchParams.get("code");
    if (callbackCode) code = callbackCode;
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState) state = callbackState;
  } catch {
  }
  return { code, state };
}
async function login(callbacks) {
  const auth = await authorizeAntigravity();
  const authState = new URL(auth.url).searchParams.get("state") ?? "";
  let serverResult;
  try {
    serverResult = await startCallbackServer(callbacks.signal);
  } catch (err) {
    callbacks.onProgress?.(
      `Could not bind callback server on port 51121 (${err instanceof Error ? err.message : String(err)}). You can paste the redirect URL manually.`
    );
  }
  callbacks.onAuth({
    url: auth.url,
    instructions: "Complete sign-in in your browser."
  });
  const promises = [];
  if (serverResult) {
    promises.push(serverResult.waitForCode());
  }
  if (callbacks.onManualCodeInput) {
    promises.push(
      callbacks.onManualCodeInput().then((input) => parseCodeInput(input, authState))
    );
  } else if (!serverResult) {
    promises.push(
      callbacks.onPrompt({
        message: "Paste the Antigravity OAuth callback URL or authorization code:"
      }).then((input) => parseCodeInput(input, authState))
    );
  }
  try {
    const { code, state } = await Promise.race(promises);
    callbacks.onProgress?.("Exchanging authorization code for tokens...");
    const result = await exchangeAntigravity(code, state);
    if (result.type !== "success") {
      throw new Error(`Antigravity OAuth exchange failed: ${result.error}`);
    }
    try {
      const discovered = await queryAntigravityModels(result.access, result.refresh);
      if (discovered.length > 0) saveCachedModels(discovered);
    } catch {
    }
    return {
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      email: result.email
    };
  } finally {
    serverResult?.close();
  }
}
async function refresh(credentials) {
  const refreshToken = credentials.refresh.split("|", 1)[0] ?? credentials.refresh;
  const next = await refreshAntigravityToken(refreshToken);
  const suffix = credentials.refresh.includes("|") ? credentials.refresh.slice(credentials.refresh.indexOf("|")) : "";
  return {
    refresh: `${next.refresh}${suffix}`,
    access: next.access,
    expires: next.expires,
    email: credentials.email
  };
}
function readStoredCredential() {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path2.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
    const authPath = path2.join(agentDir, "auth.json");
    if (fs2.existsSync(authPath)) {
      const auth = JSON.parse(fs2.readFileSync(authPath, "utf-8"));
      const cred = auth[PROVIDER];
      if (cred?.type === "oauth" && cred.access && cred.refresh) {
        return { access: cred.access, refresh: cred.refresh };
      }
    }
  } catch {
  }
  return void 0;
}
async function piAntigravity(pi) {
  let models = loadCachedModels();
  const stored = readStoredCredential();
  if (stored) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3e3);
      const liveModels = await queryAntigravityModels(stored.access, stored.refresh, controller.signal);
      clearTimeout(timeout);
      if (liveModels.length > 0) {
        models = loadCachedModels();
      }
    } catch {
    }
  }
  pi.registerProvider(PROVIDER, {
    name: "Google Antigravity (OAuth)",
    baseUrl: BASE_URL,
    api: "google-generative-ai",
    models,
    refreshModels: fetchAntigravityModels,
    oauth: {
      name: "Google Antigravity",
      isSubscription: true,
      login,
      refreshToken: refresh,
      getApiKey(credentials) {
        rememberPackedRefresh(credentials.access, credentials.refresh);
        return credentials.access;
      }
    },
    streamSimple: streamAntigravity
  });
}
export {
  piAntigravity as default
};
//# sourceMappingURL=index.js.map
