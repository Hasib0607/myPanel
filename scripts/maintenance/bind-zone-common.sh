#!/usr/bin/env bash
# Shared BIND helpers for vps-panel maintenance scripts.

bind_service() {
  if systemctl list-unit-files named.service >/dev/null 2>&1; then
    printf 'named'
  else
    printf 'bind9'
  fi
}

named_main_conf() {
  if [[ -f /etc/named.conf || -d /var/named ]]; then
    printf '/etc/named.conf'
  else
    printf '/etc/bind/named.conf'
  fi
}

zones_include_file() {
  if [[ -f /etc/named.conf || -d /var/named ]]; then
    printf '/etc/named.vps-panel.zones'
  else
    printf '/etc/bind/named.conf.local'
  fi
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
}

is_excluded_domain() {
  local domain="${1%.}"
  local excluded
  for excluded in ${EXCLUDED_DOMAINS:-}; do
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

zone_declaration_file_path() {
  local file="$1"
  if [[ "$file" == /var/named/* ]]; then
    basename "$file"
    return 0
  fi
  printf '%s' "$file"
}

local_dns_resolver() {
  local probe_domain="${1:-localhost}"
  if dig_short @127.0.0.1 "$probe_domain" SOA | grep -q .; then
    printf '127.0.0.1'
    return 0
  fi
  if dig_short @127.0.0.1 "$probe_domain" A | grep -q .; then
    printf '127.0.0.1'
    return 0
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]] && dig_short @"$ip" "$probe_domain" SOA | grep -q .; then
    printf '%s' "$ip"
    return 0
  fi
  if [[ -n "$ip" ]] && dig_short @"$ip" "$probe_domain" A | grep -q .; then
    printf '%s' "$ip"
    return 0
  fi
  printf '127.0.0.1'
}

ensure_named_include() {
  local main_conf="$1"
  local include_file="$2"
  local stamp="${3:-$(date +%Y%m%d%H%M%S)}"
  local include_line="include \"$include_file\";"
  [[ -f "$main_conf" ]] || return 0
  if ! grep -Fq "$include_line" "$main_conf"; then
    cp -a "$main_conf" "$main_conf.vps-panel-$stamp.bak"
    printf '\n%s\n' "$include_line" >> "$main_conf"
    echo "ADDED include $include_file to $main_conf"
  fi
}

ensure_named_listen_any() {
  local main_conf="$1"
  local stamp="${2:-$(date +%Y%m%d%H%M%S)}"
  [[ -f "$main_conf" ]] || return 0
  if grep -Eq 'listen-on([^;]*\{[^}]*\bany\b|[^;]*\bany\b)' "$main_conf"; then
    return 0
  fi
  cp -a "$main_conf" "$main_conf.listen-$stamp.bak"
  if grep -q '^[[:space:]]*options[[:space:]]*{' "$main_conf"; then
    awk '
      BEGIN { inserted = 0 }
      /^[[:space:]]*options[[:space:]]*\{/ && !inserted {
        print $0
        print "    listen-on port 53 { any; };"
        print "    listen-on-v6 port 53 { any; };"
        inserted = 1
        next
      }
      { print }
    ' "$main_conf" > "$main_conf.vps-panel-listen.tmp"
    mv "$main_conf.vps-panel-listen.tmp" "$main_conf"
    echo "PATCHED $main_conf listen-on to any"
    return 0
  fi
  printf '\noptions {\n    listen-on port 53 { any; };\n    listen-on-v6 port 53 { any; };\n    allow-query { any; };\n    recursion no;\n};\n' >> "$main_conf"
  echo "APPENDED options listen-on any to $main_conf"
}

rebuild_vps_panel_zones() {
  local include_file="$1"
  shift
  local stamp="${REBUILD_STAMP:-$(date +%Y%m%d%H%M%S)}"
  local files=("$@")
  local tmp domain bind_file
  tmp="$(mktemp)"
  install -d -m 0755 "$(dirname "$include_file")"
  {
    echo "// Managed by vps-panel. Rebuilt $(date -Iseconds)"
    for file in "${files[@]}"; do
      is_live_zone_file "$file" || continue
      domain="$(zone_domain "$file")"
      is_public_domain_zone "$domain" || continue
      bind_file="$(zone_declaration_file_path "$file")"
      printf '\nzone "%s" {\n' "$domain"
      printf '    type master;\n'
      printf '    file "%s";\n' "$bind_file"
      printf '    allow-transfer { none; };\n'
      printf '};\n'
    done
  } > "$tmp"
  if [[ -f "$include_file" ]] && cmp -s "$include_file" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi
  if [[ -f "$include_file" ]]; then
    cp -a "$include_file" "$include_file.vps-panel-$stamp.bak"
  fi
  mv "$tmp" "$include_file"
  echo "REBUILT $include_file with ${#files[@]} zone file(s)"
}

reload_bind_service() {
  local service="$1"
  rndc reconfig 2>/dev/null || true
  rndc reload 2>/dev/null || systemctl reload "$service" 2>/dev/null || true
}

restart_bind_service() {
  local service="$1"
  rndc flush 2>/dev/null || true
  systemctl restart "$service"
  rndc flush 2>/dev/null || true
}

zone_loaded_in_bind() {
  local domain="$1"
  rndc zonestatus "$domain" 2>/dev/null | grep -q 'type: master'
}

local_zone_matches_target() {
  local domain="$1"
  local apex_ip="$2"
  local www_cname="$3"
  local resolver probe_a probe_www
  resolver="$(local_dns_resolver "$domain")"
  probe_a="$(dig_short @"$resolver" "$domain" A)"
  probe_www="$(dig_short @"$resolver" "www.$domain" CNAME)"
  [[ "$probe_a" == *"$apex_ip"* && "$probe_www" == *"$www_cname"* ]]
}

print_zone_diagnostics() {
  local domain="$1"
  local file="$2"
  local resolver
  resolver="$(local_dns_resolver "$domain")"
  echo "DIAG $domain: file=$file resolver=@$resolver" >&2
  grep -nE '(^|[[:space:]])(@|www)([[:space:]]|$)|216\.150\.1\.1|c2e5a009d99b9e9a' "$file" >&2 || true
  rndc zonestatus "$domain" >&2 || true
  named-checkzone "$domain" "$file" >&2 || true
  dig @"$resolver" "$domain" SOA +noall +answer >&2 || true
  dig @"$resolver" "$domain" A +noall +answer >&2 || true
  dig @"$resolver" "www.$domain" CNAME +noall +answer >&2 || true
}

collect_live_zone_files() {
  shopt -s nullglob
  local files=(/var/named/db.* /etc/bind/zones/db.*)
  local file domain
  for file in "${files[@]}"; do
    is_live_zone_file "$file" || continue
    domain="$(zone_domain "$file")"
    is_public_domain_zone "$domain" || continue
    printf '%s\n' "$file"
  done
}
