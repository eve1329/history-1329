# License Server Deployment

This app can be built as a private activated app. One activation code can be limited to two machines.

The desktop app performs local checks, but the real machine-count limit requires this license server. Deploy this file's server on your own cloud server.

## 1. Generate signing keys

Run locally or on the server:

```bash
node scripts/generate-license-keypair.mjs
```

It prints two things:

- `LICENSE_SIGNING_PRIVATE_KEY`: keep this only on the cloud server.
- A `license.json` template: put this in the project root before building macOS/Windows packages.

Never commit `license.json` or the private key. `.gitignore` already excludes `license.json`.

## 2. Start the license server

Requires Node.js 24+ because it uses `node:sqlite`.

Example:

```bash
export LICENSE_SIGNING_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----'
export LICENSE_ADMIN_SECRET='replace-with-a-long-random-admin-secret'
export LICENSE_DB='/opt/codex-history-license/license-server.sqlite'
export LICENSE_PORT=8787
node license-server.mjs
```

Recommended production setup:

- Run it behind Nginx or Caddy with HTTPS.
- Keep `LICENSE_SIGNING_PRIVATE_KEY` and `LICENSE_ADMIN_SECRET` in systemd environment files or your platform's secret manager.
- Back up `license-server.sqlite`.

Health check:

```bash
curl https://your-domain.example.com/health
```

## 3. Create activation codes

```bash
curl -X POST 'https://your-domain.example.com/admin/licenses' \
  -H 'authorization: Bearer replace-with-a-long-random-admin-secret' \
  -H 'content-type: application/json' \
  -d '{"maxMachines":2,"note":"customer name or order id"}'
```

Response example:

```json
{
  "licenseKey": "CHV-ABCD-EFGH-IJKL-MNOP",
  "compactLicenseKey": "CHVABCDEFGHIJKLMNOP",
  "maxMachines": 2
}
```

Send `licenseKey` to the customer.

To create multiple activation codes in one request:

```bash
curl -X POST 'https://your-domain.example.com/admin/licenses/batch' \
  -H 'authorization: Bearer replace-with-a-long-random-admin-secret' \
  -H 'content-type: application/json' \
  -d '{"count":20,"maxMachines":2,"note":"campaign or reseller batch"}'
```

Response example:

```json
{
  "count": 20,
  "licenseKeys": [
    "CHV-ABCD-EFGH-IJKL-MNOP",
    "CHV-2345-6789-ABCD-EFGH"
  ]
}
```

The default batch limit is 500 codes per request. Override it with `LICENSE_MAX_BATCH_CREATE` if needed.

## 4. List activation codes and bound machines

```bash
curl 'https://your-domain.example.com/admin/licenses' \
  -H 'authorization: Bearer replace-with-a-long-random-admin-secret'
```

Each license includes its activations.

## 5. Disable or edit a license

```bash
curl -X PATCH 'https://your-domain.example.com/admin/licenses' \
  -H 'authorization: Bearer replace-with-a-long-random-admin-secret' \
  -H 'content-type: application/json' \
  -d '{"licenseKey":"CHV-ABCD-EFGH-IJKL-MNOP","disabled":true}'
```

You can also change `maxMachines`, `note`, or `expiresAt`.

## 5.1 Release a bound machine as admin

List licenses first to find the `machine_id`, then remove that machine binding:

```bash
curl -X POST 'https://your-domain.example.com/admin/activations/delete' \
  -H 'authorization: Bearer replace-with-a-long-random-admin-secret' \
  -H 'content-type: application/json' \
  -d '{"licenseKey":"CHV-ABCD-EFGH-IJKL-MNOP","machineId":"machine-id-from-list"}'
```

Users can also click `解绑本机` inside the desktop app if they still have access to the old machine.

## 6. Configure the desktop app before building

Create `license.json` in the project root:

```json
{
  "required": true,
  "serverUrl": "https://your-domain.example.com",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

Then build packages:

```bash
npm run build:mac
```

On Windows:

```powershell
npm run build:win
```

The macOS and Windows build scripts copy `license.json` into the bundled `viewer` directory when it exists.

## 6.1 Build GitHub releases with activation enabled

For GitHub Actions release builds, add a repository secret named `LICENSE_CONFIG_JSON` with the full `license.json` content:

```json
{"required":true,"serverUrl":"https://your-domain.example.com","publicKey":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}
```

Then push a tag such as `v1.2.0`. The `Release Windows` workflow writes that secret to `license.json` before packaging, so the generated Windows zip requires activation.

If the secret is missing, CI still builds a development package, but it will not require activation.

## 7. Runtime behavior

The desktop app:

- Shows an activation page before loading history.
- Sends activation code + machine fingerprint to `/api/activate`.
- Saves a signed token in the user's Codex home as `license-state.json`.
- Allows offline use until the signed token expires.
- Refreshes activation through `/api/validate` when requested by the local app.
- Blocks history, Provider Sync, and restore APIs until activated.

The server:

- Stores activation codes and machine bindings in SQLite.
- Allows at most `maxMachines` unique machine IDs per activation code.
- Issues Ed25519-signed tokens that the desktop app can verify locally.

## Security notes

This protects against casual sharing of activation codes. It is not strong DRM if the full source code is public, because a developer can remove license checks and rebuild. For commercial distribution, keep the app source private, sign binaries, and obfuscate or compile more of the license logic into the native shell.


## Admin Web UI

After deployment, open:

```text
https://your-domain.example.com/admin
```

Log in with `LICENSE_ADMIN_SECRET`. The web UI supports:

- Creating activation codes.
- Creating activation codes in batches.
- Viewing bound machine IDs and machine labels.
- Copying activation codes.
- Enabling or disabling activation codes.
- Releasing a machine binding.

The same API endpoints still work for scripts. The browser UI uses a signed, HttpOnly, Secure cookie valid for 12 hours.

## Change the admin password

From this repository on your Mac, run:

```bash
bash scripts/set-admin-password.sh 'new-admin-password'
```

Or run it without an argument to type the password without showing it in the terminal:

```bash
bash scripts/set-admin-password.sh
```

By default, the script connects to the SSH host alias `root`, updates `/opt/codex-history-license/.env`,
backs up the old file, restarts `codex-history-license`, and verifies that the new password can log in.

If the server SSH alias changes:

```bash
bash scripts/set-admin-password.sh --host root 'new-admin-password'
```
