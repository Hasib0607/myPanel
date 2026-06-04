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

## GitHub Auto Deploy Safety Poller

Auto deploy does not depend only on GitHub webhook delivery. Guardian also runs a polling fallback for deployments where `autoDeployEnabled=true`, `sourceProvider=GITHUB`, and a GitHub owner/repo/branch are configured.

- Default interval: `GUARDIAN_AUTO_DEPLOY_POLL_INTERVAL_MS=60000`.
- Disable only if needed: `GUARDIAN_AUTO_DEPLOY_POLL_ENABLED=false`.
- Account deployments use `github:account:<accountId>:token`; superadmin deployments use `github:superadmin:token`.
- If the GitHub webhook is missing, blocked by token permissions, or GitHub delivery is delayed, the poller compares the remote branch head SHA with the latest deployed/queued release and queues a deploy when the branch moved.
- Duplicate deploys are avoided while a deployment or release is already queued/running/building.
- Private repositories still need a connected GitHub token with repository read access.
