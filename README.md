# Codex History Viewer

A local viewer for Codex Desktop history stored in `state_5.sqlite`.

It provides:

- Thread history browsing and search.
- Project, provider, and archive filters.
- `codex resume <thread-id>` command copying.
- Restore-to-Codex-App support for recent project ordering.
- Provider Sync for aligning historical `model_provider` metadata with the current Codex config.
- macOS app packaging.
- Windows packaging with a small .NET launcher plus bundled Node 24.

## Run Locally

Requires Node.js 24+ because the backend uses `node:sqlite`.

```bash
npm start
```

Then open the printed local URL.

Optional environment variables:

- `CODEX_HOME`: override the Codex home directory.
- `CODEX_HISTORY_DB`: override the SQLite database path.
- `HOST`: override the listen host, default `127.0.0.1`.
- `PORT`: override the listen port, default `3999`; `0` asks Node to pick an available port.

## macOS Build

```bash
npm run build:mac
```

The app is written to:

```text
dist/mac/Codex History Viewer.app
```

The macOS build script bundles the local Node runtime and compiles the Swift WebKit shell with `MACOSX_DEPLOYMENT_TARGET=12.0` by default.

For a local Apple Silicon release zip:

```bash
npm run release:mac
```

The release package is written to:

```text
dist/release/Codex-History-Viewer-mac-arm64.zip
```

This script rebuilds the app, verifies the bundled activation config, checks the bundled Node runtime, and writes a `.sha256` checksum file next to the zip.

## Windows Build

Build on Windows 10/11 with .NET 8 SDK installed:

```powershell
npm run build:win
```

The distributable directory is:

```text
dist\win\Codex History Viewer\
```

Run:

```powershell
& ".\dist\win\Codex History Viewer\CodexHistoryViewer.exe"
```

The Windows package:

- Bundles Node.js 24 for `node:sqlite` support.
- Starts the local backend on `127.0.0.1` with an available port.
- Opens an embedded WebView2 window automatically.
- Protects local API endpoints with a per-launch random access token.
- Keeps a tray icon for reopening, restarting, log viewing, and exit.
- Uses `CODEX_HOME` when set, otherwise `%USERPROFILE%\.codex`.

See [win/README.md](win/README.md) for offline builds, Windows ARM64 builds, and runtime details.


## Private Activation

This app can be distributed as a private activated app. The desktop package reads a bundled `license.json` and requires users to activate before history APIs are available.

Generate signing keys:

```bash
npm run license:keygen
```

Run the license server on your cloud server:

```bash
npm run license:server
```

See [LICENSE-SERVER.md](LICENSE-SERVER.md) for deployment, activation code creation, and release-build instructions.

## Provider Sync Safety

Provider Sync creates backups under:

```text
~/.codex/backups_state/provider-sync
```

On Windows this maps to:

```text
%CODEX_HOME%\backups_state\provider-sync
```

Backups include SQLite state files, Codex config/global state files when present, and a manifest of changed rollout metadata.
