#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?domain required}"
mkdir -p "/etc/opendkim/keys/$DOMAIN"
opendkim-genkey -b 2048 -d "$DOMAIN" -D "/etc/opendkim/keys/$DOMAIN" -s mail
chown -R opendkim:opendkim "/etc/opendkim/keys/$DOMAIN"
systemctl reload opendkim
