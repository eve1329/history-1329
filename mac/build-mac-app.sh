#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Codex History Viewer"
EXECUTABLE_NAME="CodexHistoryViewer"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/dist/mac"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
VIEWER_DIR="$RESOURCES_DIR/viewer"
NODE_DIR="$RESOURCES_DIR/node"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
SWIFT_ARCH="${SWIFT_ARCH:-$(uname -m)}"
ICONSET_DIR="$BUILD_DIR/AppIcon.iconset"
ICON_PATH="$RESOURCES_DIR/AppIcon.icns"

rm -rf "$APP_DIR" "$ICONSET_DIR"
mkdir -p "$MACOS_DIR" "$VIEWER_DIR" "$NODE_DIR/bin"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf 'Error: node executable not found. Install Node.js or pass NODE_BIN=/path/to/node.\n' >&2
  exit 1
fi

NODE_ROOT="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"

swiftc \
  -target "$SWIFT_ARCH-apple-macosx$MACOSX_DEPLOYMENT_TARGET" \
  "$ROOT_DIR/mac/CodexHistoryViewer.swift" \
  -o "$MACOS_DIR/$EXECUTABLE_NAME" \
  -framework Cocoa \
  -framework WebKit

swift "$ROOT_DIR/mac/IconGenerator.swift" "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$ICON_PATH"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex.history-viewer</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MACOSX_DEPLOYMENT_TARGET</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cp "$ROOT_DIR/package.json" "$VIEWER_DIR/package.json"
cp "$ROOT_DIR/server.mjs" "$VIEWER_DIR/server.mjs"
cp -R "$ROOT_DIR/public" "$VIEWER_DIR/public"
cp "$NODE_BIN" "$NODE_DIR/bin/node"

if [ -f "$NODE_ROOT/LICENSE" ]; then
  cp "$NODE_ROOT/LICENSE" "$NODE_DIR/LICENSE"
fi
if [ -f "$NODE_ROOT/README.md" ]; then
  cp "$NODE_ROOT/README.md" "$NODE_DIR/README.md"
fi

chmod +x "$MACOS_DIR/$EXECUTABLE_NAME"
chmod +x "$NODE_DIR/bin/node"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
fi

printf 'Built %s\n' "$APP_DIR"
