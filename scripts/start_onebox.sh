#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PREVIEW_PORT="${PREVIEW_PORT:-4173}"
PREVIEW_LOG="${PREVIEW_LOG:-$HOME/dgx-spark-preview.log}"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use --delete-prefix 25 >/dev/null
fi

mkdir -p "$(dirname "$OPENCLAW_LOG")"
mkdir -p "$(dirname "$PREVIEW_LOG")"

if pgrep -af "vite preview --host 0.0.0.0 --port ${PREVIEW_PORT}" >/dev/null; then
  pkill -f "vite preview --host 0.0.0.0 --port ${PREVIEW_PORT}" || true
  sleep 2
fi

bash "$ROOT_DIR/scripts/start_openclaw_gateway.sh"

(
  cd "$ROOT_DIR"
  npm run build >"$PREVIEW_LOG" 2>&1
  nohup npm run preview -- --host 0.0.0.0 --port "$PREVIEW_PORT" >"$PREVIEW_LOG" 2>&1 < /dev/null &
  disown || true
)

for _ in $(seq 1 30); do
  preview_ok=0

  if curl -fsS "http://127.0.0.1:${PREVIEW_PORT}/" >/dev/null 2>&1; then
    preview_ok=1
  fi

  if [[ "$preview_ok" -eq 1 ]]; then
    echo "Preview: http://127.0.0.1:${PREVIEW_PORT}"
    exit 0
  fi

  sleep 1
done

echo "Failed to start LocalClaw OneBox" >&2
echo "--- Preview log ---" >&2
tail -n 80 "$PREVIEW_LOG" >&2 || true
exit 1
