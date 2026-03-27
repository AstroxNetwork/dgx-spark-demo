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
DGX_USER="${DGX_USER:-spark}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

run_ssh() {
  if [[ -z "${DGX_PASSWORD:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    read -rsp "DGX password for ${DGX_USER}@${DGX_HOST}: " DGX_PASSWORD
    echo
    export DGX_PASSWORD
  fi

  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    sshpass -p "$DGX_PASSWORD" ssh -o StrictHostKeyChecking=no "${DGX_USER}@${DGX_HOST}" "$@"
  else
    ssh -o StrictHostKeyChecking=no "${DGX_USER}@${DGX_HOST}" "$@"
  fi
}

echo "Starting DGX demo stack on ${DGX_USER}@${DGX_HOST}"
echo

run_ssh "cd /home/spark/src/dgx-spark-demo && DGX_OLLAMA_PORT='${DGX_OLLAMA_PORT:-11434}' DGX_TTS_PORT='${DGX_TTS_PORT:-18015}' DGX_ASR_PORT='${DGX_ASR_PORT:-18002}' DGX_OPENVIKING_PORT='${DGX_OPENVIKING_PORT:-1933}' OPENCLAW_PORT='${OPENCLAW_PORT:-19001}' PREVIEW_PORT='${PREVIEW_PORT:-4173}' bash scripts/start_dgx_runtime.sh"

echo
bash "$ROOT_DIR/scripts/check_dgx_stack.sh" "$DGX_HOST"
