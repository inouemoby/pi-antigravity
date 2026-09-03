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
→ Select "Google Antigravity"
→ Complete Google OAuth in your browser
→ Paste the callback URL or authorization code back into Pi
```

The plugin uses OAuth 2.0 with PKCE. Access and refresh tokens are stored by Pi's credential store and refreshed automatically. No `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `agy`, or `gemini` executable is required.

## Select a model

```text
/model
```

Or select one directly from the command line:

```bash
pi --model google-antigravity/antigravity-gemini-3.8-flash
```

List the models registered by the plugin:

```text
/antigravity-models
```

## What it does

On startup, this extension:

1. Registers `google-antigravity` as a Pi provider.
2. Adds a browser-based Google OAuth login flow to `/login`.
3. Imports the public Antigravity model catalog.
4. Converts Pi messages and tools to the Antigravity request format.
5. Streams text, thinking blocks, tool calls, and usage data back to Pi.

## Available models

The model catalog is provided by the Antigravity compatibility layer and can change independently of this plugin. The current catalog includes entries such as:

- `antigravity-gemini-3.8-flash`
- `antigravity-gemini-3.7-flash`
- `antigravity-gemini-3.6-flash`
- `antigravity-gemini-3.5-flash`
- `antigravity-gemini-3.1-pro`
- `antigravity-gpt-oss-120b-medium`
- `antigravity-claude-sonnet-4-6-thinking`
- `antigravity-claude-opus-4-6-thinking`

Use `/antigravity-models` to see the exact models available in the installed version.

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
