#!/usr/bin/env bash
set -Eeuo pipefail

UPLOAD_SIZE="${UPLOAD_SIZE:-500M}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ "$UPLOAD_SIZE" != "0" && ! "$UPLOAD_SIZE" =~ ^[0-9]+[kKmMgG]?$ ]]; then
  echo "Invalid UPLOAD_SIZE: $UPLOAD_SIZE" >&2
  exit 2
fi

conf_dir="/etc/nginx/conf.d"
conf_file="$conf_dir/00-vps-panel-upload-size.conf"

install -d -m 0755 "$conf_dir"
cat > "$conf_file" <<EOF
# Managed by myPanel. Allows large admin/file-manager uploads through Nginx.
client_max_body_size $UPLOAD_SIZE;
EOF

nginx -t
systemctl reload nginx || systemctl restart nginx

echo "Nginx upload size override installed at $conf_file"
nginx -T 2>/dev/null | grep -n "client_max_body_size" | head -20 || true
