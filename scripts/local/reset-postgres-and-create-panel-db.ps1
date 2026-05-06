param(
  [string]$Workspace = "D:\Projects\Cpanel",
  [string]$ServiceName = "postgresql-x64-18",
  [string]$DataDir = "C:\Program Files\PostgreSQL\18\data"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell."
}

$secretsPath = Join-Path $Workspace ".local-db-secrets.json"
if (-not (Test-Path -LiteralPath $secretsPath)) {
  throw "Missing $secretsPath."
}

$secrets = Get-Content -Raw -LiteralPath $secretsPath | ConvertFrom-Json
$psql = Get-ChildItem -Path "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\bin\\psql\.exe$" } |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $psql) {
  throw "Could not find psql.exe."
}

$hbaPath = Join-Path $DataDir "pg_hba.conf"
if (-not (Test-Path -LiteralPath $hbaPath)) {
  throw "Could not find pg_hba.conf at $hbaPath."
}

$backupPath = "$hbaPath.codex-backup-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $hbaPath -Destination $backupPath

try {
  $trustConfig = @"
# Temporary local trust config created by Codex setup script.
host all all 127.0.0.1/32 trust
host all all ::1/128 trust
local all all trust
"@
  Set-Content -LiteralPath $hbaPath -Value $trustConfig -Encoding ASCII
  Restart-Service -Name $ServiceName
  Start-Sleep -Seconds 3

  $resetSql = "ALTER USER postgres WITH PASSWORD '$($secrets.postgresPassword)';"
  $resetSql | & $psql -U postgres -h localhost -p 5432 -d postgres
}
finally {
  Copy-Item -LiteralPath $backupPath -Destination $hbaPath -Force
  Restart-Service -Name $ServiceName
  Start-Sleep -Seconds 3
}

$env:PGPASSWORD = $secrets.postgresPassword

$createSql = @"
DO
`$do`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'panel_user') THEN
    CREATE ROLE panel_user LOGIN PASSWORD '$($secrets.panelDbPassword)';
  ELSE
    ALTER ROLE panel_user WITH LOGIN PASSWORD '$($secrets.panelDbPassword)';
  END IF;
END
`$do`$;

SELECT 'CREATE DATABASE panel_main OWNER panel_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'panel_main')\gexec

GRANT ALL PRIVILEGES ON DATABASE panel_main TO panel_user;
"@

$createSql | & $psql -U postgres -h localhost -p 5432 -d postgres

Write-Host "PostgreSQL password reset and panel database setup complete."
