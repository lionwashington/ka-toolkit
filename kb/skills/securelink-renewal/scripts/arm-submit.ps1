param(
    [Parameter(Mandatory = $true)] [long] $WindowHandle,
    [Parameter(Mandatory = $true)] [string] $VerifiedCapturePath,
    [Parameter(Mandatory = $true)] [int] $InputLeft,
    [Parameter(Mandatory = $true)] [int] $InputTop,
    [Parameter(Mandatory = $true)] [int] $InputWidth,
    [Parameter(Mandatory = $true)] [int] $InputHeight,
    [Parameter(Mandatory = $true)] [int] $InputX,
    [Parameter(Mandatory = $true)] [int] $InputY,
    [Parameter(Mandatory = $true)] [int] $SubmitX,
    [Parameter(Mandatory = $true)] [int] $SubmitY,
    [Parameter(Mandatory = $true)] [int] $ExpectedWidth,
    [Parameter(Mandatory = $true)] [int] $ExpectedHeight,
    [ValidateRange(10, 90)] [int] $MaxWaitSeconds = 45,
    [ValidatePattern('^[A-Fa-f0-9]{64}$')] [string] $ExpectedFingerprint,
    [ValidatePattern('^[A-Fa-f0-9]{64}$')] [string] $ExpectedMaskedFingerprint,
    [switch] $InputReady,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SecureLink.Automation.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'SecureLink.ContentLock.psm1') -Force
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Test-CurrentTarget {
    $targetProcess = Get-SecureLinkWindowByHandle -WindowHandle $WindowHandle
    $targetGeometry = Get-SecureLinkGeometry -Process $targetProcess
    Assert-SecureLinkGeometry -Geometry $targetGeometry -ExpectedWidth $ExpectedWidth -ExpectedHeight $ExpectedHeight
    Assert-RelativePoint -Geometry $targetGeometry -X $InputX -Y $InputY
    Assert-RelativePoint -Geometry $targetGeometry -X $SubmitX -Y $SubmitY
    [pscustomobject]@{ Process = $targetProcess; Geometry = $targetGeometry }
}

function Get-InputChangeRectangle {
    param([Parameter(Mandatory = $true)] $Geometry)

    if ($InputLeft -lt 0 -or $InputTop -lt 0 -or $InputWidth -lt 1 -or $InputHeight -lt 1 -or
        ($InputLeft + $InputWidth) -gt $Geometry.Width -or
        ($InputTop + $InputHeight) -gt $Geometry.Height) {
        throw 'The verified input-change rectangle is outside the SecureLink window.'
    }
    if ($InputWidth -gt [int]($Geometry.Width * 0.6) -or
        $InputHeight -gt [int]($Geometry.Height * 0.25)) {
        throw 'The input-change rectangle is too broad to preserve page-safety content.'
    }
    if ($InputX -lt $InputLeft -or $InputX -ge ($InputLeft + $InputWidth) -or
        $InputY -lt $InputTop -or $InputY -ge ($InputTop + $InputHeight)) {
        throw 'The input click is not inside the visually verified input-change rectangle.'
    }
    if ($SubmitX -ge $InputLeft -and $SubmitX -lt ($InputLeft + $InputWidth) -and
        $SubmitY -ge $InputTop -and $SubmitY -lt ($InputTop + $InputHeight)) {
        throw 'The Continue control must not be inside the input-change rectangle.'
    }
    [Drawing.Rectangle]::new($InputLeft, $InputTop, $InputWidth, $InputHeight)
}

function New-LiveBitmap {
    param([Parameter(Mandatory = $true)] $Target)

    $bitmap = [Drawing.Bitmap]::new(
        $Target.Geometry.Width,
        $Target.Geometry.Height,
        [Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = $null
    $windowDc = [IntPtr]::Zero
    try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $windowDc = $graphics.GetHdc()
        if (-not [SecureLinkNative]::PrintWindow($Target.Process.MainWindowHandle, $windowDc, 2)) {
            throw 'Could not capture the verified challenge for an in-memory content check.'
        }
        $graphics.ReleaseHdc($windowDc)
        $windowDc = [IntPtr]::Zero
        $graphics.Dispose()
        $graphics = $null
        return $bitmap
    } catch {
        $bitmap.Dispose()
        throw
    } finally {
        if ($windowDc -ne [IntPtr]::Zero -and $null -ne $graphics) { $graphics.ReleaseHdc($windowDc) }
        if ($null -ne $graphics) { $graphics.Dispose() }
    }
}

function Get-CurrentFingerprints {
    param([Parameter(Mandatory = $true)] $Target)

    $inputRectangle = Get-InputChangeRectangle -Geometry $Target.Geometry
    $bitmap = New-LiveBitmap -Target $Target
    try {
        [pscustomobject]@{
            Full = Get-SecureLinkBitmapFingerprint -Bitmap $bitmap
            OutsideInput = Get-SecureLinkBitmapFingerprint -Bitmap $bitmap -ExcludedRectangle $inputRectangle
        }
    } finally {
        $bitmap.Dispose()
    }
}

$target = Test-CurrentTarget
$inputRectangle = Get-InputChangeRectangle -Geometry $target.Geometry
if ($DryRun) {
    $verifiedBitmap = New-SecureLinkNormalizedBitmap -Path $VerifiedCapturePath
    try {
        if ($verifiedBitmap.Width -ne $ExpectedWidth -or $verifiedBitmap.Height -ne $ExpectedHeight) {
            throw 'The visually verified capture dimensions do not match the target geometry.'
        }
        $verifiedFull = Get-SecureLinkBitmapFingerprint -Bitmap $verifiedBitmap
        $verifiedMasked = Get-SecureLinkBitmapFingerprint -Bitmap $verifiedBitmap -ExcludedRectangle $inputRectangle
    } finally {
        $verifiedBitmap.Dispose()
    }
    $current = Get-CurrentFingerprints -Target $target
    if ($current.Full -cne $verifiedFull) {
        throw 'SecureLink changed after the supplied capture was visually verified; no input or click was sent.'
    }
    'SECURELINK_SUBMITTER_VALIDATED_NO_INPUT_NO_CLICK'
    "SECURELINK_CHALLENGE_FINGERPRINT=$verifiedFull"
    "SECURELINK_MASKED_CHALLENGE_FINGERPRINT=$verifiedMasked"
    exit 0
}

if (-not $ExpectedFingerprint -or -not $ExpectedMaskedFingerprint) {
    throw 'Preflight challenge fingerprints are required; no input or click was sent.'
}

if (-not $InputReady) {
    [Console]::Out.WriteLine('SECURELINK_SUBMITTER_ARMED')
    [Console]::Out.Flush()
}

$readTask = [Console]::In.ReadLineAsync()
if (-not $readTask.Wait($MaxWaitSeconds * 1000)) {
    throw 'Timed out without a code; no input or click was sent.'
}

$line = $readTask.Result
if ($line -notmatch '^[0-9]{6}$') {
    $line = $null
    throw 'Input was not exactly six ASCII digits; no input or click was sent.'
}

$digits = $line.ToCharArray()
$line = $null
try {
    # Before any digit or click, exact full-window pixels must still match the
    # capture the operator visually approved.
    $target = Test-CurrentTarget
    $beforeInput = Get-CurrentFingerprints -Target $target
    if ($beforeInput.Full -cne $ExpectedFingerprint.ToUpperInvariant()) {
        throw 'SecureLink challenge content changed after preflight; no input or click was sent.'
    }

    Invoke-SecureLinkClick -Process $target.Process -Geometry $target.Geometry -X $InputX -Y $InputY
    Start-Sleep -Milliseconds 80
    foreach ($digit in $digits) {
        [Windows.Forms.SendKeys]::SendWait([string]$digit)
        Start-Sleep -Milliseconds 18
    }
    Start-Sleep -Milliseconds 60

    # Digits and focus styling may alter only the explicitly bounded input
    # rectangle. Recheck every other pixel before the one allowed Continue click.
    $target = Test-CurrentTarget
    $beforeSubmit = Get-CurrentFingerprints -Target $target
    if ($beforeSubmit.OutsideInput -cne $ExpectedMaskedFingerprint.ToUpperInvariant()) {
        throw 'SecureLink changed outside the verified TOTP input before Continue; no submit click was sent.'
    }
    Invoke-SecureLinkClick -Process $target.Process -Geometry $target.Geometry -X $SubmitX -Y $SubmitY
    'SECURELINK_TOTP_SUBMITTED_ONCE'
} finally {
    [Array]::Clear($digits, 0, $digits.Length)
    $digits = $null
    $readTask = $null
    [GC]::Collect()
}
