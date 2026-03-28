#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

sudo_run() {
  if [[ -n "${DGX_SUDO_PASSWORD:-}" ]]; then
    printf '%s\n' "$DGX_SUDO_PASSWORD" | sudo -S -p '' "$@"
    return
  fi
  sudo "$@"
}

sudo_run install -m 0644 "$ROOT_DIR/systemd/localclaw-onebox.service" "$SYSTEMD_DIR/localclaw-onebox.service"
sudo_run install -m 0644 "$ROOT_DIR/systemd/localclaw-gateway.service" "$SYSTEMD_DIR/localclaw-gateway.service"
sudo_run install -m 0644 "$ROOT_DIR/systemd/localclaw-caddy.service" "$SYSTEMD_DIR/localclaw-caddy.service"
sudo_run systemctl daemon-reload
sudo_run systemctl enable localclaw-onebox.service localclaw-gateway.service localclaw-caddy.service

echo "Installed DGX systemd services from $ROOT_DIR"
