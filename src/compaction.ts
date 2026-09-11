import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const PROVIDER = "google-antigravity";
const MODEL_ID = "gemini-3.8-flash";
const PATCHED = Symbol.for("pi-antigravity.native-compaction-model-patched");

type SummarizationAuth = {
  model: Model<any>;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

type NativeCompactionSession = {
  modelRuntime: {
    getAvailableSnapshot(): readonly Model<any>[];
  };
  _getSummarizationRequestAuth(model: Model<any>): Promise<SummarizationAuth>;
};

type NativeCompactionMethod = (this: NativeCompactionSession, ...args: unknown[]) => Promise<unknown>;

/**
 * Pi 0.85 does not expose a separate compaction-model setting.  Patch only its
 * native compaction call boundary: everything after this method (preparation,
 * prompts, split-turn handling, retries, persistence, and Esc cancellation)
 * remains Pi's own implementation.
 */
export function installAntigravityCompactionModelOverride(): void {
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  if (prototype[PATCHED]) return;

  const original = prototype._runDefaultCompaction;
  if (typeof original !== "function") {
    throw new Error("This Pi version does not expose the native compaction entry point.");
  }

  prototype._runDefaultCompaction = async function (
    this: NativeCompactionSession,
    ...args: unknown[]
  ): Promise<unknown> {
    const model = this.modelRuntime
      .getAvailableSnapshot()
      .find((candidate) => candidate.provider === PROVIDER && candidate.id === MODEL_ID);
    if (!model) return (original as NativeCompactionMethod).apply(this, args);

    // Resolve the alternate model through Pi's own ModelRuntime, then let the
    // untouched native method perform the actual compaction.
    const auth = await this._getSummarizationRequestAuth(model);
    const nativeArgs = [...args];
    nativeArgs[1] = auth.model;
    nativeArgs[2] = auth.apiKey;
    nativeArgs[3] = auth.headers;
    nativeArgs[6] = auth.env;
    return (original as NativeCompactionMethod).apply(this, nativeArgs);
  } as NativeCompactionMethod;
  prototype[PATCHED] = true;
}
