# Env-Driven Deployment Runtime Installs

The deploy worker scans Laravel env values after env normalization and before dependency install. When a known feature is configured, the same Guardian/Deployment Doctor runtime-tool installer is used.

Detected env patterns:

- Redis cache/session/queue: `CACHE_DRIVER=redis`, `CACHE_STORE=redis`, `SESSION_DRIVER=redis`, `QUEUE_CONNECTION=redis`, `REDIS_CLIENT=phpredis`, `REDIS_HOST`, or `REDIS_URL`
- Laravel Octane Swoole: `OCTANE_SERVER=swoole` or `OCTANE_SERVER=openswoole`
- Sendmail transport: `MAIL_MAILER=sendmail`
- Google Drive: `GOOGLE_DRIVE_*`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT`, or `GOOGLE_REDIRECT_URI`
- MySQL/PostgreSQL: `DB_CONNECTION=mysql`, `mariadb`, `pgsql`, `postgres`, or `postgresql`
- Payment gateways: env keys containing `PAY`, `BKASH`, `NAGAD`, `AMARPAY`, `SSLCZ`, or `PAYPAL`

Runtime packages/extensions installed or queued:

- Redis: `redis-server`/`redis`, `redis-cli`, PHP `redis`/`phpredis`
- Octane Swoole: PHP `swoole` or `openswoole`; distro package is tried first, then PECL fallback
- Sendmail: `postfix`, which provides a sendmail-compatible transport on most Linux distributions
- Google Drive: PHP `curl`, `zip`, `mbstring`, `sodium`; Composer Google client support is handled separately
- Database: PHP MySQL/PDO or PostgreSQL/PDO extensions
- Payments: PHP `bcmath`, `curl`, and `intl`

If auto-install cannot finish, Deployment Doctor creates a pending approval with the exact package/tool that needs installation. Approve it, then redeploy.
