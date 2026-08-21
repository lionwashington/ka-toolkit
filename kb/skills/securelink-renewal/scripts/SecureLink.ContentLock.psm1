Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-SecureLinkNormalizedBitmap {
    param([Parameter(Mandatory = $true)] [string] $Path)

    $source = [Drawing.Bitmap]::new($Path)
    try {
        $normalized = [Drawing.Bitmap]::new(
            $source.Width,
            $source.Height,
            [Drawing.Imaging.PixelFormat]::Format32bppArgb
        )
        $graphics = [Drawing.Graphics]::FromImage($normalized)
        try {
            $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.DrawImageUnscaled($source, 0, 0)
        } finally {
            $graphics.Dispose()
        }
        return $normalized
    } finally {
        $source.Dispose()
    }
}

function Get-SecureLinkRegionDigest {
    param(
        [Parameter(Mandatory = $true)] [Drawing.Bitmap] $Bitmap,
        [Parameter(Mandatory = $true)] [Drawing.Rectangle] $Region
    )

    if ($Region.Width -le 0 -or $Region.Height -le 0) { return '' }
    $data = $null
    $pixels = $null
    $sha = $null
    try {
        $data = $Bitmap.LockBits(
            $Region,
            [Drawing.Imaging.ImageLockMode]::ReadOnly,
            [Drawing.Imaging.PixelFormat]::Format32bppArgb
        )
        if ($data.Stride -le 0) { throw 'Unexpected bitmap stride during content verification.' }
        $rowBytes = $Region.Width * 4
        $byteCount = $rowBytes * $Region.Height
        $pixels = [byte[]]::new($byteCount)
        for ($row = 0; $row -lt $Region.Height; $row++) {
            $rowPointer = [IntPtr]::Add($data.Scan0, $row * $data.Stride)
            [Runtime.InteropServices.Marshal]::Copy($rowPointer, $pixels, $row * $rowBytes, $rowBytes)
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        ([BitConverter]::ToString($sha.ComputeHash($pixels))).Replace('-', '')
    } finally {
        if ($null -ne $data) { $Bitmap.UnlockBits($data) }
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $pixels) { [Array]::Clear($pixels, 0, $pixels.Length) }
    }
}

function Get-SecureLinkBitmapFingerprint {
    param(
        [Parameter(Mandatory = $true)] [Drawing.Bitmap] $Bitmap,
        [Drawing.Rectangle] $ExcludedRectangle = [Drawing.Rectangle]::Empty
    )

    if ($ExcludedRectangle.IsEmpty) {
        return Get-SecureLinkRegionDigest -Bitmap $Bitmap -Region ([Drawing.Rectangle]::new(0, 0, $Bitmap.Width, $Bitmap.Height))
    }

    $regions = @(
        [Drawing.Rectangle]::new(0, 0, $Bitmap.Width, $ExcludedRectangle.Top),
        [Drawing.Rectangle]::new(0, $ExcludedRectangle.Bottom, $Bitmap.Width, $Bitmap.Height - $ExcludedRectangle.Bottom),
        [Drawing.Rectangle]::new(0, $ExcludedRectangle.Top, $ExcludedRectangle.Left, $ExcludedRectangle.Height),
        [Drawing.Rectangle]::new($ExcludedRectangle.Right, $ExcludedRectangle.Top, $Bitmap.Width - $ExcludedRectangle.Right, $ExcludedRectangle.Height)
    )
    $regionDigests = foreach ($region in $regions) {
        if ($region.Width -gt 0 -and $region.Height -gt 0) {
            Get-SecureLinkRegionDigest -Bitmap $Bitmap -Region $region
        }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    $bytes = $null
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes(($regionDigests -join ':'))
        ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    } finally {
        $sha.Dispose()
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

Export-ModuleMember -Function New-SecureLinkNormalizedBitmap, Get-SecureLinkBitmapFingerprint
