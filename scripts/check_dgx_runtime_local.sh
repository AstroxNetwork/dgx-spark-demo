#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

check_http() {
  local name="$1"
  local url="$2"
  local expect="${3:-}"
  local response

  if ! response="$(curl -fsS --max-time 6 "$url" 2>/dev/null)"; then
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

failures=0

check_http "Ollama 35B" "http://127.0.0.1:${DGX_OLLAMA_PORT:-11434}/api/tags" "huihui_ai/qwen3.5-abliterated:35b-Claude" || failures=$((failures + 1))
check_http "qwen-tts-rs" "http://127.0.0.1:${DGX_TTS_PORT:-18015}/health" "ok" || failures=$((failures + 1))
check_http "vLLM Qwen ASR" "http://127.0.0.1:${DGX_ASR_PORT:-18002}/v1/models" "Qwen/Qwen3-ASR-1.7B" || failures=$((failures + 1))
check_http "OpenViking" "http://127.0.0.1:${DGX_OPENVIKING_PORT:-1933}/health" "\"status\":\"ok\"" || failures=$((failures + 1))
check_http "OpenClaw gateway" "http://127.0.0.1:${OPENCLAW_PORT:-19001}/health" "\"ok\":true" || failures=$((failures + 1))
check_http "OneBox preview" "http://127.0.0.1:${PREVIEW_PORT:-4173}/" "<!doctype html>" || failures=$((failures + 1))

if [[ "$failures" -eq 0 ]]; then
  green "DGX local runtime checks passed."
  exit 0
fi

red "DGX local runtime checks failed: ${failures}"
exit 1
