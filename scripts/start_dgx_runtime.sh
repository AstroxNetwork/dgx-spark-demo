#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

REPO_DIR="${REPO_DIR:-$ROOT_DIR}"
LOG_DIR="${LOG_DIR:-$HOME/demo-stack-logs}"
mkdir -p "$LOG_DIR"

wait_for_http() {
  local name="$1"
  local url="$2"
  local expect="${3:-}"
  local attempts="${4:-60}"
  local delay="${5:-2}"
  local response

  for _ in $(seq 1 "$attempts"); do
    response="$(curl -fsS --max-time 4 "$url" 2>/dev/null || true)"
    if [[ -n "$response" ]] && [[ -z "$expect" || "$response" == *"$expect"* ]]; then
      echo "[PASS] $name"
      return 0
    fi
    sleep "$delay"
  done

  echo "[FAIL] $name"
  return 1
}

echo "==> Ollama 35B"
if ! curl -fsS --max-time 4 "http://127.0.0.1:${DGX_OLLAMA_PORT:-11434}/api/tags" 2>/dev/null | grep -q 'huihui_ai/qwen3.5-abliterated:35b-Claude'; then
  if ! pgrep -af '/usr/local/bin/ollama serve' >/dev/null; then
    nohup /usr/local/bin/ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
  fi
fi
wait_for_http "Ollama 35B" "http://127.0.0.1:${DGX_OLLAMA_PORT:-11434}/api/tags" "huihui_ai/qwen3.5-abliterated:35b-Claude"

echo "==> qwen-tts-rs"
if ! curl -fsS --max-time 4 "http://127.0.0.1:${DGX_TTS_PORT:-18015}/health" 2>/dev/null | grep -q 'ok'; then
  pkill -f '/home/spark/src/qwen3-tts-rs/target/release/qwen-tts-server' || true
  nohup /home/spark/src/qwen3-tts-rs/target/release/qwen-tts-server \
    --model-path /home/spark/models/qwen3-tts-1.7b-customvoice \
    --host 0.0.0.0 \
    --port "${DGX_TTS_PORT:-18015}" \
    --device cuda \
    --dtype bf16 \
    --default-speaker Vivian \
    >"$LOG_DIR/qwen-tts-rs.log" 2>&1 &
fi
wait_for_http "qwen-tts-rs" "http://127.0.0.1:${DGX_TTS_PORT:-18015}/health" "ok"

echo "==> vLLM Qwen ASR"
if ! curl -fsS --max-time 4 "http://127.0.0.1:${DGX_ASR_PORT:-18002}/v1/models" 2>/dev/null | grep -q 'Qwen/Qwen3-ASR-1.7B'; then
  docker start qwen3-asr >/dev/null 2>&1 || docker restart qwen3-asr >/dev/null
fi
wait_for_http "vLLM Qwen ASR" "http://127.0.0.1:${DGX_ASR_PORT:-18002}/v1/models" "Qwen/Qwen3-ASR-1.7B"

echo "==> OpenViking"
if ! curl -fsS --max-time 4 "http://127.0.0.1:${DGX_OPENVIKING_PORT:-1933}/health" 2>/dev/null | grep -q '"status":"ok"'; then
  pkill -f 'openviking-server --config /home/spark/.openviking/ov.conf' || true
  nohup /home/spark/.local/bin/openviking-server \
    --config /home/spark/.openviking/ov.conf \
    >"$LOG_DIR/openviking.log" 2>&1 &
fi
wait_for_http "OpenViking" "http://127.0.0.1:${DGX_OPENVIKING_PORT:-1933}/health" '"status":"ok"'

echo "==> LocalClaw OneBox"
cd "$REPO_DIR"
bash scripts/start_onebox.sh
