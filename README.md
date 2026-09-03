# pi-antigravity

Register [Google Antigravity](https://antigravity.google) as an OAuth provider for the [Pi coding agent](https://pi.dev). Use Antigravity models inside Pi without installing the Antigravity CLI or Gemini CLI.

## Install

```bash
pi install git:github.com/inouemoby/pi-antigravity
```

Restart Pi after installation, or run `/reload`.

## Setup

Authenticate with the Google account that owns your Google AI plan:

```text
/login
→ Sign in with an account
→ Select "Google Antigravity (OAuth)"
→ Complete Google OAuth in your browser
```

Pi starts a local loopback server (`http://localhost:51121/oauth-callback`) to receive the OAuth callback automatically. If running on a remote/headless machine over SSH where localhost cannot be reached, you can paste the final redirect URL or authorization code into the prompt as a fallback.

`/login google-antigravity` can be used to skip the provider selector.

The plugin uses OAuth 2.0 with PKCE. Access and refresh tokens are stored by Pi's credential store and refreshed automatically. No `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `agy`, or `gemini` executable is required.

## Select a model

```text
/model
```

Or select one directly from the command line:

```bash
pi --model google-antigravity/gemini-3.8-flash
```

The model catalog is fetched from Antigravity after OAuth login and refreshed by Pi. The provider uses the exact runtime model IDs returned by Antigravity; it does not pre-register a renamed `antigravity-` model alias.

## What it does

This extension:

1. Registers `google-antigravity` as a Pi provider.
2. Adds a browser-based Google OAuth login flow to `/login`.
3. Fetches the available model list from Antigravity after authentication.
4. Keeps the exact official runtime model IDs returned by the service.
5. Converts Pi messages and tools to the Antigravity request format.
6. Streams text, thinking blocks, tool calls, and usage data back to Pi.

## Available models

Model IDs are fetched from Antigravity at runtime. Examples of official IDs include:

- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3.1-pro`
- `gpt-oss-120b`
- `claude-sonnet-4-6-thinking`
- `claude-opus-4-6-thinking`

The exact list depends on the account, plan, service rollout, and current Antigravity response.

## Capabilities

- OAuth login without installing a separate Antigravity client
- Text and image input
- Extended thinking where supported by the selected model
- Pi tool calling
- Streaming responses
- Automatic access-token refresh
- One Google account per Pi credential

## Provider details

| Property | Value |
|---|---|
| Provider ID | `google-antigravity` |
| Authentication | Google OAuth 2.0 + PKCE |
| Endpoint | `https://cloudcode-pa.googleapis.com` |
| API key | Not used |
| Antigravity CLI | Not required |

## Important notice

This plugin is an independent third-party integration and is not affiliated with Google or the Antigravity team. Review the source code before installing it. Google may change the service, authentication flow, model catalog, or usage terms at any time. Use the plugin only with an account and services you are authorized to access.

## Development

```bash
npm install
npm run check
npm run build
```

## License

MIT
