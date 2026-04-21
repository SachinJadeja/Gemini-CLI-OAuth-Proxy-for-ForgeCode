# Gemini CLI OAuth Proxy for ForgeCode

An OpenAI-compatible proxy server that bridges ForgeCode to Google's Gemini models using your existing **Gemini CLI OAuth credentials**. This lets you use Gemini 2.5 Pro, Gemini 3 Pro, Gemini 3.1 Pro, and other models through ForgeCode without needing a separate API key.

## How It Works

```
ForgeCode  -->  OpenAI-compatible proxy  -->  Gemini CLI Core  -->  Google Code Assist API
                    (this server)              (OAuth from          (cloudcode-pa.googleapis.com)
                                               ~/.gemini/oauth_creds.json)
```

The proxy:
1. Reads your existing Gemini CLI OAuth tokens from `~/.gemini/oauth_creds.json`
2. Automatically refreshes expired access tokens
3. Translates OpenAI-compatible requests to Google's Code Assist API format
4. Returns responses in standard OpenAI format so ForgeCode understands them

## Prerequisites

- Node.js 20+ (required by `ai-sdk-provider-gemini-cli`)
- Gemini CLI installed and authenticated with Google OAuth
- ForgeCode installed

## Setup

### Step 1: Authenticate Gemini CLI

If you haven't already:

```bash
npm install -g @google/gemini-cli
gemini
# Select "Sign in with Google" and complete the browser OAuth flow
# Credentials are cached at ~/.gemini/oauth_creds.json
```

Verify your credentials exist:
```bash
ls ~/.gemini/oauth_creds.json
```

### Step 2: Install and Start the Proxy

```bash
cd ~/gemini-forge-proxy
npm install
npm start
```

The proxy will start on `http://localhost:4891`.

### Step 3: Configure ForgeCode

Add the custom provider to your ForgeCode config. Edit `~/.forge/.forge.toml` (or `~/forge/.forge.toml` on legacy installs):

```toml
[[providers]]
id             = "gemini-cli"
url            = "http://localhost:4891/v1/chat/completions"
api_key_vars   = "GEMINI_PROXY_KEY"
response_type  = "OpenAI"
auth_methods   = ["api_key"]
```

Then set the dummy API key in `~/.env`:

```bash
# ~/.env
GEMINI_PROXY_KEY=dummy
```

### Step 4: Select the Provider in ForgeCode

Run ForgeCode and select your proxy:

```bash
forge
```

Inside ForgeCode:
```
:login
# Select "gemini-cli" provider
# Enter any value for the API key (the proxy ignores it)

:model
# Select your preferred Gemini model:
#   gemini-2.5-pro
#   gemini-3.1-pro-preview
#   gemini-3-pro-preview
#   gemini-3-flash-preview
#   gemini-2.5-flash
```

Alternatively, set the default model in your project's `forge.yaml`:

```yaml
model: gemini-3.1-pro-preview
```

## Available Models

| Model | Description |
|-------|-------------|
| `gemini-3.1-pro-preview` | Latest Gemini 3.1 Pro (preview) |
| `gemini-3-pro-preview` | Gemini 3 Pro (preview) |
| `gemini-3-flash-preview` | Gemini 3 Flash (preview) |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash |

Model availability depends on your Google account's quota and access tiers.

## Features

- **Streaming**: Full SSE streaming support for real-time responses
- **Tool Calls**: OpenAI-compatible function calling mapped to Gemini tools
- **OAuth Auto-Refresh**: Automatically refreshes expired access tokens using the refresh token
- **Error Handling**: Proper HTTP status codes and OpenAI-formatted error responses
- **Usage Stats**: Returns token usage in OpenAI format

## Running as a Background Service

### macOS / Linux (tmux)
```bash
tmux new-session -d -s gemini-proxy 'cd ~/gemini-forge-proxy && npm start'
# Reattach: tmux attach -t gemini-proxy
# Kill: tmux kill-session -t gemini-proxy
```

### Using PM2
```bash
npm install -g pm2
pm2 start server.js --name gemini-forge-proxy
pm2 save
pm2 startup
```

## Troubleshooting

### "No cached credentials found"
Run `gemini` and authenticate with Google first. Ensure `~/.gemini/oauth_creds.json` exists.

### "RESOURCE_EXHAUSTED" / "No capacity available"
The model you're trying to use (especially preview models) may have hit quota limits. Try:
- Switching to `gemini-2.5-pro` which has higher availability
- Waiting a few minutes and retrying
- Checking your quota at https://developers.google.com/gemini-code-assist/resources/quotas

### "MODEL_CAPACITY_EXHAUSTED" for gemini-3.1-pro-preview
This preview model has limited capacity. If you hit this error consistently, use `gemini-2.5-pro` or `gemini-3-pro-preview` instead.

### ForgeCode can't connect to proxy
Ensure the proxy is running (`curl http://localhost:4891/health` should return `{"status":"ok"}`).

## Architecture Details

This proxy uses:
- **`ai-sdk-provider-gemini-cli`**: Community provider that wraps `@google/gemini-cli-core` to handle OAuth and Code Assist API communication
- **`ai` (Vercel AI SDK v6)**: Handles message formatting, tool calling, and streaming abstractions
- **Express**: OpenAI-compatible HTTP server

The underlying API endpoint is `https://cloudcode-pa.googleapis.com/v1internal:generateContent` (or `streamGenerateContent` for streaming), which is Google's internal Code Assist API — the same endpoint the official Gemini CLI uses.

