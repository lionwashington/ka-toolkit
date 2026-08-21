param([Parameter(Mandatory = $true)] [string] $ModulePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Import-Module $ModulePath -Force

$baseline = [Drawing.Bitmap]::new(120, 80, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$outsideChange = [Drawing.Bitmap]::new(120, 80, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$insideChange = [Drawing.Bitmap]::new(120, 80, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$input = [Drawing.Rectangle]::new(40, 30, 40, 20)
try {
    foreach ($bitmap in @($baseline, $outsideChange, $insideChange)) {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.Clear([Drawing.Color]::White) } finally { $graphics.Dispose() }
    }
    $outsideChange.SetPixel(10, 10, [Drawing.Color]::Black)
    $insideChange.SetPixel(50, 40, [Drawing.Color]::Black)

    $baselineFull = Get-SecureLinkBitmapFingerprint -Bitmap $baseline
    $baselineMasked = Get-SecureLinkBitmapFingerprint -Bitmap $baseline -ExcludedRectangle $input
    if ((Get-SecureLinkBitmapFingerprint -Bitmap $outsideChange) -eq $baselineFull) {
        throw 'A same-size outside-input content change passed the full lock.'
    }
    if ((Get-SecureLinkBitmapFingerprint -Bitmap $outsideChange -ExcludedRectangle $input) -eq $baselineMasked) {
        throw 'A same-size outside-input content change passed the pre-submit lock.'
    }
    if ((Get-SecureLinkBitmapFingerprint -Bitmap $insideChange) -eq $baselineFull) {
        throw 'An input-region content change passed the full pre-input lock.'
    }
    if ((Get-SecureLinkBitmapFingerprint -Bitmap $insideChange -ExcludedRectangle $input) -ne $baselineMasked) {
        throw 'The tightly excluded input rectangle was not isolated as designed.'
    }
    'SECURELINK_CONTENT_LOCK_TEST_OK'
} finally {
    $baseline.Dispose()
    $outsideChange.Dispose()
    $insideChange.Dispose()
}
