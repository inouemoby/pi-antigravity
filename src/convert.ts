import { toGeminiSchema } from "@cortexkit/antigravity-auth-core";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown>; id: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id: string } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiTool = { functionDeclarations: Array<{ name: string; description: string; parameters?: unknown }> };

export interface GeminiRequest {
  contents: GeminiContent[];
  tools?: GeminiTool[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: Record<string, unknown>;
}

function sanitize(value: string): string {
  return value.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function userParts(content: Array<TextContent | ImageContent>): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const item of content) {
    if (item.type === "text" && item.text) parts.push({ text: sanitize(item.text) });
    if (item.type === "image" && item.data) {
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
    }
  }
  return parts;
}

function sameModel(message: AssistantMessage, provider?: string, model?: string): boolean {
  if (!provider || !model) return true;
  return message.provider === provider && message.model === model;
}

function assistantParts(message: AssistantMessage, preserveSignatures: boolean): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const block of message.content) {
    if (block.type === "thinking" && preserveSignatures && block.thinking) {
      parts.push({
        text: sanitize(block.thinking),
        thought: true,
        ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {})
      });
    } else if (block.type === "text" && block.text.trim()) {
      parts.push({
        text: sanitize(block.text),
        ...(preserveSignatures && block.textSignature ? { thoughtSignature: block.textSignature } : {})
      });
    } else if (block.type === "toolCall") {
      parts.push({
        functionCall: { name: block.name, args: block.arguments ?? {}, id: block.id },
        ...(preserveSignatures && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
      });
    }
  }
  return parts;
}

function toolResponse(message: ToolResultMessage): Record<string, unknown> {
  const text = message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return message.isError ? { error: text || "Error" } : { output: text };
}

export function buildGeminiRequest(
  context: Context,
  target?: { provider?: string; model?: string }
): GeminiRequest {
  const contents: GeminiContent[] = [];
  const callTargets = new Map<string, boolean>();

  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    const matches = sameModel(message, target?.provider, target?.model);
    for (const block of message.content) {
      if (block.type === "toolCall") callTargets.set(block.id, matches);
    }
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      const parts = typeof message.content === "string"
        ? (message.content.trim() ? [{ text: sanitize(message.content) }] : [])
        : userParts(message.content);
      if (parts.length) contents.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      const parts = assistantParts(message, sameModel(message, target?.provider, target?.model));
      if (parts.length) contents.push({ role: "model", parts });
    } else if (message.role === "toolResult") {
      const role = callTargets.get(message.toolCallId) === true ? "model" : "user";
      const part: GeminiPart = {
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

  const request: GeminiRequest = { contents };
  if (context.systemPrompt?.trim()) request.systemInstruction = { parts: [{ text: sanitize(context.systemPrompt) }] };
  if (context.tools?.length) {
    request.tools = [{
      functionDeclarations: context.tools.map((tool: Tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters)
      }))
    }];
  }
  return request;
}
