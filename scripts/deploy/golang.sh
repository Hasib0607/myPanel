#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?app directory required}"
BINARY_NAME="${2:?binary name required}"
cd "$APP_DIR"
go build -o "bin/$BINARY_NAME" ./...
supervisorctl reread
supervisorctl update
