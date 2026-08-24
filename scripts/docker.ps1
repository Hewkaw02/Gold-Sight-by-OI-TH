param(
  [ValidateSet('dashboard', 'scheduler', 'refresh', 'live-oi', 'logs', 'status', 'down')]
  [string]$Action = 'dashboard'
)

$ErrorActionPreference = 'Stop'
$dashboardPort = if ($env:DASHBOARD_PORT) {
  $env:DASHBOARD_PORT
} elseif (Test-Path .env) {
  $dashboardLine = Get-Content .env | Where-Object { $_ -match '^\s*DASHBOARD_PORT\s*=' } | Select-Object -First 1
  if ($dashboardLine -and $dashboardLine -match '^\s*DASHBOARD_PORT\s*=\s*(.+?)\s*$') { $matches[1].Trim() } else { '8080' }
} else {
  '8080'
}

function Invoke-ManualCollector {
  param(
    [bool]$LiveOi
  )

  $schedulerId = (docker compose ps --status running -q scheduler | Out-String).Trim()
  if ($schedulerId) {
    docker compose stop scheduler | Out-Null
  }

  try {
    if ($LiveOi) {
      docker compose --profile collector run --rm -e RUN_LIVE_OI=true collector
    } else {
      docker compose --profile collector run --rm -e RUN_LIVE_OI=false collector
    }
  } finally {
    if ($schedulerId) {
      docker compose start scheduler | Out-Null
    }
  }
}

switch ($Action) {
  'dashboard' {
    docker compose up -d --build dashboard scheduler
    Write-Host "Dashboard: http://localhost:$dashboardPort"
  }
  'scheduler' {
    docker compose up -d --build scheduler
    Write-Host "Scheduler container started. Use 'status' to inspect it."
  }
  'refresh' {
    docker compose up -d --build dashboard
    Invoke-ManualCollector -LiveOi:$false
    Write-Host "Price/data refresh completed. Dashboard: http://localhost:$dashboardPort"
  }
  'live-oi' {
    docker compose up -d --build dashboard
    Invoke-ManualCollector -LiveOi:$true
    Write-Host "Live OI collection completed. Dashboard: http://localhost:$dashboardPort"
  }
  'logs' {
    docker compose logs -f dashboard
  }
  'status' {
    docker compose ps
    Invoke-WebRequest -UseBasicParsing "http://localhost:$dashboardPort/healthz" | Select-Object StatusCode, Content
  }
  'down' {
    docker compose down
  }
}
