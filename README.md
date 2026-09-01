# Pi proxy

A dependency-free reverse proxy for Pi. It has one rule: everything after `/route_to/` is the upstream URL.

```text
http://127.0.0.1:8787/route_to/https://api.anthropic.com/v1/messages
                                └─────────── forwarded verbatim ───────────┘
```

Pi still handles OAuth login and refresh, request construction, and response parsing. The proxy only forwards HTTP/SSE or WebSocket bytes unchanged.

The proxy speaks HTTP/1.1 and HTTP/2 on the same port. HTTP/2 clients (prior-knowledge `h2c`, as used by `pi-cursor`'s `node:http2` transport) are forwarded to the upstream over HTTP/2 — required for HTTP/2-only upstreams like Cursor's — while HTTP/1.1 clients are forwarded over HTTP/1.1. Route pi-cursor through the proxy by pointing its agent URL at it, e.g. `PI_CURSOR_AGENT_URL=http://127.0.0.1:8787/route_to/https://agentn.us.api5.cursor.sh`.

## Run

```bash
npm start
```

The proxy listens only on `127.0.0.1:8787`. Optional settings:

```bash
HOST=127.0.0.1 PORT=8787 npm start
```

Do not expose the proxy to other machines: subscription bearer tokens and custom API keys pass through it.

## Configure Pi

Prefix each provider's real base URL with the local proxy. Merge into `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "http://127.0.0.1:8787/route_to/https://chatgpt.com/backend-api"
    },
    "anthropic": {
      "baseUrl": "http://127.0.0.1:8787/route_to/https://api.anthropic.com"
    },
    "xai": {
      "baseUrl": "http://127.0.0.1:8787/route_to/https://api.x.ai/v1"
    }
  }
}
```

For built-in providers do not specify `api` or `apiKey`; overriding only `baseUrl` preserves each provider's OAuth flow, models, and native API adapter. Sign in first with Pi's `/login`.

Custom providers work the same way, with their API keys still resolved by Pi:

```json
{
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "http://127.0.0.1:8787/route_to/https://api.acme.com/v1",
      "api": "openai-completions",
      "apiKey": "$ACME_API_KEY",
      "models": [
        { "id": "acme-model" }
      ]
    }
  }
}
```

Set any referenced environment variables before starting Pi. Adding or changing endpoints requires no proxy restart.

## How a request flows

Pi appends its adapter path to the configured `baseUrl`, so `openai-completions` sends:

```text
/route_to/https://api.acme.com/v1/chat/completions
```

The proxy strips `/route_to/`, parses the remainder as the complete target, and forwards the method, path, query string, headers, and body unchanged:

```text
https://api.acme.com/v1/chat/completions
```

Include the upstream's own version prefix only when that upstream needs it — `/v1` for xAI and most OpenAI-compatible servers, none for Anthropic, `/backend-api` for Codex. SSE and WebSocket upgrades are both proxied.

Only `http:` and `https:` targets are accepted; anything else returns 404. Keep the proxy bound to loopback and connect Pi directly — an intermediary that normalizes `//` could damage the nested upstream URL.

## Check

```bash
npm test
```
