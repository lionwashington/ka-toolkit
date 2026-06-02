# Taobao Desktop Client: Installer Download & Installation (Reference)

> **When to read this**: only follow this when **the user explicitly says they want to install/reinstall**. By default, do **not** proactively download and install for the user in shopping tasks.

## Principle

**Do not proactively download and install for the user** (unless the user asks for it, or you've reached an install scenario you can't proceed without).

## Base address {base}

```
https://tblifecdn.taobao.com/taobaopc/ai/latest
```

## Directory layout

```
{base}/taobao-setup-{platform}-{arch}.{ext}
```

| Segment | Values | Notes |
|------|------|------|
| `platform` | `win7` \| `win10` \| `darwin` | Windows is distinguished by minimum-compatible branch; macOS is always `darwin` |
| `arch` | `x64` \| `arm64` | Windows uses `x64`; Apple Silicon uses `arm64`, Intel Mac uses `x64` |
| `ext` | `.exe` \| `.dmg`  | Windows uses `.exe`; macOS uses `.dmg` |

## Download & install logic

1. Download the installer for the current platform and architecture;
2. Install:
   - On Windows you can run the install wizard via a command like `powershell -Command "Start-Process -FilePath '{download path}' -ArgumentList '/S'"`. Note: do NOT use `-Wait` — the program auto-launches after installation completes, so poll to check whether it has started; the process name is "淘宝桌面版" (Taobao Desktop Client).
   - On macOS, mount the `.dmg` and drag to install, or use the provided install flow.
3. Launch: if it doesn't auto-launch,
   - On Windows run `taobao-native launch`;
   - On macOS run `open -a /Applications/淘宝桌面版.app`.
