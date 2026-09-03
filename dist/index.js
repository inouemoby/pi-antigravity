// src/index.ts
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
var ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com"
];
var MODEL_ID = /^(gemini-|claude-|gpt-oss-)/i;
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
function modelDefinition(id, info) {
  const name = stringValue(info.displayName) ?? stringValue(info.label) ?? stringValue(info.name) ?? stringValue(info.modelName) ?? id;
  const reasoning = info.supportsThinking === true || info.supportsThinking === void 0 && /gemini|claude|gpt-oss/i.test(id);
  return {
    id,
    name,
    reasoning,
    input: hasImageInput(info) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: numberValue(info.contextWindow, 1048576),
    maxTokens: numberValue(info.maxOutputTokens ?? info.maxOutputTokenCount, 65536)
  };
}
function extractModels(payload) {
  if (!payload || typeof payload !== "object") return [];
  const models = payload.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  return Object.entries(models).filter(([id]) => MODEL_ID.test(id) && !/\s/.test(id)).map(([id, info]) => modelDefinition(id, info ?? {}));
}
function storedModels(context) {
  return (context.stored?.models ?? []).filter((model) => Boolean(model && typeof model.id === "string")).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  }));
}
async function fetchAntigravityModels(context) {
  const credential = context.credential?.type === "oauth" ? context.credential : void 0;
  if (!credential?.access) return storedModels(context);
  if (!context.allowNetwork || context.signal.aborted) return storedModels(context);
  const project = await ensureProjectContext({
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires
  });
  if (!project.effectiveProjectId) return storedModels(context);
  const headers = {
    ...buildAntigravityHarnessBootstrapHeaders(credential.access),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata())
  };
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: project.effectiveProjectId }),
        signal: context.signal
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
  if (lastError && storedModels(context).length > 0) return storedModels(context);
  throw lastError ?? new Error("Antigravity model discovery failed");
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
async function login(callbacks) {
  const auth = await authorizeAntigravity();
  callbacks.onAuth({
    url: auth.url
  });
  callbacks.onProgress?.("Complete Google sign-in in the browser, then paste the callback URL here.");
  const input = await callbacks.onPrompt({
    message: "Paste the Antigravity OAuth callback URL or authorization code:"
  });
  const authState = new URL(auth.url).searchParams.get("state") ?? "";
  let code = input.trim();
  let state = authState;
  try {
    const callbackUrl = new URL(code);
    const callbackCode = callbackUrl.searchParams.get("code");
    if (callbackCode) code = callbackCode;
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState) state = callbackState;
  } catch {
  }
  const result = await exchangeAntigravity(code, state);
  if (result.type !== "success") throw new Error(`Antigravity OAuth exchange failed: ${result.error}`);
  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    email: result.email
  };
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
function piAntigravity(pi) {
  pi.registerProvider(PROVIDER, {
    name: "Google Antigravity (OAuth)",
    baseUrl: BASE_URL,
    api: "google-generative-ai",
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
