$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..')
docker compose down
Write-Host '[OK] Stopped' -ForegroundColor Green
