#!/usr/bin/env bash
set -Eeuo pipefail

STATE_FILE="${VERCEL_DNS_STATE_FILE:-/var/lib/vps-panel/vercel-dns-target.env}"
DEFAULT_APEX_IP="${DEFAULT_APEX_IP:-216.150.1.1}"
DEFAULT_WWW_CNAME="${DEFAULT_WWW_CNAME:-c2e5a009d99b9e9a.vercel-dns-017.com.}"
APEX_IP="${1:-${APEX_IP:-$DEFAULT_APEX_IP}}"
WWW_CNAME="${2:-${WWW_CNAME:-$DEFAULT_WWW_CNAME}}"
TTL="${TTL:-60}"
STAMP="$(date +%Y%m%d%H%M%S)"

usage() {
  cat >&2 <<EOF
Usage: $0 [apex_ip] [www_cname]

Updates every local BIND zone file so:
  @   ${TTL} IN A     ${APEX_IP}
  www ${TTL} IN CNAME ${WWW_CNAME}

Set TTL=300 $0 to use a different TTL.
The chosen target is saved to $STATE_FILE so verify-vercel-dns-public.sh can
reuse the same values without repeating arguments.
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

save_target_state() {
  install -d -m 0755 "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" <<EOF
APEX_IP=$APEX_IP
WWW_CNAME=$WWW_CNAME
TTL=$TTL
UPDATED_AT=$(date -Iseconds)
EOF
}

zone_domain() {
  basename "$1" | sed 's/^db\.//'
}

is_live_zone_file() {
  local file="$1"
  case "$file" in
    *.bak|*.rollback|*.check|*.vps-panel.check|*.vps-panel.rollback|*.vps-panel-nsfix.bak|*.vercel-*.bak)
      return 1
      ;;
  esac
  return 0
}

is_public_domain_zone() {
  local domain="$1"
  [[ "$domain" == *.* ]] || return 1
  [[ "$domain" != *".in-addr.arpa" ]] || return 1
  [[ "$domain" != "localhost" ]] || return 1
  [[ "$domain" != admin.* ]] || return 1
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
    function dns_type(value) {
      value = toupper(value)
      return value == "A" || value == "AAAA" || value == "CNAME" || value == "MX" || value == "TXT" || value == "NS" || value == "SRV" || value == "CAA" || value == "SOA"
    }
    function is_ttl(value) {
      return value ~ /^[0-9]+$/
    }
    function record_owner(raw_line, part_count, parts, type_index, owner) {
      if (part_count == 0 || type_index == 0) return ""
      if (raw_line ~ /^[[:space:]]/) {
        return last_owner
      }
      if (type_index == 1) {
        return last_owner
      }
      owner = parts[1]
      if (is_ttl(owner) || toupper(owner) == "IN") {
        return last_owner
      }
      last_owner = owner
      return owner
    }
    function bump_serial(line, serial, prefix, suffix, next_serial) {
      if (line ~ /;[[:space:]]*serial/) {
        serial = line
        sub(/^[^0-9]*/, "", serial)
        sub(/[^0-9].*$/, "", serial)
        if (serial ~ /^[0-9]+$/) {
          if (substr(serial, 1, 8) == today) {
            next_serial = serial + 1
          } else {
            next_serial = today "01"
          }
          prefix = line
          sub(/[0-9]+[[:space:]]*;[[:space:]]*serial.*/, "", prefix)
          suffix = line
          sub(/^.*[0-9]+[[:space:]]*/, "", suffix)
          return prefix next_serial " " suffix
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
      type = ""
      type_index = 0
      for (i = 1; i <= part_count; i++) {
        upper = toupper(parts[i])
        if (dns_type(upper)) {
          type = upper
          type_index = i
          break
        }
      }
      name = record_owner(raw, part_count, parts, type_index)
      comparable = lower(fqdn_to_name(name, domain))
      if ((type == "A" || type == "AAAA" || type == "CNAME") && comparable == "@") {
        changed = 1
        next
      }
      if (type != "" && comparable == "www") {
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
  local failed_domains=()

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "No BIND zone files found under /var/named or /etc/bind/zones." >&2
    exit 2
  fi

  for file in "${files[@]}"; do
    local domain tmp
    is_live_zone_file "$file" || continue
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
      failed_domains+=("$domain")
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
  if [[ "$failed" -gt 0 ]]; then
    echo "Failed zones:"
    printf '  %s\n' "${failed_domains[@]}"
  else
    save_target_state
    echo "Saved Vercel DNS target state to $STATE_FILE"
  fi
  echo "Authoritative DNS is reloaded now. External caches may still honor old TTL until they expire."
  [[ "$failed" -eq 0 ]]
}

main "$@"
