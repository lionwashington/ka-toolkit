# claude-loop.ps1 — Auto-restart loop for Claude Code (Windows)
#
# Monitors ~/.knowledge-assistant/state/sessions/ for restart flags.
# Usage: Start-Process powershell -ArgumentList "-File claude-loop.ps1"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SessionMgr = Join-Path $ScriptDir "session-manager.mjs"
$SessionsDir = Join-Path $env:USERPROFILE ".knowledge-assistant\state\sessions"

Write-Host "[loop] Claude Code auto-restart loop started at $(Get-Date -Format o)"
Write-Host "[loop] Monitoring: $SessionsDir"
Write-Host "[loop] Press Ctrl+C to stop"
Write-Host ""

New-Item -ItemType Directory -Force -Path $SessionsDir | Out-Null

while ($true) {
    $found = $false

    Get-ChildItem -Path $SessionsDir -Filter "*.json" -ErrorAction SilentlyContinue | ForEach-Object {
        $data = Get-Content $_.FullName | ConvertFrom-Json

        if ($data.restart -eq $true) {
            $found = $true
            Write-Host "[loop] =========================================="
            Write-Host "[loop] Restarting session: $($data.sessionId)"
            Write-Host "[loop] CWD: $($data.cwd)"
            Write-Host "[loop] CMD: $($data.cmdline)"
            Write-Host "[loop] =========================================="

            # Clear restart flag
            node $SessionMgr clear $data.sessionId

            # Change directory and execute
            Set-Location -Path $data.cwd -ErrorAction SilentlyContinue
            Invoke-Expression $data.cmdline

            Write-Host ""
            Write-Host "[loop] Claude exited at $(Get-Date -Format o)"
            Write-Host "[loop] Waiting for next restart signal..."
            Write-Host ""
        }
    }

    if (-not $found) {
        Start-Sleep -Seconds 2
    }
}
