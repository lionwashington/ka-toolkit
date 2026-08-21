Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SecureLink.Automation.psm1') -Force

$expectedExe = 'C:\Program Files\SecureLink\SecureLink.exe'
$service = Get-Service -Name 'SecureLink' -ErrorAction SilentlyContinue
$processes = @(Get-Process -Name 'SecureLink' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -ieq $expectedExe } catch { $false }
})
$windows = @(Get-SecureLinkTopLevelWindows)
$windowInfo = @($windows | ForEach-Object {
    $geometry = Get-SecureLinkGeometry -Process $_
    [ordered]@{
        handle = $_.MainWindowHandle.ToInt64()
        pid = $_.Id
        width = $geometry.Width
        height = $geometry.Height
        left = $geometry.Left
        top = $geometry.Top
    }
})

$vpnState = $null
$vpnStateAt = $null
$remainingMinutes = $null
$remainingAt = $null
$renewalSuccessAt = $null
$logPath = Join-Path $env:APPDATA 'securelink\gui-log\securelink-gui-netrino.log'

if (Test-Path -LiteralPath $logPath) {
    $tail = @(Get-Content -LiteralPath $logPath -Tail 20000 -ErrorAction SilentlyContinue)
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
        $line = $tail[$i]
        $timestamp = if ($line -match '^\[([^\]]+)\]') { $Matches[1] } else { $null }

        if ($null -eq $vpnState -and $line -match 'update vpn state:\s*([A-Za-z_-]+)') {
            $vpnState = $Matches[1].ToLowerInvariant()
            $vpnStateAt = $timestamp
        }
        if ($null -eq $remainingMinutes -and $line -match 'Force disconnect remain time:\s*(\d+)min') {
            $remainingMinutes = [int]$Matches[1]
            $remainingAt = $timestamp
        }
        if ($null -eq $renewalSuccessAt -and
            ($line -match 'RENEW_VALIDITY_PERIOD_SUCCESS' -or
             $line -match 'Renewal successful, connection duration has been updated')) {
            $renewalSuccessAt = $timestamp
        }
        if ($null -ne $vpnState -and $null -ne $remainingMinutes -and $null -ne $renewalSuccessAt) {
            break
        }
    }
}

[ordered]@{
    service = if ($null -eq $service) { 'missing' } else { $service.Status.ToString().ToLowerInvariant() }
    processCount = $processes.Count
    visibleWindowCount = $windows.Count
    visibleWindows = $windowInfo
    vpnState = $vpnState
    vpnStateObservedAt = $vpnStateAt
    remainingMinutes = $remainingMinutes
    remainingObservedAt = $remainingAt
    renewalSuccessObservedAt = $renewalSuccessAt
} | ConvertTo-Json -Compress
