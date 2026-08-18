# Pi subscription proxy

A dependency-free reverse proxy for Pi's built-in subscription providers and custom OpenAI-compatible endpoints:

- `openai-codex` → `https://chatgpt.com/backend-api`
- `anthropic` → `https://api.anthropic.com`
- `xai` → `https://api.x.ai/v1`

Pi still handles OAuth refresh, request construction, and response parsing. The proxy only selects the backend and forwards HTTP/SSE or WebSocket bytes unchanged.

## Run

```bash
npm start
```

The proxy listens only on `127.0.0.1:8787`. Optional settings:

```bash
HOST=127.0.0.1 \
PORT=8787 \
CODEX_UPSTREAM_BASE=https://chatgpt.com/backend-api \
ANTHROPIC_UPSTREAM_BASE=https://api.anthropic.com \
XAI_UPSTREAM_BASE=https://api.x.ai/v1 \
npm start
```

`UPSTREAM_BASE` remains an alias for `CODEX_UPSTREAM_BASE`.

Do not expose the proxy to other machines: subscription bearer tokens and custom API keys pass through it.

## Configure Pi

Use Pi's `/login` to sign in to the subscriptions you use. Then merge these overrides into `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "http://127.0.0.1:8787"
    },
    "anthropic": {
      "baseUrl": "http://127.0.0.1:8787"
    },
    "xai": {
      "baseUrl": "http://127.0.0.1:8787"
    }
  }
}
```

Do not specify `api` or `apiKey`. Overriding each built-in provider preserves its OAuth flow, models, and native API adapter.

Requests under `/codex/` route to ChatGPT, `/v1/messages` to Anthropic, and `/chat/completions` or `/responses` to xAI. Codex supports WebSocket and SSE; Anthropic and xAI stream over SSE.

## Custom OpenAI-compatible endpoints

Encode each upstream base URL as one path segment:

```bash
node -p 'encodeURIComponent("https://api.acme.com/v1")'
# https%3A%2F%2Fapi.acme.com%2Fv1
```

Use that value in the custom provider's local `baseUrl`. API keys remain in Pi and are forwarded unchanged:

```json
{
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "http://127.0.0.1:8787/route_map/https%3A%2F%2Fapi.acme.com%2Fv1",
      "api": "openai-completions",
      "apiKey": "$ACME_API_KEY",
      "models": [
        { "id": "acme-model" }
      ]
    },
    "other": {
      "name": "Other",
      "baseUrl": "http://127.0.0.1:8787/route_map/https%3A%2F%2Fgateway.example%2Fopenai%2Fv1",
      "api": "openai-responses",
      "apiKey": "$OTHER_API_KEY",
      "models": [
        { "id": "other-model" }
      ]
    }
  }
}
```

Set the referenced environment variables before starting Pi. The proxy decodes the upstream, strips `/route_map/<encoded-upstream>`, and appends `/chat/completions` or `/responses`. Adding endpoints requires no proxy restart.

Only `http:` and `https:` targets are accepted. Because this permits arbitrary destinations to local callers, keep the proxy bound to loopback.

## Check

```bash
npm test
```
