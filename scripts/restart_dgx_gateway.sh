#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dgx_remote_common.sh"

require_dgx_host "${1:-}"

echo "Restarting OpenClaw gateway on ${DGX_USER}@${DGX_HOST}"
run_remote_repo_script "OPENCLAW_PORT='${OPENCLAW_PORT:-19001}' bash scripts/start_openclaw_gateway.sh"

echo
curl -fsS --max-time 10 "http://${DGX_HOST}:${OPENCLAW_PORT:-19001}/health"
echo
