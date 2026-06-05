#!/usr/bin/env bash
set -Eeuo pipefail

APEX_IP="${1:-216.150.1.1}"
WWW_CNAME="${2:-c2e5a009d99b9e9a.vercel-dns-017.com.}"
WWW_CNAME="${WWW_CNAME%.}."
LIMIT="${LIMIT:-0}"

usage() {
  cat >&2 <<EOF
Usage: $0 [apex_ip] [www_cname]

Checks local BIND and public DNS for every local zone:
  @   A     ${APEX_IP}
  www CNAME ${WWW_CNAME}

Set LIMIT=10 $0 to check only the first 10 zones.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

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

dig_short() {
  local resolver="$1"
  local name="$2"
  local type="$3"
  dig "$resolver" +time=3 +tries=1 +short "$type" "$name" 2>/dev/null | sed 's/[[:space:]]*$//'
}

join_csv() {
  paste -sd ',' - | sed 's/,/, /g'
}

check_domain() {
  local domain="$1"
  local local_a local_www cf_a cf_www google_a google_www ns_records status
  local_a="$(dig_short @127.0.0.1 "$domain" A | join_csv)"
  local_www="$(dig_short @127.0.0.1 "www.$domain" CNAME | join_csv)"
  cf_a="$(dig_short @1.1.1.1 "$domain" A | join_csv)"
  cf_www="$(dig_short @1.1.1.1 "www.$domain" CNAME | join_csv)"
  google_a="$(dig_short @8.8.8.8 "$domain" A | join_csv)"
  google_www="$(dig_short @8.8.8.8 "www.$domain" CNAME | join_csv)"
  ns_records="$(dig_short @1.1.1.1 "$domain" NS | join_csv)"

  status="OK"
  if [[ "$local_a" != *"$APEX_IP"* || "$local_www" != *"$WWW_CNAME"* ]]; then
    status="LOCAL_ZONE_NOT_UPDATED"
  elif [[ "$cf_a" != *"$APEX_IP"* || "$cf_www" != *"$WWW_CNAME"* || "$google_a" != *"$APEX_IP"* || "$google_www" != *"$WWW_CNAME"* ]]; then
    status="PUBLIC_DNS_NOT_UPDATED"
  fi

  printf '%s\t%s\tlocal A=[%s] www=[%s]\tcloudflare A=[%s] www=[%s]\tgoogle A=[%s] www=[%s]\tNS=[%s]\n' \
    "$status" "$domain" "${local_a:-none}" "${local_www:-none}" "${cf_a:-none}" "${cf_www:-none}" "${google_a:-none}" "${google_www:-none}" "${ns_records:-none}"
}

main() {
  if ! command -v dig >/dev/null 2>&1; then
    echo "dig is required. Install bind-utils/dnsutils first." >&2
    exit 2
  fi

  shopt -s nullglob
  local files=(/var/named/db.* /etc/bind/zones/db.*)
  local checked=0
  local ok=0
  local local_failed=0
  local public_failed=0

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "No BIND zone files found under /var/named or /etc/bind/zones." >&2
    exit 2
  fi

  for file in "${files[@]}"; do
    local domain line status
    is_live_zone_file "$file" || continue
    domain="$(zone_domain "$file")"
    is_public_domain_zone "$domain" || continue
    if [[ "$LIMIT" =~ ^[0-9]+$ && "$LIMIT" -gt 0 && "$checked" -ge "$LIMIT" ]]; then
      break
    fi
    line="$(check_domain "$domain")"
    status="${line%%$'\t'*}"
    printf '%s\n' "$line"
    checked=$((checked + 1))
    case "$status" in
      OK) ok=$((ok + 1)) ;;
      LOCAL_ZONE_NOT_UPDATED) local_failed=$((local_failed + 1)) ;;
      PUBLIC_DNS_NOT_UPDATED) public_failed=$((public_failed + 1)) ;;
    esac
  done

  echo "Summary: checked=$checked ok=$ok local_failed=$local_failed public_failed=$public_failed"
  if [[ "$public_failed" -gt 0 ]]; then
    echo "If local is correct but public is not, Vercel cannot see this VPS because registrar nameservers/delegation are not using this BIND server, or DNS propagation/cache has not expired."
  fi
  [[ "$local_failed" -eq 0 && "$public_failed" -eq 0 ]]
}

main "$@"
