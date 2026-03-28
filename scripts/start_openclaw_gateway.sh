#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

OPENCLAW_PORT="${OPENCLAW_PORT:-19001}"
OPENCLAW_LOG="${OPENCLAW_LOG:-$HOME/openclaw-logs/gateway.log}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.local/bin/openclaw}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_DEV_CONFIG_DIR="${OPENCLAW_DEV_CONFIG_DIR:-$HOME/.openclaw-dev}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_CONFIG_DIR/openclaw.json}"
OPENCLAW_DEV_CONFIG_PATH="${OPENCLAW_DEV_CONFIG_PATH:-$OPENCLAW_DEV_CONFIG_DIR/openclaw.json}"

mkdir -p "$(dirname "$OPENCLAW_LOG")"
mkdir -p "$OPENCLAW_CONFIG_DIR"

ensure_openclaw_config() {
  if [[ ! -f "$OPENCLAW_CONFIG_PATH" && -f "$OPENCLAW_DEV_CONFIG_PATH" ]]; then
    cp "$OPENCLAW_DEV_CONFIG_PATH" "$OPENCLAW_CONFIG_PATH"
  fi

  if [[ ! -f "$OPENCLAW_CONFIG_PATH" ]]; then
    echo "Missing OpenClaw config: $OPENCLAW_CONFIG_PATH" >&2
    return 1
  fi

  python3 - "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_PORT" <<'PY'
import json
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
port = int(sys.argv[2])

config = json.loads(config_path.read_text())
gateway = config.setdefault("gateway", {})
gateway["port"] = port
gateway["bind"] = "lan"
gateway.setdefault("mode", "local")

config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
}

ensure_openclaw_config

systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
pkill -f '[o]penclaw( --dev)? gateway run' >/dev/null 2>&1 || true
sleep 1

nohup "$OPENCLAW_BIN" gateway run --bind lan --force >"$OPENCLAW_LOG" 2>&1 < /dev/null &
disown || true

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${OPENCLAW_PORT}/health" >/dev/null 2>&1; then
    echo "OpenClaw: http://127.0.0.1:${OPENCLAW_PORT}"
    exit 0
  fi
  sleep 1
done

echo "Failed to start OpenClaw gateway" >&2
tail -n 80 "$OPENCLAW_LOG" >&2 || true
exit 1
