#!/usr/bin/env bash
set -Eeuo pipefail

APEX_IP="${1:-216.150.1.1}"
WWW_CNAME="${2:-c2e5a009d99b9e9a.vercel-dns-017.com.}"
TTL="${TTL:-60}"
STAMP="$(date +%Y%m%d%H%M%S)"

usage() {
  cat >&2 <<EOF
Usage: $0 [apex_ip] [www_cname]

Updates every local BIND zone file so:
  @   ${TTL} IN A     ${APEX_IP}
  www ${TTL} IN CNAME ${WWW_CNAME}

Set TTL=300 $0 to use a different TTL.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ ! "$APEX_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid apex IP: $APEX_IP" >&2
  exit 2
fi

WWW_CNAME="${WWW_CNAME%.}."

bind_service() {
  if systemctl list-unit-files named.service >/dev/null 2>&1; then
    printf 'named'
  else
    printf 'bind9'
  fi
}

zone_domain() {
  basename "$1" | sed 's/^db\.//'
}

is_public_domain_zone() {
  local domain="$1"
  [[ "$domain" == *.* ]] || return 1
  [[ "$domain" != *".in-addr.arpa" ]] || return 1
  [[ "$domain" != "localhost" ]] || return 1
}

rewrite_zone() {
  local file="$1"
  local domain="$2"
  local tmp="$3"
  local today
  today="$(date +%Y%m%d)"
  awk -v apex_ip="$APEX_IP" -v www_cname="$WWW_CNAME" -v ttl="$TTL" -v today="$today" -v zone_domain="$domain" '
    function fqdn_to_name(value, domain, normalized) {
      normalized = value
      sub(/\.$/, "", normalized)
      if (normalized == domain) return "@"
      return normalized
    }
    function lower(value) {
      return tolower(value)
    }
    function bump_serial(line, serial, prefix, suffix, next) {
      if (line ~ /;[[:space:]]*serial/) {
        serial = line
        sub(/^[^0-9]*/, "", serial)
        sub(/[^0-9].*$/, "", serial)
        if (serial ~ /^[0-9]+$/) {
          if (substr(serial, 1, 8) == today) {
            next = serial + 1
          } else {
            next = today "01"
          }
          prefix = line
          sub(/[0-9]+[[:space:]]*;[[:space:]]*serial.*/, "", prefix)
          suffix = line
          sub(/^.*[0-9]+[[:space:]]*/, "", suffix)
          return prefix next " " suffix
        }
      }
      return line
    }
    BEGIN {
      domain = zone_domain
      origin = ""
      added = 0
      changed = 0
    }
    /^\$ORIGIN[[:space:]]+/ {
      origin = $2
      sub(/\.$/, "", origin)
      domain = origin
    }
    {
      raw = $0
      line = bump_serial(raw)
      if (line != raw) changed = 1
      stripped = line
      sub(/[[:space:]]*;.*/, "", stripped)
      part_count = split(stripped, parts, /[[:space:]]+/)
      name = parts[1]
      type = ""
      for (i = 1; i <= part_count; i++) {
        upper = toupper(parts[i])
        if (upper == "A" || upper == "CNAME") {
          type = upper
          break
        }
      }
      comparable = lower(fqdn_to_name(name, domain))
      if (type == "A" && comparable == "@") {
        changed = 1
        next
      }
      if ((type == "A" || type == "CNAME") && comparable == "www") {
        changed = 1
        next
      }
      print line
    }
    END {
      print "@ " ttl " IN A " apex_ip
      print "www " ttl " IN CNAME " www_cname
    }
  ' "$file" > "$tmp"
}

main() {
  shopt -s nullglob
  local files=(/var/named/db.* /etc/bind/zones/db.*)
  local changed=0
  local checked=0
  local failed=0
  local service

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "No BIND zone files found under /var/named or /etc/bind/zones." >&2
    exit 2
  fi

  for file in "${files[@]}"; do
    local domain tmp
    domain="$(zone_domain "$file")"
    if ! is_public_domain_zone "$domain"; then
      continue
    fi
    tmp="$(mktemp)"
    rewrite_zone "$file" "$domain" "$tmp"
    checked=$((checked + 1))
    if ! named-checkzone "$domain" "$tmp" >/tmp/vps-panel-zone-check.log 2>&1; then
      echo "SKIP $domain: generated zone failed validation" >&2
      cat /tmp/vps-panel-zone-check.log >&2
      rm -f "$tmp"
      failed=$((failed + 1))
      continue
    fi
    if cmp -s "$file" "$tmp"; then
      echo "OK unchanged $domain"
      rm -f "$tmp"
      continue
    fi
    cp -a "$file" "$file.vercel-$STAMP.bak"
    mv "$tmp" "$file"
    echo "UPDATED $domain -> @ A $APEX_IP, www CNAME $WWW_CNAME"
    changed=$((changed + 1))
  done

  named-checkconf -z
  service="$(bind_service)"
  rndc reconfig || systemctl restart "$service"
  rndc reload || systemctl reload "$service" || systemctl restart "$service"
  systemctl is-active "$service"

  echo "Done. Checked $checked zones, updated $changed, failed $failed."
  echo "Authoritative DNS is reloaded now. External caches may still honor old TTL until they expire."
  [[ "$failed" -eq 0 ]]
}

main "$@"
