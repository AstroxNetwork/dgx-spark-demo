#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/dgx_remote_common.sh"

require_dgx_host "${1:-}"

DOWN_TIMEOUT_SECONDS="${DOWN_TIMEOUT_SECONDS:-90}"
UP_TIMEOUT_SECONDS="${UP_TIMEOUT_SECONDS:-420}"
CHECK_TIMEOUT_SECONDS="${CHECK_TIMEOUT_SECONDS:-420}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"

ssh_probe() {
  prompt_for_dgx_password

  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    sshpass -p "$DGX_PASSWORD" ssh \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -o StrictHostKeyChecking=no \
      -o ConnectTimeout=3 \
      "${DGX_USER}@${DGX_HOST}" "true" >/dev/null 2>&1
    return
  fi

  ssh \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=3 \
    "${DGX_USER}@${DGX_HOST}" "true" >/dev/null 2>&1
}

wait_for_ssh_down() {
  local deadline=$((SECONDS + DOWN_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if ! ssh_probe; then
      echo "DGX is going down."
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  echo "Timed out waiting for DGX to go down." >&2
  return 1
}

wait_for_ssh_up() {
  local deadline=$((SECONDS + UP_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if ssh_probe; then
      echo "DGX SSH is back."
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  echo "Timed out waiting for DGX SSH to come back." >&2
  return 1
}

wait_for_stack_ready() {
  local deadline=$((SECONDS + CHECK_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if bash "$ROOT_DIR/scripts/check_dgx_stack.sh" "$DGX_HOST" >/dev/null 2>&1; then
      bash "$ROOT_DIR/scripts/check_dgx_stack.sh" "$DGX_HOST"
      return 0
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  echo "Timed out waiting for DGX stack checks to pass." >&2
  bash "$ROOT_DIR/scripts/check_dgx_stack.sh" "$DGX_HOST" || true
  return 1
}

echo "Scheduling reboot on ${DGX_USER}@${DGX_HOST}"
run_remote_sudo "systemd-run --unit codex-dgx-reboot --on-active=2 /usr/bin/systemctl reboot" >/dev/null

wait_for_ssh_down
wait_for_ssh_up

echo "Waiting for DGX stack to recover"
wait_for_stack_ready
