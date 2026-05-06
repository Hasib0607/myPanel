#!/usr/bin/env bash
set -euo pipefail

FQDN="${1:?subdomain fqdn required}"
PORT="${2:?target port required}"
"$(dirname "$0")/create-vhost.sh" "$FQDN" "$PORT"
