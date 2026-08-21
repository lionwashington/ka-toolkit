Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedExe = 'C:\Program Files\SecureLink\SecureLink.exe'

if (-not ('SecureLinkNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SecureLinkNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
}
'@
}

function Get-SecureLinkProcesses {
    @(Get-Process -Name 'SecureLink' -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -ieq $script:ExpectedExe
        } catch {
            $false
        }
    })
}

function Get-SecureLinkTopLevelWindows {
    $processes = @(Get-SecureLinkProcesses)
    $processById = @{}
    foreach ($process in $processes) {
        $processById[[int]$process.Id] = $process
    }

    $windows = [Collections.Generic.List[object]]::new()
    $callback = [SecureLinkNative+EnumWindowsProc]{
        param([IntPtr]$handle, [IntPtr]$unused)

        [uint32]$windowProcessId = 0
        [void][SecureLinkNative]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
        if ($processById.ContainsKey([int]$windowProcessId) -and [SecureLinkNative]::IsWindowVisible($handle)) {
            $titleBuffer = [Text.StringBuilder]::new(512)
            [void][SecureLinkNative]::GetWindowText($handle, $titleBuffer, $titleBuffer.Capacity)
            if ($titleBuffer.ToString() -eq 'SecureLink') {
                $windows.Add([pscustomobject]@{
                    Process = $processById[[int]$windowProcessId]
                    MainWindowHandle = $handle
                    MainWindowTitle = $titleBuffer.ToString()
                    Id = [int]$windowProcessId
                })
            }
        }
        return $true
    }
    [void][SecureLinkNative]::EnumWindows($callback, [IntPtr]::Zero)
    @($windows)
}

function Get-SecureLinkWindowByHandle {
    param([Parameter(Mandatory = $true)] [long] $WindowHandle)

    $candidate = @(Get-SecureLinkTopLevelWindows | Where-Object {
        $_.MainWindowHandle.ToInt64() -eq $WindowHandle
    })
    if ($candidate.Count -ne 1) {
        throw "Expected one visible SecureLink window with handle $WindowHandle; found $($candidate.Count)."
    }
    $candidate[0]
}

function Get-SecureLinkWindow {
    $candidates = @(Get-SecureLinkTopLevelWindows)

    if ($candidates.Count -ne 1) {
        throw "Expected exactly one visible SecureLink top-level window; found $($candidates.Count). Enumerate and select a freshly verified handle."
    }

    return $candidates[0]
}

function Get-SecureLinkGeometry {
    param([Parameter(Mandatory = $true)] $Process)

    $rect = New-Object SecureLinkNative+RECT
    if (-not [SecureLinkNative]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
        throw 'Could not read the SecureLink window geometry.'
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    # Notification and workbench dimensions vary. Geometry is only a sanity
    # bound; every state-changing action still requires a fresh visual
    # verification and an exact width/height match.
    if ($width -lt 280 -or $height -lt 180 -or $width -gt 7680 -or $height -gt 4320) {
        throw "SecureLink window geometry is implausible: ${width}x${height}."
    }

    [pscustomobject]@{
        Left = $rect.Left
        Top = $rect.Top
        Right = $rect.Right
        Bottom = $rect.Bottom
        Width = $width
        Height = $height
    }
}

function Assert-SecureLinkGeometry {
    param(
        [Parameter(Mandatory = $true)] $Geometry,
        [Parameter(Mandatory = $true)] [int] $ExpectedWidth,
        [Parameter(Mandatory = $true)] [int] $ExpectedHeight,
        [int] $Tolerance = 4
    )

    if ([Math]::Abs($Geometry.Width - $ExpectedWidth) -gt $Tolerance -or
        [Math]::Abs($Geometry.Height - $ExpectedHeight) -gt $Tolerance) {
        throw "SecureLink window changed from ${ExpectedWidth}x${ExpectedHeight} to $($Geometry.Width)x$($Geometry.Height); recapture before acting."
    }
}

function Assert-RelativePoint {
    param(
        [Parameter(Mandatory = $true)] $Geometry,
        [Parameter(Mandatory = $true)] [int] $X,
        [Parameter(Mandatory = $true)] [int] $Y
    )

    if ($X -lt 1 -or $Y -lt 1 -or $X -ge ($Geometry.Width - 1) -or $Y -ge ($Geometry.Height - 1)) {
        throw "Relative point (${X},${Y}) is outside the SecureLink window."
    }
}

function Set-SecureLinkForeground {
    param([Parameter(Mandatory = $true)] $Process)

    [void][SecureLinkNative]::ShowWindowAsync($Process.MainWindowHandle, 9)
    [void][SecureLinkNative]::SetForegroundWindow($Process.MainWindowHandle)
    Start-Sleep -Milliseconds 180

    if ([SecureLinkNative]::GetForegroundWindow() -ne $Process.MainWindowHandle) {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate($Process.Id)
        Start-Sleep -Milliseconds 180
    }

    if ([SecureLinkNative]::GetForegroundWindow() -ne $Process.MainWindowHandle) {
        throw 'SecureLink could not be made the foreground window; no click was sent.'
    }
}

function Invoke-SecureLinkClick {
    param(
        [Parameter(Mandatory = $true)] $Process,
        [Parameter(Mandatory = $true)] $Geometry,
        [Parameter(Mandatory = $true)] [int] $X,
        [Parameter(Mandatory = $true)] [int] $Y
    )

    Assert-RelativePoint -Geometry $Geometry -X $X -Y $Y
    Set-SecureLinkForeground -Process $Process

    $oldPoint = New-Object SecureLinkNative+POINT
    [void][SecureLinkNative]::GetCursorPos([ref]$oldPoint)
    try {
        if (-not [SecureLinkNative]::SetCursorPos($Geometry.Left + $X, $Geometry.Top + $Y)) {
            throw 'Could not move the pointer to the verified SecureLink control.'
        }
        Start-Sleep -Milliseconds 60
        [SecureLinkNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [SecureLinkNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    } finally {
        Start-Sleep -Milliseconds 50
        [void][SecureLinkNative]::SetCursorPos($oldPoint.X, $oldPoint.Y)
    }
}

Export-ModuleMember -Function Get-SecureLinkProcesses, Get-SecureLinkTopLevelWindows, Get-SecureLinkWindowByHandle, Get-SecureLinkWindow, Get-SecureLinkGeometry, Assert-SecureLinkGeometry, Assert-RelativePoint, Set-SecureLinkForeground, Invoke-SecureLinkClick
