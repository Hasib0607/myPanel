#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?domain required}"
USER="${2:?mailbox user required}"
MAIL_ROOT="/var/mail/vhosts/$DOMAIN/$USER"
install -d -o vmail -g vmail "$MAIL_ROOT"/{cur,new,tmp}
postmap /etc/postfix/vmailbox
systemctl reload postfix dovecot
