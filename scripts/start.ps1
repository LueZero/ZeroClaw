# Start ZeroClaw Platform via docker compose (PowerShell 5.1+)
# NOTE: docker CLI writes progress to stderr; we deliberately keep
# ErrorActionPreference at the default ('Continue') so those bytes do not
# terminate the script. Errors are detected via $LASTEXITCODE.
$ErrorActionPreference = 'Continue'

function Assert-LastExit {
  param([string]$Step)
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Step failed (exit $LASTEXITCODE): $Step"
    exit $LASTEXITCODE
  }
}

Set-Location -Path (Join-Path $PSScriptRoot '..')

if (-not (Test-Path '.env')) {
  Write-Warning '.env not found; using defaults'
}

# Check Docker daemon
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Error 'Docker Desktop is not running. Please start Docker Desktop first.'
  exit 1
}

# Ensure network exists (idempotent)
$net = docker network ls --filter "name=^zeroclaw-net$" --format "{{.Name}}"
if (-not $net) {
  docker network create zeroclaw-net | Out-Null
  Assert-LastExit 'docker network create zeroclaw-net'
}

docker compose --profile build build agent-base-opencode-build agent-base-copilot-build
Assert-LastExit 'docker compose build agent-base-*'

docker compose build api-server web-app
Assert-LastExit 'docker compose build api-server web-app'

docker compose up -d api-server web-app
Assert-LastExit 'docker compose up -d'

Write-Host ''
Write-Host '[OK] ZeroClaw started' -ForegroundColor Green
Write-Host '   Web: http://localhost:5173'
Write-Host '   API: http://localhost:3000/healthz'
