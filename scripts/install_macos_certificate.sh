#!/usr/bin/env bash

set -euo pipefail

CERT_PATH="${1:-}"
if [[ -z "$CERT_PATH" ]]; then
  echo "Usage: $0 <certificate-path>" >&2
  exit 1
fi

if [[ ! -f "$CERT_PATH" ]]; then
  echo "Certificate not found: $CERT_PATH" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

sudo security add-trusted-cert \
  -d \
  -r trustRoot \
  -k /Library/Keychains/System.keychain \
  "$CERT_PATH"

echo "Installed trusted certificate: $CERT_PATH"
