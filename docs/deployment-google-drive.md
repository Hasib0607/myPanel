# Laravel Google Drive Deployment Notes

When a Laravel deployment has Google Drive environment keys, the deploy worker treats it as a Google Drive enabled app.

Detected keys include:

- `GOOGLE_DRIVE_*`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT`
- `GOOGLE_REDIRECT_URI`

Deploy behavior:

- Composer platform requirements still run first, so PHP `curl`, `zip`, `mbstring`, `openssl`, and related extensions are validated by Composer.
- Env-driven runtime preflight also checks PHP `curl`, `zip`, `mbstring`, and `sodium`.
- If `composer.json` or `composer.lock` already contains a Google Drive/client package, the deployer only logs that Google Drive support was detected.
- If no Google package is declared, the deployer installs `google/apiclient:^2.15` with Composer on the server.
- Laravel cache is cleared after env sync and again after the Google dependency install.

Common Composer package variants used by Laravel apps:

- `google/apiclient`
- `google/apiclient-services`
- `masbug/flysystem-google-drive-ext`
- `nao-pon/flysystem-google-drive`
- project-specific packages containing `google-drive-adapter`

Application code still needs to read the configured env keys and register its Drive backup adapter. The deployer supplies runtime support; it does not create app-specific backup routes or Google OAuth logic.
