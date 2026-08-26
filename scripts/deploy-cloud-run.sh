#!/usr/bin/env bash
set -euo pipefail

DEFAULT_ALLOWED_ORIGINS=(
  "https://ai-gateway.vercel.sh"
  "https://api.ant-ling.com"
  "https://api.anthropic.com"
  "https://api.cerebras.ai"
  "https://api.cline.bot"
  "https://api.deepseek.com"
  "https://api.fireworks.ai"
  "https://api.groq.com"
  "https://api.individual.githubcopilot.com"
  "https://api.kimi.com"
  "https://api.minimax.io"
  "https://api.minimaxi.com"
  "https://api.mistral.ai"
  "https://api.moonshot.ai"
  "https://api.moonshot.cn"
  "https://api.openai.com"
  "https://api.together.ai"
  "https://api.x.ai"
  "https://api.xiaomimimo.com"
  "https://api.z.ai"
  "https://bedrock-runtime.eu-central-1.amazonaws.com"
  "https://bedrock-runtime.us-east-1.amazonaws.com"
  "https://chatgpt.com"
  "https://generativelanguage.googleapis.com"
  "https://inference.baseten.co"
  "https://integrate.api.nvidia.com"
  "https://open.bigmodel.cn"
  "https://opencode.ai"
  "https://openrouter.ai"
  "https://radius.pi.dev"
  "https://router.huggingface.co"
  "https://server.codeium.com"
  "https://token-plan-ams.xiaomimimo.com"
  "https://token-plan-cn.xiaomimimo.com"
  "https://token-plan-sgp.xiaomimimo.com"
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com"
  "https://token-plan.cn-beijing.maas.aliyuncs.com"
)

usage() {
  cat <<'EOF'
Deploy pi-proxy as an IAM-private Cloud Run service.

Environment overrides:
  PROJECT_ID       Google Cloud project (default: active gcloud project)
  REGION           Cloud Run region (default: us-central1)
  SERVICE          Cloud Run service name (default: pi-proxy)
  SA_NAME          Runtime service account name (default: pi-proxy-runner)
  INVOKER_MEMBER   IAM member allowed to invoke it (default: active gcloud user)
  TIMEOUT          Request timeout in seconds (default: 3600)
  ALLOWED_ORIGINS  Space-separated HTTPS origins

Options:
  --print-allowed-origins  Print the built-in fixed-origin defaults
EOF
}

case ${1:-} in
  --help|-h) usage; exit 0 ;;
  --print-allowed-origins) printf '%s\n' "${DEFAULT_ALLOWED_ORIGINS[@]}"; exit 0 ;;
  "") ;;
  *) usage >&2; exit 2 ;;
esac

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-pi-proxy}"
SA_NAME="${SA_NAME:-pi-proxy-runner}"
TIMEOUT="${TIMEOUT:-3600}"
ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
INVOKER_MEMBER="${INVOKER_MEMBER:-user:${ACCOUNT}}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${DEFAULT_ALLOWED_ORIGINS[*]}}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS//,/ }"
RUNTIME_SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] || { echo "Set PROJECT_ID or select a gcloud project" >&2; exit 1; }
[[ -n "$ACCOUNT" && "$ACCOUNT" != "(unset)" ]] || { echo "Run gcloud auth login first" >&2; exit 1; }
for origin in $ALLOWED_ORIGINS; do
  [[ $origin == https://* ]] || { echo "Only HTTPS origins are allowed: $origin" >&2; exit 1; }
done

echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE"
echo "Runtime:  $RUNTIME_SA"
echo "Invoker:  $INVOKER_MEMBER"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Pi proxy Cloud Run runtime" \
    --quiet
fi

direct_roles="$(gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
  --format='value(bindings.role)')"
if [[ -n "$direct_roles" ]]; then
  echo "Refusing to deploy: $RUNTIME_SA has direct project roles:" >&2
  echo "$direct_roles" >&2
  exit 1
fi

SERVICE_URL="$(gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --source=. \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --timeout="$TIMEOUT" \
  --set-env-vars="ALLOWED_ORIGINS=$ALLOWED_ORIGINS" \
  --quiet \
  --format='value(status.url)')"

gcloud run services add-iam-policy-binding "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="$INVOKER_MEMBER" \
  --role="roles/run.invoker" \
  --quiet >/dev/null

if gcloud run services get-iam-policy "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --flatten='bindings[].members' \
    --filter='bindings.members:allUsers' \
    --format='value(bindings.members)' | grep -q .; then
  gcloud run services remove-iam-policy-binding "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --member='allUsers' \
    --role='roles/run.invoker' \
    --quiet >/dev/null
fi

DEPLOYED_SA="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(spec.template.spec.serviceAccountName)')"
[[ "$DEPLOYED_SA" == "$RUNTIME_SA" ]] || { echo "Unexpected deployed service account: $DEPLOYED_SA" >&2; exit 1; }

echo
echo "Deployed: $SERVICE_URL"
echo "Unauthenticated access is disabled."
echo "Add this Pi header:"
echo "  X-Serverless-Authorization: !printf 'Bearer %s' \"\$(gcloud auth print-identity-token)\""
