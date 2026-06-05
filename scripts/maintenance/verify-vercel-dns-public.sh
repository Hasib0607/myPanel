#!/usr/bin/env bash
set -Eeuo pipefail

STATE_FILE="${VERCEL_DNS_STATE_FILE:-/var/lib/vps-panel/vercel-dns-target.env}"
DEFAULT_APEX_IP="${DEFAULT_APEX_IP:-216.150.1.1}"
DEFAULT_WWW_CNAME="${DEFAULT_WWW_CNAME:-c2e5a009d99b9e9a.vercel-dns-017.com.}"
EXCLUDED_DOMAINS="${EXCLUDED_DOMAINS:-ebitans.com admin.ebitans.com}"
LIMIT="${LIMIT:-0}"

state_value() {
  local key="$1"
  [[ -r "$STATE_FILE" ]] || return 0
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$STATE_FILE"
}

STATE_APEX_IP="$(state_value APEX_IP)"
STATE_WWW_CNAME="$(state_value WWW_CNAME)"
APEX_IP="${1:-${APEX_IP:-${STATE_APEX_IP:-}}}"
WWW_CNAME="${2:-${WWW_CNAME:-${STATE_WWW_CNAME:-}}}"

usage() {
  local usage_apex="${APEX_IP:-${STATE_APEX_IP:-$DEFAULT_APEX_IP}}"
  local usage_www="${WWW_CNAME:-${STATE_WWW_CNAME:-$DEFAULT_WWW_CNAME}}"
  usage_www="${usage_www%.}."
  cat >&2 <<EOF
Usage: $0 [apex_ip] [www_cname]

Checks local BIND and public DNS for every local zone:
  @   A     ${usage_apex}
  www CNAME ${usage_www}

Set LIMIT=10 $0 to check only the first 10 zones.
Excluded domains: $EXCLUDED_DOMAINS
If arguments are omitted, expected values come from environment variables,
then $STATE_FILE, then script defaults.
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
}

is_excluded_domain() {
  local domain="${1%.}"
  local excluded
  for excluded in $EXCLUDED_DOMAINS; do
    [[ "$domain" == "${excluded%.}" ]] && return 0
  done
  return 1
}

dig_short() {
  local resolver="$1"
  local name="$2"
  local type="$3"
  dig "$resolver" +time=3 +tries=1 +short "$type" "$name" 2>/dev/null | sed 's/[[:space:]]*$//'
}

infer_local_target() {
  local file domain inferred_a inferred_www
  for file in "$@"; do
    is_live_zone_file "$file" || continue
    domain="$(zone_domain "$file")"
    is_public_domain_zone "$domain" || continue
    is_excluded_domain "$domain" && continue
    inferred_a="$(dig_short @127.0.0.1 "$domain" A | head -n 1)"
    inferred_www="$(dig_short @127.0.0.1 "www.$domain" CNAME | head -n 1)"
    if [[ -n "$inferred_a" && -n "$inferred_www" ]]; then
      printf '%s\t%s\n' "$inferred_a" "$inferred_www"
      return 0
    fi
  done
  return 1
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
  local inferred=""
  local checked=0
  local ok=0
  local local_failed=0
  local public_failed=0

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "No BIND zone files found under /var/named or /etc/bind/zones." >&2
    exit 2
  fi

  if [[ -z "$APEX_IP" || -z "$WWW_CNAME" ]]; then
    inferred="$(infer_local_target "${files[@]}" || true)"
    if [[ -n "$inferred" ]]; then
      APEX_IP="${APEX_IP:-${inferred%%$'\t'*}}"
      WWW_CNAME="${WWW_CNAME:-${inferred#*$'\t'}}"
    fi
  fi
  APEX_IP="${APEX_IP:-$DEFAULT_APEX_IP}"
  WWW_CNAME="${WWW_CNAME:-$DEFAULT_WWW_CNAME}"
  WWW_CNAME="${WWW_CNAME%.}."
  echo "Expected target: @ A ${APEX_IP}, www CNAME ${WWW_CNAME}"

  for file in "${files[@]}"; do
    local domain line status
    is_live_zone_file "$file" || continue
    domain="$(zone_domain "$file")"
    is_public_domain_zone "$domain" || continue
    is_excluded_domain "$domain" && continue
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
