import { uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "google-antigravity";
const MODEL_ID = "gemini-3.8-flash";
const COMPACTION_TIMEOUT_MS = 90_000;

class CompactionTimeoutError extends Error {
	constructor() {
		super(`Antigravity compaction exceeded ${COMPACTION_TIMEOUT_MS / 1000} seconds.`);
		this.name = "CompactionTimeoutError";
	}
}

let inFlightCompaction: Promise<unknown> | undefined;

/**
 * Antigravity's project bootstrap currently has no AbortSignal parameter.
 * Race the complete operation against both Pi cancellation and a hard deadline
 * so an unresponsive bootstrap or SSE stream never blocks Pi compaction.
 */
async function completeWithDeadline<T>(
	parentSignal: AbortSignal,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (inFlightCompaction) throw new Error("An earlier Antigravity compaction request is still pending.");
	const controller = new AbortController();
	const signal = typeof AbortSignal.any === "function"
		? AbortSignal.any([parentSignal, controller.signal])
		: parentSignal;
	const request = operation(signal);
	inFlightCompaction = request;
	void request.finally(() => {
		if (inFlightCompaction === request) inFlightCompaction = undefined;
	}).catch(() => {});

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let removeAbort: (() => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			const error = new CompactionTimeoutError();
			controller.abort(error);
			reject(error);
		}, COMPACTION_TIMEOUT_MS);
	});
	const cancelled = new Promise<never>((_resolve, reject) => {
		const abort = () => reject(parentSignal.reason ?? new Error("Compaction cancelled."));
		if (parentSignal.aborted) abort();
		else {
			parentSignal.addEventListener("abort", abort, { once: true });
			removeAbort = () => parentSignal.removeEventListener("abort", abort);
		}
	});
	try {
		return await Promise.race([request, timeout, cancelled]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		removeAbort?.();
	}
}

function textFromResponse(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.written, ...fileOps.edited]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function compactionPrompt(input: {
  conversation: string;
  previousSummary?: string;
  customInstructions?: string;
  readFiles: string[];
  modifiedFiles: string[];
}): string {
  const previous = input.previousSummary
    ? `\n\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
    : "";
  const custom = input.customInstructions?.trim()
    ? `\n\n<user-focus>\n${input.customInstructions.trim()}\n</user-focus>`
    : "";
  return `You are Pi's context-compaction summarizer. Produce only a durable, structured Markdown summary of the serialized conversation below. It replaces older conversation context, so preserve all information needed to continue unfinished work accurately. Do not answer the user, do not make new plans beyond recording existing next steps, and do not omit concrete file paths, errors, API decisions, model choices, or user constraints.

Use exactly these sections when applicable:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

End with <read-files> and <modified-files> blocks when those file sets are known. Keep stable facts from the previous summary unless they were superseded. Be concise enough for future context, but do not reduce the summary to vague prose.

<known-file-operations>
readFiles: ${JSON.stringify(input.readFiles)}
modifiedFiles: ${JSON.stringify(input.modifiedFiles)}
</known-file-operations>${previous}${custom}

<conversation>
${input.conversation}
</conversation>`;
}

/**
 * When Antigravity OAuth resolves normally, compaction uses Gemini 3.8 Flash.
 * Returning undefined on any auth/model/request failure deliberately preserves
 * Pi's native compaction model and retry behavior.
 */
export function registerAntigravityCompaction(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

    try {
      const { preparation } = event;
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      if (messages.length === 0 && !preparation.previousSummary) return;

      const files = fileLists(preparation.fileOps);
      if (ctx.hasUI) ctx.ui.notify("Compacting with Google Antigravity Gemini 3.8 Flash...", "info");
      const response = await completeWithDeadline(event.signal, async (signal) => {
        const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!resolved.ok || !resolved.apiKey) return undefined;
        return await ctx.modelRegistry.complete(
          model,
          {
            messages: [{
              role: "user",
              content: [{
                type: "text",
                text: compactionPrompt({
                  conversation: serializeConversation(convertToLlm(messages)),
                  previousSummary: preparation.previousSummary,
                  customInstructions: event.customInstructions,
                  readFiles: files.readFiles,
                  modifiedFiles: files.modifiedFiles,
                }),
              }],
              timestamp: Date.now(),
            }],
          },
          {
            maxTokens: 8192,
            reasoning: "off",
            signal,
            cacheRetention: "none",
            sessionId: uuidv7(),
          },
        );
      });

      if (!response) return;
      const summary = textFromResponse(response);
      if (event.signal.aborted || response.stopReason !== "stop" || !summary) return;
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details: {
            readFiles: files.readFiles,
            modifiedFiles: files.modifiedFiles,
            provider: PROVIDER,
            model: MODEL_ID,
          },
        },
      };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Antigravity compaction unavailable; using Pi default compaction: ${message}`, "warning");
      }
      return;
    }
  });
}
