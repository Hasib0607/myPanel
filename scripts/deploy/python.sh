#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?app directory required}"
cd "$APP_DIR"
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
supervisorctl reread
supervisorctl update
