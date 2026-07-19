<#
  Mobile Signature — one-click setup.

  Installs whatever is missing, starts the server, opens a public HTTPS tunnel
  so your phone can reach it, and shows a QR code to scan.

  Run it by double-clicking setup.cmd. Leave the window open while you use the
  app; closing it stops everything.

  -LocalOnly skips the tunnel entirely: the app runs on this computer and is
  reachable only from this computer. That is what start.cmd uses.
#>

param([switch]$LocalOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$script:server = $null
$script:tunnel = $null

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Good($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    !   $text" -ForegroundColor Yellow }
function Die($text) { Write-Host ""; Write-Host "    X   $text" -ForegroundColor Red }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Have($name) {
  Refresh-Path
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Clear-Host
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host "    Mobile Signature - Setup" -ForegroundColor White
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host ""
if ($LocalOnly) {
  Say "  Running on this computer only. Nothing is exposed to"
  Say "  the internet. Run setup.cmd later to add your phone."
} else {
  Say "  This will install anything missing, start the app, and"
  Say "  show a QR code you can scan with your phone."
}

try {

  # ---------------------------------------------------------------- Node.js
  Step 1 "Checking Node.js"
  if (Have 'node') {
    Good "Node $(node --version) already installed"
  } else {
    if (-not (Have 'winget')) {
      Die "Node.js is missing and winget is unavailable."
      Say  "    Install Node 20+ from https://nodejs.org then run setup again."
      Read-Host "`n  Press Enter to close"
      exit 1
    }
    Warn "Node.js is not installed."
    Say  "    Windows will ask for permission to install it - please click Yes."
    Say  ""
    $answer = Read-Host "    Install Node.js LTS now? [Y/n]"
    if ($answer -and $answer -notmatch '^[Yy]') {
      Die "Cannot continue without Node.js."
      Read-Host "`n  Press Enter to close"
      exit 1
    }
    Say "    Installing (this takes a minute)..."
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements | Out-Null
    Refresh-Path
    if (-not (Have 'node')) {
      Die "Node.js installed but is not on PATH yet."
      Say  "    Close this window, open a new one, and run setup.cmd again."
      Read-Host "`n  Press Enter to close"
      exit 1
    }
    Good "Node $(node --version) installed"
  }

  # ----------------------------------------------------------- dependencies
  Step 2 "Installing app components"
  # npm.cmd, never npm - PowerShell's execution policy blocks npm.ps1.
  if (Test-Path (Join-Path $root 'node_modules\pdf-lib')) {
    Good "Components already installed"
  } else {
    Say "    Downloading packages..."
    & npm.cmd install --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    Good "Components installed"
  }

  # ------------------------------------------------------------------ .env
  Step 3 "Preparing configuration"
  if (-not (Test-Path (Join-Path $root '.env'))) {
    Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
    Good "Created .env"
  } else {
    Good ".env already exists"
  }

  # -------------------------------------------------------------- firewall
  Step 4 "Checking network permission"
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) {
    $ruleName = 'Mobile Signature (port 3000)'
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort 3000 -Profile Private | Out-Null
      Good "Firewall rule added for port 3000"
    } else {
      Good "Firewall rule already present"
    }
  } else {
    # Not required: the tunnel makes an OUTBOUND connection, which Windows
    # allows by default. The rule only helps same-Wi-Fi direct access.
    Good "Not needed (the tunnel connects outbound)"
  }

  # ---------------------------------------------------------------- tunnel
  Step 5 "Setting up the public link"
  $useCloudflared = $false
  if ($LocalOnly) {
    Good "Skipped - running on this computer only"
  } elseif (Have 'cloudflared') {
    Good "cloudflared already installed"
    $useCloudflared = $true
  } elseif (Have 'winget') {
    Say "    Installing cloudflared (gives your phone a clean HTTPS link)..."
    try {
      winget install --id Cloudflare.cloudflared --silent --accept-source-agreements --accept-package-agreements | Out-Null
      Refresh-Path
      if (Have 'cloudflared') { Good "cloudflared installed"; $useCloudflared = $true }
    } catch {
      Warn "cloudflared install failed - falling back to localtunnel"
    }
  }
  if (-not $useCloudflared -and -not $LocalOnly) {
    Warn "Using localtunnel instead."
    Warn "Recipients will see a one-time interstitial page before the document."
  }

  # ------------------------------------------------------------ start server
  Step 6 "Starting the app"
  New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
  $outLog = Join-Path $root 'data\server.out.log'
  $errLog = Join-Path $root 'data\server.err.log'

  function Start-Server {
    if ($script:server -and -not $script:server.HasExited) {
      Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 600
    }
    $script:server = Start-Process node -ArgumentList 'server/src/index.js' `
      -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  }

  Start-Server
  $up = $false
  foreach ($i in 1..25) {
    Start-Sleep -Milliseconds 400
    try {
      Invoke-WebRequest 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 3 | Out-Null
      $up = $true
      break
    } catch { }
  }
  if (-not $up) {
    Die "The app did not start."
    if (Test-Path $errLog) { Get-Content $errLog -Tail 20 | ForEach-Object { Say "    $_" } }
    Read-Host "`n  Press Enter to close"
    exit 1
  }
  Good "App is running on port 3000"

  # ------------------------------------------------------------ open tunnel
  $publicUrl = 'http://localhost:3000'

  if ($LocalOnly) {
    Step 7 "Finishing up"
    # Make sure signing links point at localhost, in case a previous tunnel run
    # left a dead tunnel URL behind in .env.
    $envPath = Join-Path $root '.env'
    $lines = Get-Content $envPath
    $written = $false
    $updated = foreach ($line in $lines) {
      if ($line -match '^\s*PUBLIC_URL\s*=') { "PUBLIC_URL=$publicUrl"; $written = $true }
      else { $line }
    }
    if (-not $written) { $updated += "PUBLIC_URL=$publicUrl" }
    if (($lines -join "`n") -ne ($updated -join "`n")) {
      Set-Content -Path $envPath -Value $updated -Encoding UTF8
      Start-Server
      foreach ($i in 1..25) {
        Start-Sleep -Milliseconds 400
        try { Invoke-WebRequest 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { }
      }
    }
    Good "Ready at $publicUrl"
  } else {

  Step 7 "Opening your public link"
  $tunnelLog = Join-Path $root 'data\tunnel.log'
  if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }

  if ($useCloudflared) {
    $script:tunnel = Start-Process cloudflared `
      -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate' `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput "$tunnelLog.out" -RedirectStandardError $tunnelLog
    $pattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
  } else {
    # npx.cmd, not npx - Start-Process resolves executables, not shell shims.
    $script:tunnel = Start-Process npx.cmd `
      -ArgumentList '-y', 'localtunnel', '--port', '3000' `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelLog -RedirectStandardError "$tunnelLog.err"
    $pattern = 'https://[a-z0-9-]+\.loca\.lt'
  }

  $publicUrl = $null
  Say "    Waiting for the link (up to 45 seconds)..."
  foreach ($i in 1..90) {
    Start-Sleep -Milliseconds 500
    foreach ($candidate in @($tunnelLog, "$tunnelLog.out")) {
      if (Test-Path $candidate) {
        $text = Get-Content $candidate -Raw -ErrorAction SilentlyContinue
        if ($text -and $text -match $pattern) { $publicUrl = $Matches[0]; break }
      }
    }
    if ($publicUrl) { break }
  }

  if (-not $publicUrl) {
    Warn "Could not get a public link. The app still works on this computer."
    Warn "Check your internet connection, or set PUBLIC_URL in .env manually."
    $publicUrl = 'http://localhost:3000'
  } else {
    Good "Public link: $publicUrl"

    # Bake the URL into .env so generated signing links point at the tunnel,
    # then restart so the running server picks it up.
    $envPath = Join-Path $root '.env'
    $lines = Get-Content $envPath
    $written = $false
    $updated = foreach ($line in $lines) {
      if ($line -match '^\s*PUBLIC_URL\s*=') { "PUBLIC_URL=$publicUrl"; $written = $true }
      else { $line }
    }
    if (-not $written) { $updated += "PUBLIC_URL=$publicUrl" }
    Set-Content -Path $envPath -Value $updated -Encoding UTF8

    Step 8 "Applying the link"
    Start-Server
    foreach ($i in 1..25) {
      Start-Sleep -Milliseconds 400
      try {
        Invoke-WebRequest 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 3 | Out-Null
        break
      } catch { }
    }
    Good "Ready"
  }
  } # end of the tunnel branch (skipped entirely by -LocalOnly)

  # ------------------------------------------------------------------ done
  Start-Process 'http://localhost:3000/setup'

  $apiKeyFile = Join-Path $root 'data\api-key.txt'
  $apiKey = if (Test-Path $apiKeyFile) { (Get-Content $apiKeyFile -Raw).Trim() } else { '(see .env)' }

  Write-Host ""
  Write-Host "  ============================================" -ForegroundColor Green
  Write-Host "    Ready" -ForegroundColor White
  Write-Host "  ============================================" -ForegroundColor Green
  Write-Host ""
  Say "    Your link:  $publicUrl" 'White'
  Say "    API key:    $apiKey" 'White'
  Write-Host ""
  if ($LocalOnly) {
    Say "    The app just opened in your browser. The API key is"
    Say "    already shown there - copy it, paste it into the app,"
    Say "    and you can start signing documents on this computer."
    Write-Host ""
    Say "    When you want it on your phone, close this window and"
    Say "    run setup.cmd instead."
  } else {
    Say "    A setup page just opened in your browser with a QR"
    Say "    code. Scan it with your phone's camera, then use"
    Say "    Add to Home Screen to install the app."
  }
  Write-Host ""
  Write-Host "    Keep this window open while you use the app." -ForegroundColor Yellow
  Write-Host "    Press Ctrl+C or close it to stop." -ForegroundColor Yellow
  Write-Host ""

  while ($true) {
    Start-Sleep -Seconds 2
    if ($script:server.HasExited) {
      Die "The app stopped unexpectedly."
      if (Test-Path $errLog) { Get-Content $errLog -Tail 20 | ForEach-Object { Say "    $_" } }
      break
    }
  }

} catch {
  Die $_.Exception.Message
  Read-Host "`n  Press Enter to close"
} finally {
  Write-Host ""
  Say "  Shutting down..."
  foreach ($proc in @($script:tunnel, $script:server)) {
    if ($proc -and -not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Say "  Stopped."
}
