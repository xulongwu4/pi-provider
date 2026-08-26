# Pi proxy

A dependency-free reverse proxy for Pi. It has one rule: everything after `/route_to/` is the upstream URL.

```text
http://127.0.0.1:8787/route_to/https://api.anthropic.com/v1/messages
                                └─────────── forwarded verbatim ───────────┘
```

Pi still handles OAuth login and refresh, request construction, and response parsing. The proxy only forwards HTTP/SSE or WebSocket bytes unchanged.

## Run

```bash
npm start
```

The proxy listens only on `127.0.0.1:8787`. Optional settings:

```bash
HOST=127.0.0.1 PORT=8787 npm start
```

Keep the proxy on loopback unless it has both access control and an upstream allowlist: subscription bearer tokens and custom API keys pass through it.

## Deploy privately on Cloud Run

Cloud Run supplies `PORT`; the proxy detects Cloud Run and listens on `0.0.0.0`. Exposed instances refuse to start unless `ALLOWED_ORIGINS` contains the exact upstream origins they may contact.

Create a dedicated runtime identity. A new user-managed service account has no project roles by default, which is all this proxy needs:

```bash
PROJECT_ID="$(gcloud config get-value project)"
RUNTIME_SA="pi-proxy-runner@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create pi-proxy-runner \
  --project="$PROJECT_ID" \
  --display-name="Pi proxy Cloud Run runtime"
```

Deploy privately using that identity:

```bash
gcloud run deploy pi-proxy \
  --project="$PROJECT_ID" \
  --source=. \
  --region=us-central1 \
  --service-account="$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars='ALLOWED_ORIGINS=https://chatgpt.com https://api.openai.com https://api.anthropic.com https://api.x.ai https://generativelanguage.googleapis.com'
```

The account performing the deployment needs permission to act as `RUNTIME_SA`; project owners usually already have it. If deployment reports `iam.serviceAccounts.actAs` is missing, grant the deployer `roles/iam.serviceAccountUser` on this service account—not a project-wide role.

Do not grant `RUNTIME_SA` provider, storage, database, or other project roles. The proxy only makes ordinary outbound HTTPS requests. Confirm that it has no direct project roles (the command should print nothing):

```bash
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
  --format="value(bindings.role)"
```

Grant your Google account permission to invoke it:

```bash
gcloud run services add-iam-policy-binding pi-proxy \
  --region=us-central1 \
  --member="user:YOUR_EMAIL" \
  --role="roles/run.invoker"
```

After `gcloud auth login`, add Cloud Run's identity token as a separate header on every provider override. This preserves the provider's own `Authorization` header:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://YOUR-SERVICE-URL/route_to/https://api.anthropic.com",
      "headers": {
        "X-Serverless-Authorization": "!printf 'Bearer %s' \"$(gcloud auth print-identity-token)\""
      }
    }
  }
}
```

Repeat the `headers` entry for each provider routed through the service. Cloud Run validates this header before invoking the proxy; the proxy removes it rather than forwarding it upstream. Identity-token commands run per request, so wrap the command with a local cache if its latency becomes noticeable.

Cloud Run limits each SSE or WebSocket request to the configured timeout (at most 60 minutes). Clients must reconnect after that limit.

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
