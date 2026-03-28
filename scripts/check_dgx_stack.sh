#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/dgx_remote_common.sh"

require_dgx_host "${1:-}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

check_http() {
  local name="$1"
  local url="$2"
  local expect="${3:-}"

  local response
  if ! response="$(curl -kfsS --max-time 4 "$url" 2>/dev/null)"; then
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

if ! run_remote_repo_script "DGX_OLLAMA_PORT='${DGX_OLLAMA_PORT:-11434}' DGX_TTS_PORT='${DGX_TTS_PORT:-18015}' DGX_ASR_PORT='${DGX_ASR_PORT:-18002}' DGX_OPENVIKING_PORT='${DGX_OPENVIKING_PORT:-1933}' OPENCLAW_PORT='${OPENCLAW_PORT:-19001}' PREVIEW_PORT='${PREVIEW_PORT:-4173}' bash scripts/check_dgx_runtime_local.sh"; then
  failures=$((failures + 1))
fi

check_http "OpenClaw public entry" "https://${DGX_HOST}:8443/health" "\"ok\":true" || failures=$((failures + 1))
check_http "OneBox public entry" "https://${DGX_HOST}:8444/" "<!doctype html>" || failures=$((failures + 1))

echo

if [[ "$failures" -eq 0 ]]; then
  green "DGX demo stack is ready."
  exit 0
fi

yellow "DGX demo stack has ${failures} failing checks."
yellow "Recommended next step: run scripts/start_dgx_stack.sh <current-dgx-ip>"
exit 1
