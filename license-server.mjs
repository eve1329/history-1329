import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const host = process.env.LICENSE_HOST || "0.0.0.0";
const requestedPort = Number.parseInt(process.env.LICENSE_PORT || process.env.PORT || "8787", 10);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8787;
const dbPath = process.env.LICENSE_DB || path.join(process.cwd(), "license-server.sqlite");
const adminSecret = process.env.LICENSE_ADMIN_SECRET || "";
const appId = process.env.LICENSE_APP_ID || "codex-history-viewer";
const defaultMaxMachines = Math.max(Number.parseInt(process.env.LICENSE_DEFAULT_MAX_MACHINES || "2", 10), 1);
const tokenTtlDays = Math.max(Number.parseInt(process.env.LICENSE_TOKEN_TTL_DAYS || "30", 10), 1);
const privateKeyPem = normalizePem(
  process.env.LICENSE_SIGNING_PRIVATE_KEY
    || readTextIfPresent(process.env.LICENSE_SIGNING_PRIVATE_KEY_FILE)
    || ""
);

if (!privateKeyPem) {
  console.error("Missing LICENSE_SIGNING_PRIVATE_KEY or LICENSE_SIGNING_PRIVATE_KEY_FILE.");
  console.error("Generate one with: node scripts/generate-license-keypair.mjs");
  process.exit(1);
}

const signingPrivateKey = crypto.createPrivateKey(privateKeyPem);
const signingPublicKey = crypto.createPublicKey(signingPrivateKey);
const db = new DatabaseSync(dbPath);
initializeDatabase();

function readTextIfPresent(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    return fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function normalizePem(value) {
  return String(value || "").replaceAll("\\n", "\n").trim();
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      license_key TEXT PRIMARY KEY,
      max_machines INTEGER NOT NULL DEFAULT 2,
      note TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activations (
      license_key TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      machine_label TEXT,
      first_activated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (license_key, machine_id),
      FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_activations_license_key ON activations(license_key);
  `);
}

function normalizeLicenseKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatLicenseKey(compactKey) {
  const key = normalizeLicenseKey(compactKey);
  if (key.startsWith("CHV") && key.length > 3) {
    const rest = key.slice(3).match(/.{1,4}/g)?.join("-") || key.slice(3);
    return `CHV-${rest}`;
  }
  return key.match(/.{1,4}/g)?.join("-") || key;
}

function generateLicenseKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "CHV";
  const bytes = crypto.randomBytes(16);
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value;
}

function isExpired(expiresAt) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= Date.now();
}

function requireAdmin(req, res) {
  if (!adminSecret) {
    json(res, 503, { error: "LICENSE_ADMIN_SECRET is not configured" });
    return false;
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== adminSecret) {
    json(res, 401, { error: "Admin authorization required" });
    return false;
  }
  return true;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

function signLicensePayload(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(body), signingPrivateKey);
  return `${base64UrlEncode(body)}.${signature.toString("base64url")}`;
}

function verifyLicenseToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    return null;
  }
  const payloadBytes = base64UrlDecode(parts[0]);
  const signature = base64UrlDecode(parts[1]);
  if (!crypto.verify(null, payloadBytes, signingPublicKey, signature)) {
    return null;
  }
  return JSON.parse(payloadBytes.toString("utf8"));
}

function issueToken({ license, machineId, machineCount }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokenTtlDays * 24 * 60 * 60 * 1000);
  return signLicensePayload({
    version: 1,
    iss: "codex-history-license-server",
    aud: appId,
    licenseKey: license.license_key,
    machineId,
    maxMachines: Number(license.max_machines),
    machineCount,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  });
}

function getLicenseOrError(res, licenseKey) {
  const license = db.prepare("SELECT * FROM licenses WHERE license_key = ?").get(licenseKey);
  if (!license) {
    json(res, 404, { error: "Activation code not found", code: "license_not_found" });
    return null;
  }
  if (Number(license.disabled) === 1) {
    json(res, 403, { error: "Activation code is disabled", code: "license_disabled" });
    return null;
  }
  if (isExpired(license.expires_at)) {
    json(res, 403, { error: "Activation code is expired", code: "license_expired" });
    return null;
  }
  return license;
}

function activationCount(licenseKey) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM activations WHERE license_key = ?").get(licenseKey);
  return Number(row?.count) || 0;
}

function listActivations(licenseKey) {
  return db.prepare(`
    SELECT machine_id, machine_label, first_activated_at, last_seen_at
    FROM activations
    WHERE license_key = ?
    ORDER BY last_seen_at DESC
  `).all(licenseKey);
}

function activateLicense(res, body) {
  const requestedAppId = String(body.appId || appId);
  if (requestedAppId !== appId) {
    json(res, 400, { error: "Unsupported appId", code: "unsupported_app" });
    return;
  }

  const licenseKey = normalizeLicenseKey(body.licenseKey);
  const machineId = String(body.machineId || "").trim();
  const machineLabel = String(body.machineLabel || "").slice(0, 160);
  if (!licenseKey || !machineId) {
    json(res, 400, { error: "licenseKey and machineId are required" });
    return;
  }

  const license = getLicenseOrError(res, licenseKey);
  if (!license) {
    return;
  }

  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT machine_id FROM activations WHERE license_key = ? AND machine_id = ?
  `).get(licenseKey, machineId);

  if (!existing) {
    const count = activationCount(licenseKey);
    if (count >= Number(license.max_machines)) {
      json(res, 403, {
        error: `Activation limit reached: ${count}/${license.max_machines} machines are already bound`,
        code: "machine_limit_reached",
        maxMachines: Number(license.max_machines),
        machineCount: count,
        activations: listActivations(licenseKey).map((activation) => ({
          machineLabel: activation.machine_label,
          firstActivatedAt: activation.first_activated_at,
          lastSeenAt: activation.last_seen_at
        }))
      });
      return;
    }

    db.prepare(`
      INSERT INTO activations (license_key, machine_id, machine_label, first_activated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(licenseKey, machineId, machineLabel, now, now);
  } else {
    db.prepare(`
      UPDATE activations SET machine_label = ?, last_seen_at = ?
      WHERE license_key = ? AND machine_id = ?
    `).run(machineLabel, now, licenseKey, machineId);
  }

  const machineCount = activationCount(licenseKey);
  json(res, 200, {
    active: true,
    licenseKey: formatLicenseKey(licenseKey),
    token: issueToken({ license, machineId, machineCount }),
    maxMachines: Number(license.max_machines),
    machineCount,
    expiresAt: license.expires_at || null
  });
}

function validateLicense(res, body) {
  let licenseKey = normalizeLicenseKey(body.licenseKey);
  const machineId = String(body.machineId || "").trim();
  if (!licenseKey && body.token) {
    const payload = verifyLicenseToken(body.token);
    if (payload?.licenseKey) {
      licenseKey = normalizeLicenseKey(payload.licenseKey);
    }
  }
  if (!licenseKey || !machineId) {
    json(res, 400, { error: "licenseKey and machineId are required" });
    return;
  }

  const license = getLicenseOrError(res, licenseKey);
  if (!license) {
    return;
  }

  const activation = db.prepare(`
    SELECT * FROM activations WHERE license_key = ? AND machine_id = ?
  `).get(licenseKey, machineId);
  if (!activation) {
    json(res, 403, { error: "This machine is not activated for this code", code: "machine_not_activated" });
    return;
  }

  const machineLabel = String(body.machineLabel || activation.machine_label || "").slice(0, 160);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE activations SET machine_label = ?, last_seen_at = ?
    WHERE license_key = ? AND machine_id = ?
  `).run(machineLabel, now, licenseKey, machineId);

  const machineCount = activationCount(licenseKey);
  json(res, 200, {
    active: true,
    licenseKey: formatLicenseKey(licenseKey),
    token: issueToken({ license, machineId, machineCount }),
    maxMachines: Number(license.max_machines),
    machineCount,
    expiresAt: license.expires_at || null
  });
}

function deactivateLicense(res, body) {
  const tokenPayload = body.token ? verifyLicenseToken(body.token) : null;
  const licenseKey = normalizeLicenseKey(body.licenseKey || tokenPayload?.licenseKey);
  const machineId = String(body.machineId || tokenPayload?.machineId || "").trim();
  if (!licenseKey || !machineId) {
    json(res, 400, { error: "licenseKey and machineId are required" });
    return;
  }
  const result = db.prepare("DELETE FROM activations WHERE license_key = ? AND machine_id = ?").run(licenseKey, machineId);
  json(res, 200, { deactivated: result.changes ?? 0, licenseKey: formatLicenseKey(licenseKey) });
}

function createLicense(res, body) {
  const licenseKey = normalizeLicenseKey(body.licenseKey || generateLicenseKey());
  const maxMachines = Math.max(Number.parseInt(String(body.maxMachines || defaultMaxMachines), 10), 1);
  const note = String(body.note || "").slice(0, 500);
  const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
  const createdAt = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO licenses (license_key, max_machines, note, disabled, expires_at, created_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(licenseKey, maxMachines, note, expiresAt, createdAt);
  } catch (error) {
    if (/constraint/i.test(error?.message || "")) {
      json(res, 409, { error: "Activation code already exists", code: "license_exists" });
      return;
    }
    throw error;
  }

  json(res, 201, {
    licenseKey: formatLicenseKey(licenseKey),
    compactLicenseKey: licenseKey,
    maxMachines,
    expiresAt,
    note,
    createdAt
  });
}

function listLicenses(res) {
  const rows = db.prepare(`
    SELECT
      l.*,
      COUNT(a.machine_id) AS machine_count,
      MAX(a.last_seen_at) AS last_seen_at
    FROM licenses l
    LEFT JOIN activations a ON a.license_key = l.license_key
    GROUP BY l.license_key
    ORDER BY l.created_at DESC
  `).all();

  json(res, 200, {
    licenses: rows.map((row) => ({
      licenseKey: formatLicenseKey(row.license_key),
      compactLicenseKey: row.license_key,
      maxMachines: Number(row.max_machines),
      machineCount: Number(row.machine_count) || 0,
      disabled: Number(row.disabled) === 1,
      expiresAt: row.expires_at || null,
      note: row.note || "",
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at || null,
      activations: listActivations(row.license_key)
    }))
  });
}

function removeActivation(res, body) {
  const licenseKey = normalizeLicenseKey(body.licenseKey);
  const machineId = String(body.machineId || "").trim();
  if (!licenseKey || !machineId) {
    json(res, 400, { error: "licenseKey and machineId are required" });
    return;
  }
  const result = db.prepare("DELETE FROM activations WHERE license_key = ? AND machine_id = ?").run(licenseKey, machineId);
  json(res, 200, {
    licenseKey: formatLicenseKey(licenseKey),
    machineId,
    removed: result.changes ?? 0,
    remainingMachineCount: activationCount(licenseKey)
  });
}

function updateLicense(res, body) {
  const licenseKey = normalizeLicenseKey(body.licenseKey);
  if (!licenseKey) {
    json(res, 400, { error: "licenseKey is required" });
    return;
  }

  const license = db.prepare("SELECT * FROM licenses WHERE license_key = ?").get(licenseKey);
  if (!license) {
    json(res, 404, { error: "Activation code not found", code: "license_not_found" });
    return;
  }

  const nextMaxMachines = body.maxMachines === undefined
    ? Number(license.max_machines)
    : Math.max(Number.parseInt(String(body.maxMachines), 10), 1);
  const nextDisabled = body.disabled === undefined ? Number(license.disabled) : (body.disabled ? 1 : 0);
  const nextNote = body.note === undefined ? license.note : String(body.note || "").slice(0, 500);
  const nextExpiresAt = body.expiresAt === undefined
    ? license.expires_at
    : (body.expiresAt ? new Date(body.expiresAt).toISOString() : null);

  db.prepare(`
    UPDATE licenses
    SET max_machines = ?, disabled = ?, note = ?, expires_at = ?
    WHERE license_key = ?
  `).run(nextMaxMachines, nextDisabled, nextNote, nextExpiresAt, licenseKey);

  json(res, 200, {
    licenseKey: formatLicenseKey(licenseKey),
    maxMachines: nextMaxMachines,
    disabled: nextDisabled === 1,
    note: nextNote,
    expiresAt: nextExpiresAt
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, appId, dbPath, tokenTtlDays, defaultMaxMachines });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/activate") {
      activateLicense(res, await readJsonBody(req));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/validate") {
      validateLicense(res, await readJsonBody(req));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deactivate") {
      deactivateLicense(res, await readJsonBody(req));
      return;
    }

    if (url.pathname === "/admin/licenses") {
      if (!requireAdmin(req, res)) {
        return;
      }
      if (req.method === "GET") {
        listLicenses(res);
        return;
      }
      if (req.method === "POST") {
        createLicense(res, await readJsonBody(req));
        return;
      }
    }

    if (req.method === "PATCH" && url.pathname === "/admin/licenses") {
      if (!requireAdmin(req, res)) {
        return;
      }
      updateLicense(res, await readJsonBody(req));
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/activations/delete") {
      if (!requireAdmin(req, res)) {
        return;
      }
      removeActivation(res, await readJsonBody(req));
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`License server: http://${host}:${actualPort}`);
  console.log(`License database: ${dbPath}`);
});
