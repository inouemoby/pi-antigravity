import {
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAntigravityToken,
} from "@cortexkit/antigravity-auth-core";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rememberPackedRefresh } from "./credential-cache.ts";
import { fetchAntigravityModels } from "./model-discovery.ts";
import { streamAntigravity } from "./stream.ts";

const PROVIDER = "google-antigravity";
const BASE_URL = "https://cloudcode-pa.googleapis.com";

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const auth = await authorizeAntigravity();
  callbacks.onAuth({
    url: auth.url,
  });
  callbacks.onProgress?.("Complete Google sign-in in the browser, then paste the callback URL here.");

  const input = await callbacks.onPrompt({
    message: "Paste the Antigravity OAuth callback URL or authorization code:",
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
    // The user pasted a bare authorization code.
  }

  const result = await exchangeAntigravity(code, state);
  if (result.type !== "success") throw new Error(`Antigravity OAuth exchange failed: ${result.error}`);

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    email: result.email,
  };
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

export default function piAntigravity(pi: ExtensionAPI): void {
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
      },
    },
    streamSimple: streamAntigravity,
  });
}
