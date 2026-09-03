import {
  type AgyRequestScope,
  AgyRequestSessionStore,
  ANTIGRAVITY_ENDPOINT,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  ensureProjectContext,
  fetchWithAgyCliTransport,
  orderAgyRequestPayloadInPlace,
  resolveModelForHeaderStyle,
} from "@cortexkit/antigravity-auth-core";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { buildGeminiRequest } from "./convert.ts";
import { getPackedRefresh } from "./credential-cache.ts";

const sessions = new AgyRequestSessionStore("");

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
};

type Usage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
};

type Candidate = { content?: { parts?: Part[] }; finishReason?: string };

type Chunk = {
  response?: { candidates?: Candidate[]; usageMetadata?: Usage };
  candidates?: Candidate[];
  usageMetadata?: Usage;
  error?: unknown;
};

function unwrap(value: unknown): Chunk {
  if (value && typeof value === "object" && "response" in value) {
    const response = (value as { response?: unknown }).response;
    if (response && typeof response === "object") return response as Chunk;
  }
  return value as Chunk;
}

async function* parseSse(response: Response): AsyncGenerator<Chunk> {
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
          try { yield unwrap(JSON.parse(text)); } catch { /* ignore malformed frames */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const text = line.slice(5).trim();
        if (!text || text === "[DONE]") continue;
        try { yield unwrap(JSON.parse(text)); } catch { /* ignore malformed frames */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function outputFor(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function updateUsage(model: Model<any>, output: AssistantMessage, usage?: Usage): void {
  if (!usage) return;
  const prompt = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  output.usage.input = Math.max(0, prompt - cached);
  output.usage.cacheRead = cached;
  output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  output.usage.totalTokens = output.usage.input + output.usage.cacheRead + output.usage.output + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function modelForRequest(model: Model<any>, reasoning: SimpleStreamOptions["reasoning"]): string {
  const id = model.id.toLowerCase();
  if (!reasoning) return resolveModelForHeaderStyle(model.id, "antigravity").actualModel;
  const tier = reasoning === "minimal" ? "low" : reasoning === "xhigh" ? "high" : reasoning;
  const base = model.id.replace(/-(minimal|low|medium|high|xhigh)$/i, "");
  if (id.includes("gemini-3") || id.includes("claude")) {
    return resolveModelForHeaderStyle(`${base}-${tier}`, "antigravity").actualModel;
  }
  return resolveModelForHeaderStyle(model.id, "antigravity").actualModel;
}

function thinkingConfig(model: Model<any>, options: SimpleStreamOptions): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  if (!options.reasoning) return { thinkingBudget: 0 };
  const tier = options.reasoning === "minimal" ? "low" : options.reasoning === "xhigh" ? "high" : options.reasoning;
  if (model.id.toLowerCase().includes("gemini-3")) {
    return { includeThoughts: true, thinkingLevel: tier.toUpperCase() };
  }
  const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576 };
  return { includeThoughts: true, thinkingBudget: budgets[options.reasoning] ?? 8192 };
}

function requestSessionKey(context: Context, options?: SimpleStreamOptions): string {
  if (options?.sessionId) return options.sessionId;
  const timestamp = context.messages[0]?.timestamp;
  return timestamp === undefined ? "__default__" : `message:${timestamp}`;
}

function embeddedError(chunk: Chunk): string | undefined {
  if (chunk.error === undefined) return undefined;
  if (typeof chunk.error === "string") return chunk.error;
  if (chunk.error && typeof chunk.error === "object" && "message" in chunk.error) {
    return String((chunk.error as { message?: unknown }).message ?? "Antigravity request failed");
  }
  return "Antigravity request failed";
}

function finishReason(value: string | undefined): StopReason {
  if (value === "MAX_TOKENS") return "length";
  return "stop";
}

export function streamAntigravity(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = outputFor(model);
    let response: Response | undefined;
    try {
      const accessToken = options?.apiKey ?? "";
      if (!accessToken) throw new Error("Antigravity requires OAuth authentication. Use /login.");
      const packedRefresh = getPackedRefresh(accessToken) ?? accessToken;
      const project = await ensureProjectContext({
        type: "oauth",
        refresh: packedRefresh,
        access: accessToken,
        expires: Date.now() + 60_000,
      });
      if (!project.effectiveProjectId) throw new Error("Antigravity did not provide a project context.");

      const request = buildGeminiRequest(context, { provider: model.provider, model: model.id }) as unknown as Record<string, unknown>;
      const generationConfig: Record<string, unknown> = {};
      if (options?.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
      const thinking = thinkingConfig(model, options ?? {} as SimpleStreamOptions);
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
        requestType: "agent",
      };
      response = await fetchWithAgyCliTransport(
        `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": buildAntigravityHarnessUserAgent(),
          },
          body: JSON.stringify(envelope),
        },
        { signal: options?.signal ?? null },
      );
      if (!response.ok) throw new Error(`Antigravity request failed: HTTP ${response.status} ${await response.text()}`);

      stream.push({ type: "start", partial: output });
      let textIndex = -1;
      let thinkingIndex = -1;
      let terminal = false;
      let sawContent = false;
      const toolSignatures = new Map<string, string>();
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
            closeText(); closeThinking();
            const id = part.functionCall.id ?? `${part.functionCall.name ?? "tool"}-${Date.now()}`;
            const signature = part.thoughtSignature ?? toolSignatures.get(id);
            const toolCall: ToolCall = {
              type: "toolCall", id, name: part.functionCall.name ?? "", arguments: part.functionCall.args ?? {},
              ...(signature ? { thoughtSignature: signature } : {}),
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
            const block = output.content[thinkingIndex] as ThinkingContent;
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
            const block = output.content[textIndex] as TextContent;
            block.text += part.text;
            if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
            stream.push({ type: "text_delta", contentIndex: textIndex, delta: part.text, partial: output });
            sawContent = true;
          } else if (part.thoughtSignature) {
            toolSignatures.set("pending", part.thoughtSignature);
          }
        }
        if (candidate?.finishReason) {
          closeText(); closeThinking();
          if (output.stopReason !== "toolUse") output.stopReason = finishReason(candidate.finishReason);
          terminal = true;
          break;
        }
      }
      if (!terminal) throw new Error("Antigravity stream ended without a terminal response");
      if (!sawContent) throw new Error("Antigravity returned an empty response");
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      sessions.completeExecution(requestSessionKey(context, options));
      stream.end();
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}
