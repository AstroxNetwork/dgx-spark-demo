#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PREVIEW_PORT="${PREVIEW_PORT:-4173}"
OPENCLAW_PORT="${OPENCLAW_PORT:-19001}"
OPENCLAW_LOG="${OPENCLAW_LOG:-$HOME/openclaw-logs/gateway.log}"
PREVIEW_LOG="${PREVIEW_LOG:-$HOME/dgx-spark-preview.log}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.local/bin/openclaw}"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use --delete-prefix 25 >/dev/null
fi

mkdir -p "$(dirname "$OPENCLAW_LOG")"
mkdir -p "$(dirname "$PREVIEW_LOG")"

if pgrep -af 'openclaw --dev gateway run' >/dev/null; then
  pkill -f 'openclaw --dev gateway run' || true
  sleep 2
fi

if pgrep -af "vite preview --host 0.0.0.0 --port ${PREVIEW_PORT}" >/dev/null; then
  pkill -f "vite preview --host 0.0.0.0 --port ${PREVIEW_PORT}" || true
  sleep 2
fi

nohup "$OPENCLAW_BIN" --dev gateway run --bind lan --force >"$OPENCLAW_LOG" 2>&1 < /dev/null &
disown || true

(
  cd "$ROOT_DIR"
  nohup npm run preview -- --host 0.0.0.0 --port "$PREVIEW_PORT" >"$PREVIEW_LOG" 2>&1 < /dev/null &
  disown || true
)

for _ in $(seq 1 30); do
  openclaw_ok=0
  preview_ok=0

  if curl -fsS "http://127.0.0.1:${OPENCLAW_PORT}/health" >/dev/null 2>&1; then
    openclaw_ok=1
  fi

  if curl -fsS "http://127.0.0.1:${PREVIEW_PORT}/" >/dev/null 2>&1; then
    preview_ok=1
  fi

  if [[ "$openclaw_ok" -eq 1 && "$preview_ok" -eq 1 ]]; then
    echo "OpenClaw: http://127.0.0.1:${OPENCLAW_PORT}"
    echo "Preview: http://127.0.0.1:${PREVIEW_PORT}"
    exit 0
  fi

  sleep 1
done

echo "Failed to start LocalClaw OneBox" >&2
echo "--- OpenClaw log ---" >&2
tail -n 80 "$OPENCLAW_LOG" >&2 || true
echo "--- Preview log ---" >&2
tail -n 80 "$PREVIEW_LOG" >&2 || true
exit 1
