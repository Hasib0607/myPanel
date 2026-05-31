#!/usr/bin/env bash
# Shared OS detection for install and maintenance scripts.

detect_os_id() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    printf '%s' "${ID,,}"
    return 0
  fi
  printf '%s' "unknown"
}

is_almalinux_or_rhel() {
  local id
  id="$(detect_os_id)"
  [[ "$id" == "almalinux" || "$id" == "rocky" || "$id" == "rhel" || "$id" == "centos" ]]
}

detect_redis_service() {
  if is_almalinux_or_rhel; then
    printf '%s' "redis"
  else
    printf '%s' "redis-server"
  fi
}

detect_bind_service() {
  if is_almalinux_or_rhel; then
    printf '%s' "named"
  else
    printf '%s' "bind9"
  fi
}

detect_web_group() {
  if is_almalinux_or_rhel; then
    printf '%s' "nginx"
  else
    printf '%s' "www-data"
  fi
}

default_nginx_sites_available() {
  if is_almalinux_or_rhel; then
    printf '%s' "/etc/nginx/sites-available"
  else
    printf '%s' "/etc/nginx/sites-available"
  fi
}

default_nginx_sites_enabled() {
  printf '%s' "/etc/nginx/sites-enabled"
}
