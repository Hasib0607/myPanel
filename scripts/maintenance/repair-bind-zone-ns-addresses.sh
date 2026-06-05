#!/usr/bin/env bash
set -Eeuo pipefail

detect_ip() {
  if [[ -n "${VPS_IP:-}" && "$VPS_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s\n' "$VPS_IP"
    return 0
  fi
  curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'
}

zone_domain() {
  basename "$1" | sed 's/^db\.//'
}

ensure_ns_address_records() {
  local file="$1"
  local domain="$2"
  local ip="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v domain="$domain" -v ip="$ip" '
    BEGIN { changed = 0 }
    {
      lines[++count] = $0
      name = $1
      type = ""
      value = ""
      for (i = 1; i <= NF; i++) {
        if ($i == "NS") {
          type = "NS"
          value = $(i + 1)
        }
      }
      if (type == "NS") {
        gsub(/\.$/, "", value)
        suffix = "." domain
        if (value ~ suffix "$") {
          label = substr(value, 1, length(value) - length(suffix))
          if (label != "" && label != "@") needed[label] = 1
        }
      }
      if (($3 == "A" || $4 == "A") && ($1 in needed || $1 == "ns1" || $1 == "ns2")) existing[$1] = 1
    }
    END {
      for (i = 1; i <= count; i++) print lines[i]
      for (label in needed) {
        if (!(label in existing)) {
          print label " 3600 IN A " ip
          changed = 1
        }
      }
    }
  ' "$file" > "$tmp"
  if ! cmp -s "$file" "$tmp"; then
    cp -a "$file" "$file.vps-panel-nsfix.bak"
    mv "$tmp" "$file"
    echo "fixed $file"
  else
    rm -f "$tmp"
  fi
}

main() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "Run as root" >&2
    exit 1
  fi
  local ip
  ip="$(detect_ip)"
  if [[ -z "$ip" ]]; then
    echo "Could not detect VPS IP" >&2
    exit 1
  fi

  shopt -s nullglob
  for file in /var/named/db.* /etc/bind/zones/db.*; do
    ensure_ns_address_records "$file" "$(zone_domain "$file")" "$ip"
    named-checkzone "$(zone_domain "$file")" "$file" || true
  done

  named-checkconf -z
  systemctl restart named 2>/dev/null || systemctl restart bind9
  systemctl is-active named 2>/dev/null || systemctl is-active bind9
}

main "$@"
