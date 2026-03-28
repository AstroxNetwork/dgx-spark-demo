#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

DGX_USER="${DGX_USER:-spark}"
DGX_REPO_DIR="${DGX_REPO_DIR:-/home/spark/src/dgx-spark-demo}"

require_dgx_host() {
  DGX_HOST="${1:-${DGX_HOST:-}}"
  if [[ -z "$DGX_HOST" ]]; then
    echo "DGX_HOST is required. Pass it as the first argument or set it in $ROOT_DIR/.env." >&2
    exit 1
  fi
}

prompt_for_dgx_password() {
  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    return
  fi
  if ! command -v sshpass >/dev/null 2>&1; then
    return
  fi
  if [[ ! -t 0 ]]; then
    return
  fi

  read -rsp "DGX password for ${DGX_USER}@${DGX_HOST}: " DGX_PASSWORD
  echo
  export DGX_PASSWORD
}

run_ssh() {
  prompt_for_dgx_password

  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    sshpass -p "$DGX_PASSWORD" ssh \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -o StrictHostKeyChecking=no \
      "${DGX_USER}@${DGX_HOST}" "$@"
    return
  fi

  ssh -o StrictHostKeyChecking=no "${DGX_USER}@${DGX_HOST}" "$@"
}

run_scp_from_remote() {
  prompt_for_dgx_password

  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    sshpass -p "$DGX_PASSWORD" scp \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -o StrictHostKeyChecking=no \
      "${DGX_USER}@${DGX_HOST}:$1" "$2"
    return
  fi

  scp -o StrictHostKeyChecking=no "${DGX_USER}@${DGX_HOST}:$1" "$2"
}

run_remote_repo_script() {
  local remote_cmd="$1"
  local escaped_repo
  escaped_repo="$(printf '%q' "$DGX_REPO_DIR")"
  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    run_ssh "cd ${escaped_repo} && DGX_SUDO_PASSWORD=$(printf '%q' "$DGX_PASSWORD") ${remote_cmd}"
    return
  fi

  run_ssh "cd ${escaped_repo} && ${remote_cmd}"
}

run_remote_sudo() {
  local remote_cmd="$1"
  local escaped_cmd
  escaped_cmd="$(printf '%q' "$remote_cmd")"

  if [[ -n "${DGX_PASSWORD:-}" ]]; then
    run_ssh "printf '%s\n' $(printf '%q' "$DGX_PASSWORD") | sudo -S -p '' bash -lc ${escaped_cmd}"
    return
  fi

  run_ssh "sudo bash -lc ${escaped_cmd}"
}
