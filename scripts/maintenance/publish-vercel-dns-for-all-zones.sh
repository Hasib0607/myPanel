#!/usr/bin/env bash
set -Eeuo pipefail

STATE_FILE="${VERCEL_DNS_STATE_FILE:-/var/lib/vps-panel/vercel-dns-target.env}"
DEFAULT_APEX_IP="${DEFAULT_APEX_IP:-216.150.1.1}"
DEFAULT_WWW_CNAME="${DEFAULT_WWW_CNAME:-c2e5a009d99b9e9a.vercel-dns-017.com.}"
APEX_IP="${1:-${APEX_IP:-$DEFAULT_APEX_IP}}"
WWW_CNAME="${2:-${WWW_CNAME:-$DEFAULT_WWW_CNAME}}"
EXCLUDED_DOMAINS="${EXCLUDED_DOMAINS:-ebitans.com admin.ebitans.com}"
TTL="${TTL:-60}"
STAMP="$(date +%Y%m%d%H%M%S)"

usage() {
  cat >&2 <<EOF
Usage: $0 [apex_ip] [www_cname]

Updates every local BIND zone file so:
  @   ${TTL} IN A     ${APEX_IP}
  www ${TTL} IN CNAME ${WWW_CNAME}

Set TTL=300 $0 to use a different TTL.
Excluded domains: $EXCLUDED_DOMAINS
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

dig_short() {
  local resolver="$1"
  local name="$2"
  local type="$3"
  dig "$resolver" +time=3 +tries=1 +short "$type" "$name" 2>/dev/null | sed 's/[[:space:]]*$//'
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
}

is_excluded_domain() {
  local domain="${1%.}"
  local excluded
  for excluded in $EXCLUDED_DOMAINS; do
    [[ "$domain" == "${excluded%.}" ]] && return 0
  done
  return 1
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

install_zone_file() {
  local source="$1"
  local target="$2"
  local backup="$3"
  mv "$source" "$target"
  chown --reference="$backup" "$target" 2>/dev/null || true
  chmod --reference="$backup" "$target" 2>/dev/null || true
  if command -v restorecon >/dev/null 2>&1; then
    restorecon -F "$target" 2>/dev/null || true
  fi
}

reload_zone() {
  local domain="$1"
  rndc reload "$domain" 2>&1 || rndc reload "$domain" IN 2>&1
}

restart_bind() {
  local service="$1"
  rndc flush 2>/dev/null || true
  systemctl restart "$service"
  rndc flush 2>/dev/null || true
}

local_zone_matches() {
  local domain="$1"
  local local_a local_www
  local_a="$(dig_short @127.0.0.1 "$domain" A)"
  local_www="$(dig_short @127.0.0.1 "www.$domain" CNAME)"
  [[ "$local_a" == *"$APEX_IP"* && "$local_www" == *"$WWW_CNAME"* ]]
}

print_zone_diagnostics() {
  local domain="$1"
  local file="$2"
  echo "DIAG $domain: file=$file" >&2
  grep -nE '(^|[[:space:]])(@|www)([[:space:]]|$)|216\.150\.1\.1|c2e5a009d99b9e9a' "$file" >&2 || true
  rndc zonestatus "$domain" >&2 || true
  dig @127.0.0.1 "$domain" SOA +noall +answer >&2 || true
  dig @127.0.0.1 "$domain" A +noall +answer >&2 || true
  dig @127.0.0.1 "www.$domain" CNAME +noall +answer >&2 || true
}

main() {
  shopt -s nullglob
  local files=(/var/named/db.* /etc/bind/zones/db.*)
  local changed=0
  local checked=0
  local failed=0
  local service
  local failed_domains=()
  local reload_domains=()
  local domain_files=()
  local live_failed_domains=()

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
    if is_excluded_domain "$domain"; then
      echo "SKIP excluded $domain"
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
    domain_files+=("$domain=$file")
    if cmp -s "$file" "$tmp"; then
      echo "OK unchanged $domain"
      rm -f "$tmp"
      reload_domains+=("$domain")
      continue
    fi
    local backup="$file.vercel-$STAMP.bak"
    cp -a "$file" "$backup"
    install_zone_file "$tmp" "$file" "$backup"
    echo "UPDATED $domain -> @ A $APEX_IP, www CNAME $WWW_CNAME"
    changed=$((changed + 1))
    reload_domains+=("$domain")
  done

  named-checkconf -z
  service="$(bind_service)"
  rndc reconfig || systemctl restart "$service"
  rndc reload || systemctl reload "$service" || systemctl restart "$service"
  for domain in "${reload_domains[@]}"; do
    if ! reload_output="$(reload_zone "$domain")"; then
      echo "WARN $domain: per-zone reload failed: $reload_output" >&2
      live_failed_domains+=("$domain")
      continue
    fi
    if ! local_zone_matches "$domain"; then
      echo "WARN $domain: local BIND still does not serve @ A $APEX_IP and www CNAME $WWW_CNAME" >&2
      live_failed_domains+=("$domain")
    fi
  done

  if [[ "${#live_failed_domains[@]}" -gt 0 ]]; then
    echo "Live verification failed after rndc reload; restarting $service and rechecking..." >&2
    restart_bind "$service"
    local retry_failed_domains=()
    for domain in "${live_failed_domains[@]}"; do
      if local_zone_matches "$domain"; then
        echo "RECOVERED $domain after $service restart"
      else
        retry_failed_domains+=("$domain")
      fi
    done
    live_failed_domains=("${retry_failed_domains[@]}")
  fi
  systemctl is-active "$service"

  echo "Done. Checked $checked zones, updated $changed, failed $failed, live_failed ${#live_failed_domains[@]}."
  if [[ "$failed" -gt 0 ]]; then
    echo "Failed zones:"
    printf '  %s\n' "${failed_domains[@]}"
  fi
  if [[ "${#live_failed_domains[@]}" -gt 0 ]]; then
    echo "Live reload failed zones:"
    printf '  %s\n' "${live_failed_domains[@]}"
    for domain in "${live_failed_domains[@]}"; do
      local file=""
      local pair
      for pair in "${domain_files[@]}"; do
        if [[ "${pair%%=*}" == "$domain" ]]; then
          file="${pair#*=}"
          break
        fi
      done
      [[ -n "$file" ]] && print_zone_diagnostics "$domain" "$file"
    done
  fi
  if [[ "$failed" -eq 0 && "${#live_failed_domains[@]}" -eq 0 ]]; then
    save_target_state
    echo "Saved Vercel DNS target state to $STATE_FILE"
  fi
  echo "Authoritative DNS is reloaded now. External caches may still honor old TTL until they expire."
  [[ "$failed" -eq 0 && "${#live_failed_domains[@]}" -eq 0 ]]
}

main "$@"
