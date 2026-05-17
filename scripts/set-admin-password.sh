#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-root}"
ENV_FILE="${LICENSE_ENV_FILE:-/opt/codex-history-license/.env}"
SERVICE_NAME="${LICENSE_SERVICE_NAME:-codex-history-license}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/set-admin-password.sh 'new-admin-password'
  bash scripts/set-admin-password.sh

Options:
  --host HOST       SSH host alias or address. Default: root
  --env-file PATH   Remote env file. Default: /opt/codex-history-license/.env
  --service NAME    systemd service. Default: codex-history-license
  -h, --help        Show help.

Examples:
  bash scripts/set-admin-password.sh 'MyNewPassword123'
  bash scripts/set-admin-password.sh --host root 'MyNewPassword123'
  SSH_HOST=root bash scripts/set-admin-password.sh 'MyNewPassword123'
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      SSH_HOST="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --service)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ -z "$SSH_HOST" || -z "$ENV_FILE" || -z "$SERVICE_NAME" ]]; then
  echo "SSH host, env file, and service name cannot be empty." >&2
  exit 2
fi

if [[ $# -gt 1 ]]; then
  echo "Password contains spaces or multiple arguments. Wrap it in quotes." >&2
  echo "Example: bash scripts/set-admin-password.sh 'my password'" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  NEW_SECRET="$1"
else
  read -r -s -p "New admin password: " NEW_SECRET
  printf '\n'
  read -r -s -p "Confirm admin password: " CONFIRM_SECRET
  printf '\n'
  if [[ "$NEW_SECRET" != "$CONFIRM_SECRET" ]]; then
    echo "Passwords do not match." >&2
    exit 2
  fi
fi

if [[ -z "$NEW_SECRET" ]]; then
  echo "Password cannot be empty." >&2
  exit 2
fi

SECRET_B64="$(printf '%s' "$NEW_SECRET" | base64 | tr -d '\n')"

ssh "$SSH_HOST" \
  "NEW_SECRET_B64='$SECRET_B64' ENV_FILE='$ENV_FILE' SERVICE_NAME='$SERVICE_NAME' bash -s" <<'REMOTE'
set -euo pipefail

python3 - <<'PY'
import base64
import datetime
import os
import stat
from pathlib import Path

env_path = Path(os.environ["ENV_FILE"])
secret = base64.b64decode(os.environ["NEW_SECRET_B64"]).decode("utf-8")

if not secret:
    raise SystemExit("Password cannot be empty.")
if "\n" in secret or "\r" in secret:
    raise SystemExit("Password cannot contain newlines.")
if not env_path.exists():
    raise SystemExit(f"Env file not found: {env_path}")

original = env_path.read_text()
timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
backup = env_path.with_name(env_path.name + f".bak-admin-{timestamp}")
backup.write_text(original)
os.chmod(backup, stat.S_IRUSR | stat.S_IWUSR)

def systemd_quote(value: str) -> str:
    value = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{value}"'

lines = original.splitlines()
replacement = f"LICENSE_ADMIN_SECRET={systemd_quote(secret)}"
updated = False

for index, line in enumerate(lines):
    if line.startswith("LICENSE_ADMIN_SECRET="):
        lines[index] = replacement
        updated = True
        break

if not updated:
    lines.append(replacement)

env_path.write_text("\n".join(lines) + "\n")
os.chmod(env_path, stat.S_IRUSR | stat.S_IWUSR)
print(f"Updated {env_path}")
print(f"Backup saved to {backup}")
PY

systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"

node --input-type=module <<'NODE'
const secret = Buffer.from(process.env.NEW_SECRET_B64 || "", "base64").toString("utf8");
const port = process.env.LICENSE_PORT || "8787";
const base = `http://127.0.0.1:${port}`;
const login = await fetch(`${base}/admin/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret })
});
const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
if (!login.ok || !cookie) {
  throw new Error(`Admin login verification failed: HTTP ${login.status}`);
}
const list = await fetch(`${base}/admin/api/licenses`, { headers: { cookie } });
if (!list.ok) {
  throw new Error(`Admin API verification failed: HTTP ${list.status}`);
}
console.log("Admin login verification passed.");
NODE

echo "Service restarted successfully."
REMOTE

echo "Admin password updated successfully."
