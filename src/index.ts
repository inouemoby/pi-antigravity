import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAntigravityToken,
} from "@cortexkit/antigravity-auth-core";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rememberPackedRefresh } from "./credential-cache.ts";
import {
  fetchAntigravityModels,
  loadCachedModels,
  queryAntigravityModels,
  saveCachedModels,
} from "./model-discovery.ts";
import { streamAntigravity } from "./stream.ts";

const PROVIDER = "google-antigravity";
const BASE_URL = "https://cloudcode-pa.googleapis.com";

function renderCallbackHtml(heading: string, message: string, isError = false): string {
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

interface CallbackServerResult {
  server: Server;
  waitForCode: () => Promise<{ code: string; state: string }>;
  close: () => void;
}

function startCallbackServer(signal?: AbortSignal): Promise<CallbackServerResult> {
  return new Promise((resolve, reject) => {
    let settleResolve: ((val: { code: string; state: string }) => void) | undefined;
    let settleReject: ((err: Error) => void) | undefined;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
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
        },
      });
    });

    signal?.addEventListener(
      "abort",
      () => {
        server.close();
        settleReject?.(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

function parseCodeInput(input: string, fallbackState: string): { code: string; state: string } {
  let code = input.trim();
  let state = fallbackState;
  try {
    const callbackUrl = new URL(code);
    const callbackCode = callbackUrl.searchParams.get("code");
    if (callbackCode) code = callbackCode;
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState) state = callbackState;
  } catch {
    // Bare authorization code pasted
  }
  return { code, state };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const auth = await authorizeAntigravity();
  const authState = new URL(auth.url).searchParams.get("state") ?? "";

  let serverResult: CallbackServerResult | undefined;
  try {
    serverResult = await startCallbackServer(callbacks.signal);
  } catch (err) {
    callbacks.onProgress?.(
      `Could not bind callback server on port 51121 (${err instanceof Error ? err.message : String(err)}). You can paste the redirect URL manually.`,
    );
  }

  callbacks.onAuth({
    url: auth.url,
    instructions: "Complete sign-in in your browser.",
  });

  const promises: Promise<{ code: string; state: string }>[] = [];

  if (serverResult) {
    promises.push(serverResult.waitForCode());
  }

  if (callbacks.onManualCodeInput) {
    promises.push(
      callbacks.onManualCodeInput().then((input) => parseCodeInput(input, authState)),
    );
  } else if (!serverResult) {
    promises.push(
      callbacks
        .onPrompt({
          message: "Paste the Antigravity OAuth callback URL or authorization code:",
        })
        .then((input) => parseCodeInput(input, authState)),
    );
  }

  try {
    const { code, state } = await Promise.race(promises);
    callbacks.onProgress?.("Exchanging authorization code for tokens...");
    const result = await exchangeAntigravity(code, state);
    if (result.type !== "success") {
      throw new Error(`Antigravity OAuth exchange failed: ${result.error}`);
    }

    // Refresh model list immediately upon new login
    try {
      const discovered = await queryAntigravityModels(result.access, result.refresh);
      if (discovered.length > 0) saveCachedModels(discovered);
    } catch {
      // Ignore background discovery error on login
    }

    return {
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      email: result.email,
    };
  } finally {
    serverResult?.close();
  }
}

async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshToken = credentials.refresh.split("|", 1)[0] ?? credentials.refresh;
  const next = await refreshAntigravityToken(refreshToken);
  const suffix = credentials.refresh.includes("|")
    ? credentials.refresh.slice(credentials.refresh.indexOf("|"))
    : "";
  return {
    refresh: `${next.refresh}${suffix}`,
    access: next.access,
    expires: next.expires,
    email: credentials.email,
  };
}

function readStoredCredential(): { access: string; refresh: string } | undefined {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR
      || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
    const authPath = path.join(agentDir, "auth.json");
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const cred = auth[PROVIDER];
      if (cred?.type === "oauth" && cred.access && cred.refresh) {
        return { access: cred.access, refresh: cred.refresh };
      }
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

export default async function piAntigravity(pi: ExtensionAPI): Promise<void> {
  let models = loadCachedModels();

  // If user is already authenticated, attempt a fast startup refresh (with timeout)
  const stored = readStoredCredential();
  if (stored) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const liveModels = await queryAntigravityModels(stored.access, stored.refresh, controller.signal);
      clearTimeout(timeout);
      if (liveModels.length > 0) {
        models = liveModels;
        saveCachedModels(models);
      }
    } catch {
      // Fall through to cached models on offline / timeout
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
      },
    },
    streamSimple: streamAntigravity,
  });
}
