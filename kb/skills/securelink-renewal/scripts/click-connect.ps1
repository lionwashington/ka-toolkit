param(
    [Parameter(Mandatory = $true)] [long] $WindowHandle,
    [Parameter(Mandatory = $true)] [int] $X,
    [Parameter(Mandatory = $true)] [int] $Y,
    [Parameter(Mandatory = $true)] [int] $ExpectedWidth,
    [Parameter(Mandatory = $true)] [int] $ExpectedHeight,
    [ValidateSet('disconnect', 'connect')] [string] $ExpectedAction,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SecureLink.Automation.psm1') -Force

$process = Get-SecureLinkWindowByHandle -WindowHandle $WindowHandle
$geometry = Get-SecureLinkGeometry -Process $process
Assert-SecureLinkGeometry -Geometry $geometry -ExpectedWidth $ExpectedWidth -ExpectedHeight $ExpectedHeight
Assert-RelativePoint -Geometry $geometry -X $X -Y $Y

if ($DryRun) {
    "SECURELINK_$($ExpectedAction.ToUpperInvariant())_CLICK_VALIDATED_NO_CLICK"
    exit 0
}

Invoke-SecureLinkClick -Process $process -Geometry $geometry -X $X -Y $Y
"SECURELINK_$($ExpectedAction.ToUpperInvariant())_CLICK_SENT_ONCE"
