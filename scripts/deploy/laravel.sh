#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?app directory required}"
cd "$APP_DIR"
composer install --no-dev --optimize-autoloader
php artisan migrate --force
php artisan config:cache
php artisan route:cache
supervisorctl reread
supervisorctl update
