#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/dgx_remote_common.sh"

require_dgx_host "${1:-}"

echo "Starting DGX demo stack on ${DGX_USER}@${DGX_HOST}"
echo

run_remote_sudo "cd ${DGX_REPO_DIR} && git fetch origin && git reset --hard origin/main"
run_remote_repo_script "bash scripts/install_dgx_services.sh"
run_remote_sudo "systemctl restart localclaw-onebox.service localclaw-caddy.service"

echo
bash "$ROOT_DIR/scripts/check_dgx_stack.sh" "$DGX_HOST"
