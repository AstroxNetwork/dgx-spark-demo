#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dgx_remote_common.sh"

require_dgx_host "${1:-}"

echo "Restarting OpenClaw gateway on ${DGX_USER}@${DGX_HOST}"
run_remote_sudo "systemctl restart localclaw-gateway.service localclaw-caddy.service"

echo
for _ in $(seq 1 30); do
  if curl -kfsS --max-time 10 "https://${DGX_HOST}:8443/health" >/dev/null 2>&1; then
    curl -kfsS --max-time 10 "https://${DGX_HOST}:8443/health"
    echo
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for OpenClaw public health endpoint." >&2
exit 1
