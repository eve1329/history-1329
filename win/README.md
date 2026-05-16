# Windows build

The Windows package keeps the existing Node backend and ships a tiny .NET WinForms launcher.

This is intentionally simpler than Electron:

- The backend stays in `server.mjs`, so Provider Sync and SQLite behavior are shared with macOS.
- The package bundles Node.js 24 so `node:sqlite` is available.
- The launcher finds an available local port, starts the backend, opens the default browser, and keeps a tray icon for reopening or exiting.
- No WebView2 runtime is required because the UI opens in the user's default browser.

## Build on Windows

Requirements:

- Windows 10/11.
- .NET 8 SDK.
- Network access to download Node.js, unless you pass an existing Node zip.

From the project root:

```powershell
npm run build:win
```

The output directory is:

```text
dist\win\Codex History Viewer\
```

Run:

```powershell
& ".\dist\win\Codex History Viewer\CodexHistoryViewer.exe"
```

## Offline or restricted-network build

Download the matching Node archive separately, for example:

```text
node-v24.13.0-win-x64.zip
```

Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\win\build-windows.ps1 -NodeZip C:\path\to\node-v24.13.0-win-x64.zip
```

## Windows on ARM

Build a native ARM64 package with:

```powershell
powershell -ExecutionPolicy Bypass -File .\win\build-windows.ps1 -Runtime win-arm64
```

## Runtime behavior

- Uses `CODEX_HOME` if set.
- Otherwise reads `%USERPROFILE%\.codex`.
- Reads `%CODEX_HOME%\state_5.sqlite` unless `CODEX_HISTORY_DB` is set.
- Starts a server on `127.0.0.1` and an automatically selected port.
- Opens the default browser.
- Writes logs to `%LOCALAPPDATA%\CodexHistoryViewer\codex-history-viewer.log`.

Optional environment variables:

- `CODEX_HOME`: override the Codex home directory.
- `CODEX_HISTORY_DB`: override the SQLite database path.
- `CODEX_HISTORY_VIEWER_PORT`: force a local port.
- `CODEX_HISTORY_VIEWER_NODE`: use a specific `node.exe` instead of the bundled one.

## Signing

The local build is unsigned. Windows Defender SmartScreen may warn users the first time they run it.

For wider distribution, sign `CodexHistoryViewer.exe` with a code-signing certificate after the package is built.
