param(
    [Parameter(Mandatory = $true)]
    [long] $WindowHandle,
    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SecureLink.Automation.psm1') -Force
Add-Type -AssemblyName System.Drawing

$parent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw 'The screenshot parent directory does not exist.'
}
if ([IO.Path]::GetExtension($OutputPath) -ne '.png') {
    throw 'The screenshot output must use a .png extension.'
}
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw 'The wrapper must pre-create the private screenshot file.'
}

$process = Get-SecureLinkWindowByHandle -WindowHandle $WindowHandle
$geometry = Get-SecureLinkGeometry -Process $process
$bitmap = New-Object Drawing.Bitmap($geometry.Width, $geometry.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()

try {
    if (-not [SecureLinkNative]::PrintWindow($process.MainWindowHandle, $hdc, 2)) {
        throw 'SecureLink refused a window-only capture; no desktop fallback was used.'
    }
} finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
}

try {
    $stream = [IO.FileStream]::new($OutputPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $stream.Dispose()
    }
} finally {
    $bitmap.Dispose()
}

[ordered]@{
    ok = $true
    pid = $process.Id
    title = $process.MainWindowTitle
    width = $geometry.Width
    height = $geometry.Height
    left = $geometry.Left
    top = $geometry.Top
    path = $OutputPath
} | ConvertTo-Json -Compress
