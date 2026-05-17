#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Codex History Viewer"
MAC_RUNTIME="${MAC_RUNTIME:-darwin-arm64}"
NODE_VERSION="${NODE_VERSION:-24.13.0}"
NODE_VERSION="${NODE_VERSION#v}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
NODE_CACHE_DIR="${NODE_CACHE_DIR:-$ROOT_DIR/.cache/node}"
APP_DIR="$ROOT_DIR/dist/mac/$APP_NAME.app"
RELEASE_DIR="$ROOT_DIR/dist/release"
VIEWER_DIR="$APP_DIR/Contents/Resources/viewer"
NODE_BIN="$APP_DIR/Contents/Resources/node/bin/node"
APP_BIN="$APP_DIR/Contents/MacOS/CodexHistoryViewer"

cd "$ROOT_DIR"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

download_node_runtime() {
  local runtime="$1"
  local dist_name="node-v$NODE_VERSION-$runtime"
  local tarball="$NODE_CACHE_DIR/$dist_name.tar.gz"
  local extract_dir="$NODE_CACHE_DIR/$dist_name"
  local node_bin="$extract_dir/bin/node"
  local url="https://nodejs.org/dist/v$NODE_VERSION/$dist_name.tar.gz"

  mkdir -p "$NODE_CACHE_DIR"

  if [ ! -x "$node_bin" ]; then
    if [ ! -f "$tarball" ]; then
      log "Downloading Node v$NODE_VERSION for $runtime..."
      curl -fL --retry 3 --connect-timeout 20 -o "$tarball.tmp" "$url"
      mv "$tarball.tmp" "$tarball"
    fi

    log "Extracting $dist_name..."
    rm -rf "$extract_dir"
    tar -xzf "$tarball" -C "$NODE_CACHE_DIR"
  fi

  test -x "$node_bin" || fail "downloaded Node executable is missing: $node_bin"
  printf '%s\n' "$node_bin"
}

file_has_arch() {
  local path="$1"
  local arch="$2"

  file "$path" | grep -q "$arch"
}

verify_arch() {
  local path="$1"
  local arch="$2"
  local label="$3"

  if ! file_has_arch "$path" "$arch"; then
    file "$path" >&2
    fail "$label is not $arch."
  fi
}

case "$MAC_RUNTIME" in
  darwin-arm64)
    RELEASE_ARCH="arm64"
    SWIFT_ARCH="${SWIFT_ARCH:-arm64}"
    EXPECTED_FILE_ARCH="arm64"
    NODE_RUNTIME="darwin-arm64"
    ;;
  darwin-x64)
    RELEASE_ARCH="x64"
    SWIFT_ARCH="${SWIFT_ARCH:-x86_64}"
    EXPECTED_FILE_ARCH="x86_64"
    NODE_RUNTIME="darwin-x64"
    ;;
  *)
    fail "unsupported MAC_RUNTIME '$MAC_RUNTIME'. Use darwin-arm64 or darwin-x64."
    ;;
esac

RELEASE_NAME="${RELEASE_NAME:-Codex-History-Viewer-mac-$RELEASE_ARCH}"
ZIP_PATH="$RELEASE_DIR/$RELEASE_NAME.zip"
SHA_PATH="$ZIP_PATH.sha256"

if [ ! -f "$ROOT_DIR/license.json" ] && [ "${ALLOW_MISSING_LICENSE:-0}" != "1" ]; then
  cat >&2 <<'EOF'
Error: license.json is missing.

This release script is intended for private activated builds. Put license.json in
the repository root first, or set ALLOW_MISSING_LICENSE=1 for a development build.
EOF
  exit 1
fi

if [ "$MAC_RUNTIME" = "darwin-arm64" ]; then
  TARGET_NODE_BIN="$(command -v node || true)"
  if [ -z "$TARGET_NODE_BIN" ] || ! file_has_arch "$TARGET_NODE_BIN" "$EXPECTED_FILE_ARCH"; then
    log "Local Node is not arm64; using cached Node v$NODE_VERSION for darwin-arm64."
    TARGET_NODE_BIN="$(download_node_runtime "$NODE_RUNTIME")"
  fi
else
  TARGET_NODE_BIN="$(download_node_runtime "$NODE_RUNTIME")"
fi

verify_arch "$TARGET_NODE_BIN" "$EXPECTED_FILE_ARCH" "Node executable selected for $MAC_RUNTIME"

log "Building $MAC_RUNTIME release with Swift arch $SWIFT_ARCH and Node $TARGET_NODE_BIN"
MACOSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
  SWIFT_ARCH="$SWIFT_ARCH" \
  NODE_BIN="$TARGET_NODE_BIN" \
  npm run build:mac

test -x "$APP_BIN"
test -x "$NODE_BIN"
test -f "$VIEWER_DIR/server.mjs"
test -d "$VIEWER_DIR/public"

verify_arch "$APP_BIN" "$EXPECTED_FILE_ARCH" "macOS app executable"
verify_arch "$NODE_BIN" "$EXPECTED_FILE_ARCH" "bundled Node executable"

if [ "${ALLOW_MISSING_LICENSE:-0}" != "1" ]; then
  test -f "$VIEWER_DIR/license.json"
  HOST_NODE="$(command -v node || true)"
  test -x "$HOST_NODE" || fail "host Node is required to verify license.json."
  LICENSE_PATH="$VIEWER_DIR/license.json" "$HOST_NODE" --input-type=module <<'NODE'
import fs from "node:fs";

const licensePath = process.env.LICENSE_PATH;
const config = JSON.parse(fs.readFileSync(licensePath, "utf8"));
if (config.required !== true) {
  throw new Error("license.json must set required: true for a private release.");
}
if (config.serverUrl !== "https://gptch.cloud") {
  throw new Error("license.json must use serverUrl: https://gptch.cloud.");
}
if (!config.publicKey) {
  throw new Error("license.json must include serverUrl and publicKey.");
}
console.log(`License config: ${config.serverUrl}`);
NODE
fi

if NODE_VERSION_OUTPUT="$("$NODE_BIN" --version 2>&1)"; then
  printf 'Bundled Node: %s\n' "$NODE_VERSION_OUTPUT"
  if ! "$NODE_BIN" -e 'require("node:sqlite"); console.log("node:sqlite ok")'; then
    fail "bundled Node cannot load node:sqlite."
  fi
else
  if [ "$MAC_RUNTIME" = "darwin-x64" ] && [ "$(uname -m)" = "arm64" ]; then
    printf 'Warning: bundled x64 Node could not run on this Apple Silicon host; Rosetta may be unavailable.\n' >&2
    printf 'Skipping node:sqlite runtime smoke test after file-based x64 verification.\n' >&2
    printf 'Node execution error: %s\n' "$NODE_VERSION_OUTPUT" >&2
  else
    printf '%s\n' "$NODE_VERSION_OUTPUT" >&2
    fail "bundled Node could not run."
  fi
fi

printf 'Executable build version:\n'
otool -l "$APP_BIN" | awk '
  /LC_BUILD_VERSION/ { show=1 }
  show && /platform|sdk|minos|ntools/ { print }
  show && /ntools/ { exit }
'
MINOS="$(otool -l "$APP_BIN" | awk '/LC_BUILD_VERSION/ { show=1 } show && /minos/ { print $2; exit }')"
if [ "$MINOS" != "$MACOSX_DEPLOYMENT_TARGET" ]; then
  fail "macOS app executable minos is $MINOS, expected $MACOSX_DEPLOYMENT_TARGET."
fi

codesign --verify --deep --strict --verbose=2 "$APP_DIR"

mkdir -p "$RELEASE_DIR"
rm -f "$ZIP_PATH" "$SHA_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"

shasum -a 256 "$ZIP_PATH" | tee "$SHA_PATH"

printf '\nmacOS release package:\n  %s\n' "$ZIP_PATH"
printf 'SHA256 file:\n  %s\n' "$SHA_PATH"
