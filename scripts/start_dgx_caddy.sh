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
PREVIEW_PORT="${PREVIEW_PORT:-4173}"
CADDY_BIN="${CADDY_BIN:-$HOME/.local/bin/caddy}"
CADDY_VERSION="${CADDY_VERSION:-2.9.1}"
CADDY_STATE_DIR="${CADDY_STATE_DIR:-$HOME/.local/state/dgx-spark-demo/caddy}"
CADDY_LOG="${CADDY_LOG:-$CADDY_STATE_DIR/caddy.log}"
CADDYFILE_PATH="${CADDYFILE_PATH:-$CADDY_STATE_DIR/Caddyfile}"

mkdir -p "$HOME/.local/bin" "$CADDY_STATE_DIR"

if [[ ! -x "$CADDY_BIN" ]]; then
  archive="$CADDY_STATE_DIR/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
  curl -fsSL -o "$archive" "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
  tar -xzf "$archive" -C "$CADDY_STATE_DIR" caddy
  mv "$CADDY_STATE_DIR/caddy" "$CADDY_BIN"
  chmod +x "$CADDY_BIN"
fi

detect_primary_ip() {
  ip -brief -4 addr show up 2>/dev/null | awk '
    $1 !~ /^(lo|docker[0-9]*|br-.*|veth.*|virbr.*|Meta)$/ {
      split($3, cidr, "/");
      if (cidr[1] != "") {
        print cidr[1];
        exit;
      }
    }
  '
}

fallback_primary_ip() {
  hostname -I 2>/dev/null | tr " " "\n" | awk '
    $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ &&
    $1 !~ /^127\./ &&
    $1 !~ /^198\.18\./ {
      print $1;
      exit;
    }
  '
}

PRIMARY_IP="${DGX_PUBLIC_IP:-$(detect_primary_ip)}"
if [[ -z "${PRIMARY_IP:-}" ]]; then
  PRIMARY_IP="$(fallback_primary_ip)"
fi

render_site_addresses() {
  local port="$1"
  local addresses=("https://127.0.0.1:${port}" "https://localhost:${port}")
  if [[ -n "${PRIMARY_IP:-}" ]] && [[ "$PRIMARY_IP" != "127.0.0.1" ]]; then
    addresses=("https://${PRIMARY_IP}:${port}" "${addresses[@]}")
  fi
  local joined=""
  for address in "${addresses[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$address"
  done
  printf '%s' "$joined"
}

OPENCLAW_SITE_ADDRESSES="$(render_site_addresses 8443)"
PREVIEW_SITE_ADDRESSES="$(render_site_addresses 8444)"

cat >"$CADDYFILE_PATH" <<EOF
{
  auto_https disable_redirects
}

${OPENCLAW_SITE_ADDRESSES} {
  tls internal
  reverse_proxy 127.0.0.1:${OPENCLAW_PORT}
}

${PREVIEW_SITE_ADDRESSES} {
  tls internal
  reverse_proxy 127.0.0.1:${PREVIEW_PORT}
}
EOF

echo "openclaw=${PRIMARY_IP:+https://${PRIMARY_IP}:8443}"
echo "voice_demo=${PRIMARY_IP:+https://${PRIMARY_IP}:8444}"

exec "$CADDY_BIN" run --config "$CADDYFILE_PATH"
