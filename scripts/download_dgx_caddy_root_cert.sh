#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/dgx_remote_common.sh"

require_dgx_host "${1:-}"

OUT_DIR="${2:-$ROOT_DIR/tmp/dgx-certs}"
mkdir -p "$OUT_DIR"

OUT_PATH="$OUT_DIR/dgx-caddy-root-${DGX_HOST}.crt"
REMOTE_CERT_PATH="${DGX_CADDY_ROOT_CERT_PATH:-/home/spark/.local/share/caddy/pki/authorities/local/root.crt}"

run_scp_from_remote "$REMOTE_CERT_PATH" "$OUT_PATH"
echo "$OUT_PATH"
