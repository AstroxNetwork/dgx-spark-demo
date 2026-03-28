#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dgx_remote_common.sh"

require_dgx_host "${1:-}"

echo "Restarting OpenClaw gateway on ${DGX_USER}@${DGX_HOST}"
run_remote_sudo "systemctl restart localclaw-gateway.service localclaw-caddy.service"

echo
curl -kfsS --max-time 10 "https://${DGX_HOST}:8443/health"
echo
