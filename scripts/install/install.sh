#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f /etc/os-release ]]; then
  echo "Cannot detect OS: /etc/os-release missing"
  exit 1
fi

# shellcheck source=/dev/null
source /etc/os-release

case "${ID,,}" in
  ubuntu)
    if [[ "${VERSION_ID:-}" == 22.04* ]]; then
      exec bash "$SCRIPT_DIR/ubuntu-22.04.sh" "$@"
    fi
    echo "Unsupported Ubuntu version: ${VERSION_ID:-unknown}. Supported: 22.04"
    exit 1
    ;;
  almalinux)
    if [[ "${VERSION_ID:-}" == 9* ]]; then
      exec bash "$SCRIPT_DIR/alma-linux-9.sh" "$@"
    fi
    echo "Unsupported AlmaLinux version: ${VERSION_ID:-unknown}. Supported: 9.x"
    exit 1
    ;;
  *)
    echo "Unsupported OS: ${PRETTY_NAME:-$ID}. Supported: Ubuntu 22.04, AlmaLinux 9"
    exit 1
    ;;
esac
