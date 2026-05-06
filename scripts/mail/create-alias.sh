#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:?source address required}"
TARGET="${2:?target address required}"
printf '%s %s\n' "$SOURCE" "$TARGET" >> /etc/postfix/virtual
postmap /etc/postfix/virtual
systemctl reload postfix
