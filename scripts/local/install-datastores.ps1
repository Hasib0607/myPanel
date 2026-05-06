param(
  [string]$Workspace = "D:\Projects\Cpanel"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell."
}

$secretsPath = Join-Path $Workspace ".local-db-secrets.json"
if (-not (Test-Path -LiteralPath $secretsPath)) {
  throw "Missing $secretsPath. Run Phase 1 secret generation first."
}

$secrets = Get-Content -Raw -LiteralPath $secretsPath | ConvertFrom-Json

choco install postgresql16 -y --params "/Password:$($secrets.postgresPassword) /Port:5432"
choco install redis -y

$psql = Get-Command psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $psql) {
  $psql = Get-ChildItem -Path "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bin\\psql\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $psql) {
  throw "Could not find psql.exe after PostgreSQL installation."
}

$postgresBin = Split-Path -Parent $psql
$env:Path = "$postgresBin;$env:Path"
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

Write-Host "PostgreSQL and Redis install complete."
Write-Host "Next: return to Codex and run Prisma migration + seed."
