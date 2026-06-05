#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-$(pwd)}"
SYSAGENT_PORT="${SYSAGENT_PORT:-5000}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/sysagent/requirements.txt" ]]; then
  echo "Usage: $0 /path/to/myPanel" >&2
  echo "Could not find $APP_DIR/sysagent/requirements.txt" >&2
  exit 2
fi

PYTHON_BIN="$(command -v python3.11 || command -v python3)"
cd "$APP_DIR/sysagent"
ln -sfn ../.env .env

if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m py_compile app/main.py
.venv/bin/python - <<'PY'
import app.main
print("sysagent import ok")
PY

cat >/etc/systemd/system/vps-panel-sysagent.service <<EOF
[Unit]
Description=VPS Panel System Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/sysagent
EnvironmentFile=-$APP_DIR/.env
Environment=ALLOW_LIVE_SYSTEM_COMMANDS=true
Environment=ALLOW_LIVE_FILE_MANAGER=true
Environment=ALLOW_LIVE_NGINX=true
Environment=ALLOW_LIVE_SSL=true
Environment=ALLOW_LIVE_DNS=true
ExecStart=$APP_DIR/sysagent/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $SYSAGENT_PORT
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl reset-failed vps-panel-sysagent
systemctl enable --now vps-panel-sysagent
systemctl restart vps-panel-sysagent
sleep 2
systemctl status vps-panel-sysagent --no-pager -l || true
curl -fsS "http://127.0.0.1:$SYSAGENT_PORT/health"
echo
