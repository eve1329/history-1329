#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Codex History Viewer"
APP_DIR="$ROOT_DIR/dist/mac/$APP_NAME.app"
RELEASE_DIR="$ROOT_DIR/dist/release"
RELEASE_NAME="${RELEASE_NAME:-Codex-History-Viewer-mac-arm64}"
ZIP_PATH="$RELEASE_DIR/$RELEASE_NAME.zip"
SHA_PATH="$ZIP_PATH.sha256"
VIEWER_DIR="$APP_DIR/Contents/Resources/viewer"
NODE_BIN="$APP_DIR/Contents/Resources/node/bin/node"
APP_BIN="$APP_DIR/Contents/MacOS/CodexHistoryViewer"

cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/license.json" ] && [ "${ALLOW_MISSING_LICENSE:-0}" != "1" ]; then
  cat >&2 <<'EOF'
Error: license.json is missing.

This release script is intended for private activated builds. Put license.json in
the repository root first, or set ALLOW_MISSING_LICENSE=1 for a development build.
EOF
  exit 1
fi

npm run build:mac

test -x "$APP_BIN"
test -x "$NODE_BIN"
test -f "$VIEWER_DIR/server.mjs"
test -d "$VIEWER_DIR/public"

if [ "${ALLOW_MISSING_LICENSE:-0}" != "1" ]; then
  test -f "$VIEWER_DIR/license.json"
  "$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";

const licensePath = "dist/mac/Codex History Viewer.app/Contents/Resources/viewer/license.json";
const config = JSON.parse(fs.readFileSync(licensePath, "utf8"));
if (config.required !== true) {
  throw new Error("license.json must set required: true for a private release.");
}
if (!config.serverUrl || !config.publicKey) {
  throw new Error("license.json must include serverUrl and publicKey.");
}
console.log(`License config: ${config.serverUrl}`);
NODE
fi

if ! file "$APP_BIN" | grep -q "arm64"; then
  file "$APP_BIN" >&2
  echo "Error: macOS app executable is not arm64." >&2
  exit 1
fi

if ! "$NODE_BIN" -e 'require("node:sqlite"); console.log("node:sqlite ok")'; then
  echo "Error: bundled Node cannot load node:sqlite." >&2
  exit 1
fi

printf 'Executable build version:\n'
otool -l "$APP_BIN" | awk '
  /LC_BUILD_VERSION/ { show=1 }
  show && /platform|sdk|minos|ntools/ { print }
  show && /ntools/ { exit }
'

codesign --verify --deep --strict --verbose=2 "$APP_DIR"

mkdir -p "$RELEASE_DIR"
rm -f "$ZIP_PATH" "$SHA_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"

shasum -a 256 "$ZIP_PATH" | tee "$SHA_PATH"

printf '\nmacOS release package:\n  %s\n' "$ZIP_PATH"
printf 'SHA256 file:\n  %s\n' "$SHA_PATH"
