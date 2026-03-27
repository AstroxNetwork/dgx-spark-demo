#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

DGX_HOST="${1:-${DGX_HOST:-}}"
if [[ -z "$DGX_HOST" ]]; then
  echo "DGX_HOST is required. Pass it as the first argument or set it in $ROOT_DIR/.env." >&2
  exit 1
fi

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

check_http() {
  local name="$1"
  local url="$2"
  local expect="${3:-}"

  local response
  if ! response="$(curl -fsS --max-time 4 "$url" 2>/dev/null)"; then
    red "[FAIL] $name -> $url"
    return 1
  fi

  if [[ -n "$expect" ]] && [[ "$response" != *"$expect"* ]]; then
    red "[FAIL] $name -> unexpected response from $url"
    return 1
  fi

  green "[PASS] $name -> $url"
  return 0
}

echo "Checking DGX stack on ${DGX_HOST}"
echo

failures=0

check_http "Ollama 35B" "http://${DGX_HOST}:${DGX_OLLAMA_PORT:-11434}/api/tags" "huihui_ai/qwen3.5-abliterated:35b-Claude" || failures=$((failures + 1))
check_http "qwen-tts-rs" "http://${DGX_HOST}:${DGX_TTS_PORT:-18015}/health" "ok" || failures=$((failures + 1))
check_http "vLLM Qwen ASR" "http://${DGX_HOST}:${DGX_ASR_PORT:-18002}/v1/models" "Qwen/Qwen3-ASR-1.7B" || failures=$((failures + 1))
check_http "OpenViking" "http://${DGX_HOST}:${DGX_OPENVIKING_PORT:-1933}/health" "\"status\":\"ok\"" || failures=$((failures + 1))
check_http "OpenClaw gateway" "http://${DGX_HOST}:${OPENCLAW_PORT:-19001}/health" "\"ok\":true" || failures=$((failures + 1))
check_http "OneBox preview" "http://${DGX_HOST}:${PREVIEW_PORT:-4173}/" "<!doctype html>" || failures=$((failures + 1))

echo

if [[ "$failures" -eq 0 ]]; then
  green "DGX demo stack is ready."
  exit 0
fi

yellow "DGX demo stack has ${failures} failing checks."
yellow "Recommended next step: ssh into the DGX and restart the missing service(s)."
exit 1
