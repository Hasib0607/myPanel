# Laravel Managed Processes

myPanel manages production Laravel background processes through Supervisor. Configuration is stored in `Deployment.processConfig`, so no database migration is required.

## Supported processes

- Default queue worker pool: `processConfig.laravelWorkers`
- Independent queue groups: `processConfig.laravelManagedProcesses.queueGroups`
- Scheduler: `php artisan schedule:work`
- Horizon: `php artisan horizon`
- Reverb: `php artisan reverb:start --host=127.0.0.1`
- Octane: replaces the main Laravel start command with `php artisan octane:start`

Deploy and restart actions issue `php artisan queue:restart` and `php artisan horizon:terminate` before restarting managed processes. Failures from those graceful signals are logged as warnings and do not hide the actual deployment result.

## Automatic detection

- `OCTANE_SERVER=swoole` or `OCTANE_SERVER=openswoole` enables Octane and selects that server.
- `SCHEDULER_ENABLED=true` enables the scheduler process.
- `HORIZON_ENABLED=true` enables Horizon.
- `REVERB_APP_ID`, `REVERB_HOST`, or `BROADCAST_CONNECTION=reverb` enables Reverb.
- Runtime review still requires approval before installing missing Swoole/OpenSwoole or Redis packages.
- Deploy/start/restart actions never install missing runtime packages silently. The panel shows a review modal, and the API blocks queueing until all required selected installs succeed.
- Swoole/OpenSwoole requires PHP 8.2 or newer. When an older PHP CLI is detected, runtime review includes the PHP 8.2 switch before the Swoole extension install.

## Queue autoscaling

Guardian checks the actual Laravel Redis ready, delayed, and reserved queue lengths when `QUEUE_CONNECTION=redis`. It scales configured worker pools within their minimum and maximum limits. If Redis cannot be reached, the legacy worker pool falls back to deployment health and recent log pressure.

Configure features from Deployment Settings under:

- **Laravel Queue Workers** for the backward-compatible default worker pool.
- **Laravel Managed Processes** for Scheduler, Horizon, Reverb, Octane, and independent queue groups.

Account-panel API routes are also available:

- `GET/PATCH /account/deployments/:deploymentId/workers`
- `GET/PATCH /account/deployments/:deploymentId/laravel-processes`
