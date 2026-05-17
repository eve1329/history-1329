import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const execFileAsync = promisify(execFile);
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const dbPath = process.env.CODEX_HISTORY_DB || path.join(codexHome, "state_5.sqlite");
const globalStatePath = path.join(codexHome, ".codex-global-state.json");
const globalStateBackupPath = path.join(codexHome, ".codex-global-state.json.bak");
const configPath = path.join(codexHome, "config.toml");
const providerSyncBackupRoot = path.join(codexHome, "backups_state", "provider-sync");
const providerSyncLockDir = path.join(codexHome, "tmp", "provider-sync.lock");
const appId = "codex-history-viewer";
const licenseConfigPath = process.env.CODEX_HISTORY_LICENSE_CONFIG || path.join(__dirname, "license.json");
const licenseStatePath = path.join(codexHome, "license-state.json");
const accessToken = String(process.env.CODEX_HISTORY_VIEWER_TOKEN || "").trim();
const host = process.env.HOST || "127.0.0.1";
const requestedPort = Number.parseInt(process.env.PORT || "3999", 10);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3999;
const defaultProvider = "openai";
const providerSyncBackupKeepCount = 5;
const sessionDirs = ["sessions", "archived_sessions"];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-codex-history-token",
    "cache-control": "no-store"
  });
  res.end(body);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function forbidden(res, message = "Forbidden") {
  json(res, 403, { error: message });
}

function hasValidAccessToken(req, url) {
  if (!accessToken) {
    return true;
  }
  const headerToken = String(req.headers["x-codex-history-token"] || "");
  const queryToken = url.searchParams.get("access_token") || "";
  return headerToken === accessToken || queryToken === accessToken;
}

function tableHasColumn(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info("${tableName.replaceAll("\"", "\"\"")}")`)
    .all()
    .some((column) => column.name === columnName);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "");
}

function incrementCount(counts, bucket, provider) {
  counts[bucket][provider || "(missing)"] = (counts[bucket][provider || "(missing)"] ?? 0) + 1;
}

function sumProviderCounts(counts) {
  return Object.values(counts ?? {}).reduce((total, value) => total + Number(value || 0), 0);
}

function safePathPart(value) {
  return String(value)
    .replaceAll("/", "__")
    .replaceAll("\\", "__")
    .replaceAll(":", "_")
    .replaceAll("\0", "");
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

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

function normalizePem(value) {
  return String(value || "").replaceAll("\\n", "\n").trim();
}

function normalizeLicenseKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatLicenseKey(value) {
  const key = normalizeLicenseKey(value);
  if (!key) {
    return "";
  }
  if (key.startsWith("CHV") && key.length > 3) {
    const rest = key.slice(3).match(/.{1,4}/g)?.join("-") || key.slice(3);
    return `CHV-${rest}`;
  }
  return key.match(/.{1,4}/g)?.join("-") || key;
}

async function readJsonFileIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readLicenseConfig() {
  const envRequired = process.env.CODEX_HISTORY_LICENSE_REQUIRED;
  const envServerUrl = process.env.CODEX_HISTORY_LICENSE_SERVER_URL;
  const envPublicKey = process.env.CODEX_HISTORY_LICENSE_PUBLIC_KEY;
  const config = (await readJsonFileIfPresent(licenseConfigPath)) || {};
  return {
    required: envRequired === undefined ? Boolean(config.required) : envRequired !== "0" && envRequired !== "false",
    serverUrl: String(envServerUrl || config.serverUrl || "").replace(/\/+$/, ""),
    publicKey: normalizePem(envPublicKey || config.publicKey || ""),
    configPath: licenseConfigPath
  };
}

async function readLicenseState() {
  const state = await readJsonFileIfPresent(licenseStatePath);
  return state && typeof state === "object" ? state : {};
}

async function writeLicenseState(state) {
  await fs.mkdir(path.dirname(licenseStatePath), { recursive: true });
  await fs.writeFile(licenseStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function commandOutput(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 2500, windowsHide: true });
    return stdout.toString("utf8").trim();
  } catch {
    return "";
  }
}

async function platformMachineSeed() {
  if (process.platform === "darwin") {
    const output = await commandOutput("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const match = output.match(/"IOPlatformUUID"\s=\s"([^"]+)"/);
    return match?.[1] || "";
  }
  if (process.platform === "win32") {
    const output = await commandOutput("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
    ]);
    return output.split(/\r?\n/).find(Boolean) || "";
  }
  if (process.platform === "linux") {
    try {
      return (await fs.readFile("/etc/machine-id", "utf8")).trim();
    } catch {
      return "";
    }
  }
  return "";
}

let cachedMachineInfo = null;
async function machineInfo() {
  if (cachedMachineInfo) {
    return cachedMachineInfo;
  }
  const seed = await platformMachineSeed();
  const fallbackSeed = `${os.hostname()}|${os.homedir()}|${process.platform}|${process.arch}`;
  const machineId = crypto
    .createHash("sha256")
    .update(`${appId}|${seed || fallbackSeed}`)
    .digest("hex");
  cachedMachineInfo = {
    machineId,
    machineLabel: `${os.hostname()} (${process.platform}-${process.arch})`,
    platform: process.platform,
    arch: process.arch
  };
  return cachedMachineInfo;
}

function verifyLicenseToken(token, publicKeyPem) {
  if (!token || !publicKeyPem) {
    return null;
  }
  const parts = String(token).split(".");
  if (parts.length !== 2) {
    return null;
  }
  try {
    const payloadBytes = base64UrlDecode(parts[0]);
    const signature = base64UrlDecode(parts[1]);
    const publicKey = crypto.createPublicKey(publicKeyPem);
    if (!crypto.verify(null, payloadBytes, publicKey, signature)) {
      return null;
    }
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    if (payload.aud !== appId) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function localLicenseSnapshot() {
  const config = await readLicenseConfig();
  const state = await readLicenseState();
  const machine = await machineInfo();
  if (!config.required) {
    return {
      required: false,
      active: true,
      reason: "license_not_required",
      configPath: config.configPath,
      statePath: licenseStatePath,
      machine
    };
  }
  if (!config.serverUrl || !config.publicKey) {
    return {
      required: true,
      active: false,
      reason: "license_not_configured",
      message: "License is required but license.json is missing serverUrl or publicKey.",
      configPath: config.configPath,
      statePath: licenseStatePath,
      machine
    };
  }
  const payload = verifyLicenseToken(state.token, config.publicKey);
  if (!payload) {
    return {
      required: true,
      active: false,
      reason: state.token ? "invalid_token" : "not_activated",
      configPath: config.configPath,
      statePath: licenseStatePath,
      serverUrl: config.serverUrl,
      machine
    };
  }
  if (payload.machineId !== machine.machineId) {
    return {
      required: true,
      active: false,
      reason: "machine_mismatch",
      configPath: config.configPath,
      statePath: licenseStatePath,
      serverUrl: config.serverUrl,
      machine
    };
  }
  if (Date.parse(payload.expiresAt || "") <= Date.now()) {
    return {
      required: true,
      active: false,
      reason: "token_expired",
      licenseKey: formatLicenseKey(payload.licenseKey || state.licenseKey),
      configPath: config.configPath,
      statePath: licenseStatePath,
      serverUrl: config.serverUrl,
      machine
    };
  }

  return {
    required: true,
    active: true,
    reason: "activated",
    licenseKey: formatLicenseKey(payload.licenseKey || state.licenseKey),
    tokenExpiresAt: payload.expiresAt,
    maxMachines: payload.maxMachines,
    machineCount: payload.machineCount,
    configPath: config.configPath,
    statePath: licenseStatePath,
    serverUrl: config.serverUrl,
    machine
  };
}

async function postLicenseServer(config, endpoint, body) {
  const response = await fetch(`${config.serverUrl}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.error || `License server HTTP ${response.status}`;
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function activateLocalLicense(body) {
  const config = await readLicenseConfig();
  if (!config.required) {
    return await localLicenseSnapshot();
  }
  if (!config.serverUrl || !config.publicKey) {
    throw new Error("License server is not configured. Add license.json before building this app.");
  }
  const machine = await machineInfo();
  const licenseKey = normalizeLicenseKey(body.licenseKey);
  if (!licenseKey) {
    throw new Error("请输入激活码");
  }
  const result = await postLicenseServer(config, "/api/activate", {
    appId,
    licenseKey,
    machineId: machine.machineId,
    machineLabel: machine.machineLabel
  });
  await writeLicenseState({
    licenseKey,
    token: result.token,
    activatedAt: new Date().toISOString(),
    lastValidatedAt: new Date().toISOString(),
    serverUrl: config.serverUrl
  });
  return await localLicenseSnapshot();
}

async function refreshLocalLicense() {
  const config = await readLicenseConfig();
  const state = await readLicenseState();
  if (!config.required) {
    return await localLicenseSnapshot();
  }
  if (!state.token && !state.licenseKey) {
    return await localLicenseSnapshot();
  }
  const machine = await machineInfo();
  const result = await postLicenseServer(config, "/api/validate", {
    appId,
    licenseKey: state.licenseKey,
    token: state.token,
    machineId: machine.machineId,
    machineLabel: machine.machineLabel
  });
  await writeLicenseState({
    ...state,
    licenseKey: normalizeLicenseKey(result.licenseKey || state.licenseKey),
    token: result.token,
    lastValidatedAt: new Date().toISOString(),
    serverUrl: config.serverUrl
  });
  return await localLicenseSnapshot();
}

async function deactivateLocalLicense() {
  const config = await readLicenseConfig();
  const state = await readLicenseState();
  const machine = await machineInfo();
  if (config.required && config.serverUrl && (state.token || state.licenseKey)) {
    try {
      await postLicenseServer(config, "/api/deactivate", {
        appId,
        licenseKey: state.licenseKey,
        token: state.token,
        machineId: machine.machineId
      });
    } catch {
      // Local deactivation should still clear this machine so the user can retry activation.
    }
  }
  try {
    await fs.rm(licenseStatePath, { force: true });
  } catch {
    // Ignore cleanup failures; status will surface any remaining token problem.
  }
  return await localLicenseSnapshot();
}

async function requireLicense(res) {
  const snapshot = await localLicenseSnapshot();
  if (snapshot.active) {
    return true;
  }
  json(res, 402, {
    error: snapshot.message || "Codex History Viewer 需要激活后使用",
    code: "license_required",
    license: snapshot
  });
  return false;
}

async function copyFileIfPresent(sourcePath, destinationPath) {
  try {
    await fs.access(sourcePath);
  } catch {
    return false;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

async function directorySize(directoryPath) {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
      continue;
    }
    if (entry.isFile()) {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}

async function listManagedProviderSyncBackups() {
  let entries;
  try {
    entries = await fs.readdir(providerSyncBackupRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const backupDir = path.join(providerSyncBackupRoot, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(backupDir, "metadata.json"), "utf8"));
      if (metadata?.namespace === "provider-sync") {
        backups.push({
          name: entry.name,
          path: backupDir,
          metadata
        });
      }
    } catch {
      // Ignore folders that were not created by provider sync.
    }
  }

  return backups.sort((left, right) => right.name.localeCompare(left.name));
}

async function providerSyncBackupSummary() {
  const backups = await listManagedProviderSyncBackups();
  let totalBytes = 0;
  for (const backup of backups) {
    totalBytes += await directorySize(backup.path);
  }
  return {
    count: backups.length,
    totalBytes,
    latest: backups[0] ?? null
  };
}

async function pruneProviderSyncBackups(keepCount = providerSyncBackupKeepCount) {
  const backups = await listManagedProviderSyncBackups();
  const toDelete = backups.slice(keepCount);
  let freedBytes = 0;
  for (const backup of toDelete) {
    freedBytes += await directorySize(backup.path);
    await fs.rm(backup.path, { recursive: true, force: true });
  }
  return {
    deletedCount: toDelete.length,
    remainingCount: backups.length - toDelete.length,
    freedBytes
  };
}

async function acquireProviderSyncLock(label) {
  await fs.mkdir(path.dirname(providerSyncLockDir), { recursive: true });
  try {
    await fs.mkdir(providerSyncLockDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Provider sync is already running or a stale lock exists: ${providerSyncLockDir}`);
    }
    throw error;
  }

  await fs.writeFile(
    path.join(providerSyncLockDir, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      label,
      startedAt: new Date().toISOString(),
      cwd: process.cwd()
    }, null, 2)}\n`,
    "utf8"
  );

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await fs.rm(providerSyncLockDir, { recursive: true, force: true });
  };
}

function parseCurrentProvider(configText) {
  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      break;
    }
    const match = trimmed.match(/^model_provider\s*=\s*"([^"]+)"\s*$/);
    if (match) {
      return {
        provider: match[1],
        implicit: false
      };
    }
  }
  return {
    provider: defaultProvider,
    implicit: true
  };
}

function configuredProviderIds(configText) {
  const ids = new Set([defaultProvider]);
  const regex = /^\[model_providers\.([A-Za-z0-9_.-]+)]\s*$/gm;
  for (const match of configText.matchAll(regex)) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

async function readConfigForProviderSync() {
  try {
    const text = await fs.readFile(configPath, "utf8");
    return {
      text,
      ...parseCurrentProvider(text),
      configuredProviders: configuredProviderIds(text)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        text: "",
        provider: defaultProvider,
        implicit: true,
        configuredProviders: [defaultProvider],
        missing: true
      };
    }
    throw error;
  }
}

async function readFirstLine(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    let position = 0;
    let collected = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const hasCr = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d;
        return {
          text: collected.subarray(0, hasCr ? newlineIndex - 1 : newlineIndex).toString("utf8"),
          separator: hasCr ? "\r\n" : "\n",
          offset: newlineIndex + 1
        };
      }
    }
    return {
      text: collected.toString("utf8"),
      separator: "",
      offset: collected.length
    };
  } finally {
    await handle.close();
  }
}

async function listRolloutFiles(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRolloutFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseSessionMeta(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta" || !record.payload || typeof record.payload !== "object") {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function collectProviderSyncChanges(targetProvider) {
  const counts = {
    sessions: {},
    archived_sessions: {}
  };
  const changes = [];
  const unreadable = [];

  for (const dirName of sessionDirs) {
    const rootDir = path.join(codexHome, dirName);
    const files = await listRolloutFiles(rootDir);
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const firstLine = await readFirstLine(filePath);
        const record = parseSessionMeta(firstLine.text);
        if (!record) {
          continue;
        }
        const provider = record.payload.model_provider || "(missing)";
        incrementCount(counts, dirName, provider);
        if (provider !== targetProvider) {
          const updatedRecord = structuredClone(record);
          updatedRecord.payload.model_provider = targetProvider;
          changes.push({
            path: filePath,
            bucket: dirName,
            originalFirstLine: firstLine.text,
            updatedFirstLine: JSON.stringify(updatedRecord),
            separator: firstLine.separator,
            offset: firstLine.offset,
            originalSize: stat.size,
            originalMtimeMs: stat.mtimeMs,
            previousProvider: provider
          });
        }
      } catch (error) {
        unreadable.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    counts,
    changes,
    unreadable
  };
}

async function rewriteRolloutFirstLine(change) {
  const stat = await fs.stat(change.path);
  if (stat.size !== change.originalSize || stat.mtimeMs !== change.originalMtimeMs) {
    return {
      path: change.path,
      updated: false,
      reason: "changed while syncing"
    };
  }

  const current = await readFirstLine(change.path);
  if (current.text !== change.originalFirstLine || current.offset !== change.offset) {
    return {
      path: change.path,
      updated: false,
      reason: "first line changed while syncing"
    };
  }

  const tmpPath = `${change.path}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  await new Promise((resolve, reject) => {
    const writer = fsSync.createWriteStream(tmpPath, { encoding: "utf8" });
    writer.on("error", reject);
    writer.write(change.updatedFirstLine);
    if (change.separator) {
      writer.write(change.separator);
    }

    if (change.offset >= change.originalSize) {
      writer.end();
      writer.once("finish", resolve);
      return;
    }

    const reader = fsSync.createReadStream(change.path, { start: change.offset });
    reader.on("error", reject);
    reader.on("end", () => writer.end());
    writer.once("finish", resolve);
    reader.pipe(writer, { end: false });
  }).catch(async (error) => {
    await fs.rm(tmpPath, { force: true });
    throw error;
  });

  await fs.rename(tmpPath, change.path);
  return {
    path: change.path,
    updated: true
  };
}

async function replaceCurrentRolloutFirstLine(filePath, nextFirstLine, separator) {
  const current = await readFirstLine(filePath);
  const stat = await fs.stat(filePath);
  const tmpPath = `${filePath}.provider-sync-restore.${process.pid}.${Date.now()}.tmp`;
  await new Promise((resolve, reject) => {
    const writer = fsSync.createWriteStream(tmpPath, { encoding: "utf8" });
    writer.on("error", reject);
    writer.write(nextFirstLine);
    if (separator) {
      writer.write(separator);
    }

    if (current.offset >= stat.size) {
      writer.end();
      writer.once("finish", resolve);
      return;
    }

    const reader = fsSync.createReadStream(filePath, { start: current.offset });
    reader.on("error", reject);
    reader.on("end", () => writer.end());
    writer.once("finish", resolve);
    reader.pipe(writer, { end: false });
  }).catch(async (error) => {
    await fs.rm(tmpPath, { force: true });
    throw error;
  });

  await fs.rename(tmpPath, filePath);
}

async function createProviderSyncBackup(targetProvider, changes) {
  const backupDir = path.join(providerSyncBackupRoot, timestampSlug());
  const dbDir = path.join(backupDir, "db");
  await fs.mkdir(dbDir, { recursive: true });

  const copiedDbFiles = [];
  for (const suffix of ["", "-shm", "-wal"]) {
    const fileName = `state_5.sqlite${suffix}`;
    if (await copyFileIfPresent(path.join(codexHome, fileName), path.join(dbDir, fileName))) {
      copiedDbFiles.push(fileName);
    }
  }

  await copyFileIfPresent(configPath, path.join(backupDir, "config.toml"));
  await copyFileIfPresent(globalStatePath, path.join(backupDir, ".codex-global-state.json"));
  await copyFileIfPresent(globalStateBackupPath, path.join(backupDir, ".codex-global-state.json.bak"));

  const createdAt = new Date().toISOString();
  await fs.writeFile(
    path.join(backupDir, "session-meta-backup.json"),
    `${JSON.stringify({
      version: 1,
      namespace: "provider-sync",
      codexHome,
      targetProvider,
      createdAt,
      files: changes.map((change) => ({
        path: change.path,
        originalFirstLine: change.originalFirstLine,
        originalSeparator: change.separator,
        originalMtimeMs: change.originalMtimeMs
      }))
    }, null, 2)}\n`,
    "utf8"
  );

  await fs.writeFile(
    path.join(backupDir, "metadata.json"),
    `${JSON.stringify({
      version: 1,
      namespace: "provider-sync",
      codexHome,
      targetProvider,
      createdAt,
      dbFiles: copiedDbFiles,
      changedSessionFiles: changes.length
    }, null, 2)}\n`,
    "utf8"
  );

  return backupDir;
}

async function createSqliteBackup() {
  const backupRoot = path.join(codexHome, "backups_state", "history-viewer");
  await fs.mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `state_5.${timestampForPath()}.sqlite`);

  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  } finally {
    db?.close();
  }

  return backupPath;
}

function backupFileSync(filePath, namespace) {
  const backupRoot = path.join(codexHome, "backups_state", "history-viewer", namespace);
  fsSync.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `${timestampForPath()}.${safePathPart(filePath)}`);
  fsSync.copyFileSync(filePath, backupPath);
  return backupPath;
}

function updateRolloutUpdatedAtSync(filePath, updatedAtMs) {
  if (!filePath || !fsSync.existsSync(filePath)) {
    return null;
  }

  const backupPath = backupFileSync(filePath, "rollouts");
  const originalText = fsSync.readFileSync(filePath, "utf8");
  const hasTrailingNewline = originalText.endsWith("\n");
  const lines = originalText.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  let lastJsonLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) {
      continue;
    }
    try {
      JSON.parse(lines[index]);
      lastJsonLine = index;
      break;
    } catch {
      // Keep scanning; non-JSON junk should not normally be present.
    }
  }

  if (lastJsonLine === -1) {
    return { backupPath, updated: false, reason: "no JSON lines" };
  }

  const record = JSON.parse(lines[lastJsonLine]);
  record.timestamp = new Date(updatedAtMs).toISOString();
  lines[lastJsonLine] = JSON.stringify(record);
  fsSync.writeFileSync(filePath, `${lines.join("\n")}${hasTrailingNewline ? "\n" : ""}`, "utf8");

  return {
    backupPath,
    updated: true,
    line: lastJsonLine + 1
  };
}

function pathArray(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string" && entry.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value];
  }
  return [];
}

function putPathFirst(paths, cwd) {
  const next = [cwd];
  const seen = new Set([cwd]);
  for (const item of pathArray(paths)) {
    if (!seen.has(item)) {
      seen.add(item);
      next.push(item);
    }
  }
  return next;
}

async function addProjectRootToDesktop(cwd) {
  let originalText;
  try {
    originalText = await fs.readFile(globalStatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        updated: false,
        backupPath: null,
        reason: ".codex-global-state.json not found"
      };
    }
    throw error;
  }

  const state = JSON.parse(originalText);
  const nextProjectOrder = putPathFirst(state["project-order"], cwd);
  const nextSavedRoots = putPathFirst(state["electron-saved-workspace-roots"], cwd);
  const changed = JSON.stringify(state["project-order"] ?? null) !== JSON.stringify(nextProjectOrder)
    || JSON.stringify(state["electron-saved-workspace-roots"] ?? null) !== JSON.stringify(nextSavedRoots);

  if (!changed) {
    return {
      updated: false,
      backupPath: null,
      reason: "already present"
    };
  }

  const backupRoot = path.join(codexHome, "backups_state", "history-viewer");
  await fs.mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `.codex-global-state.${timestampForPath()}.json`);
  await fs.writeFile(backupPath, originalText, "utf8");

  state["project-order"] = nextProjectOrder;
  state["electron-saved-workspace-roots"] = nextSavedRoots;
  const nextText = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(globalStatePath, nextText, "utf8");
  await fs.writeFile(globalStateBackupPath, nextText, "utf8");

  return {
    updated: true,
    backupPath,
    reason: "added"
  };
}

function buildWhere(url) {
  const clauses = [];
  const params = {};
  const archived = url.searchParams.get("archived") || "0";
  if (archived !== "all") {
    if (archived !== "0" && archived !== "1") {
      throw new Error("archived must be 0, 1, or all");
    }
    clauses.push("archived = @archived");
    params.archived = Number(archived);
  }

  const cwd = url.searchParams.get("cwd");
  if (cwd) {
    clauses.push("cwd = @cwd");
    params.cwd = cwd;
  }

  const provider = url.searchParams.get("provider");
  if (provider) {
    clauses.push("model_provider = @provider");
    params.provider = provider;
  }

  const q = url.searchParams.get("q")?.trim();
  if (q) {
    clauses.push(`(
      title LIKE @q
      OR first_user_message LIKE @q
      OR preview LIKE @q
      OR cwd LIKE @q
      OR id LIKE @q
    )`);
    params.q = `%${q}%`;
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function listThreads(url) {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") || "500", 10), 1), 2000);
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") || "0", 10), 0);
  const { whereSql, params } = buildWhere(url);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const column of ["id", "cwd", "title", "updated_at_ms", "created_at_ms", "archived", "model_provider"]) {
      if (!tableHasColumn(db, "threads", column)) {
        throw new Error(`threads table is missing required column: ${column}`);
      }
    }

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM threads ${whereSql}`).get(params);
    const rows = db.prepare(`
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms,
        source,
        model_provider,
        cwd,
        title,
        first_user_message,
        preview,
        archived,
        archived_at,
        model,
        reasoning_effort
      FROM threads
      ${whereSql}
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0) DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    return {
      dbPath,
      total: Number(countRow.count) || 0,
      limit,
      offset,
      rows: rows.map((row) => ({
        ...row,
        created_at_ms: Number(row.created_at_ms ?? row.created_at * 1000 ?? 0),
        updated_at_ms: Number(row.updated_at_ms ?? row.updated_at * 1000 ?? 0),
        archived: Number(row.archived) === 1
      }))
    };
  } finally {
    db?.close();
  }
}

function listFacets() {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const projects = db.prepare(`
      SELECT
        cwd,
        COUNT(*) AS count,
        SUM(CASE WHEN archived = 1 THEN 0 ELSE 1 END) AS active_count,
        MAX(COALESCE(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0)) AS last_updated_ms
      FROM threads
      WHERE cwd IS NOT NULL AND cwd <> ''
      GROUP BY cwd
      ORDER BY last_updated_ms DESC, cwd
    `).all();
    const providers = db.prepare(`
      SELECT model_provider, COUNT(*) AS count
      FROM threads
      GROUP BY model_provider
      ORDER BY count DESC, model_provider
    `).all();
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN archived = 1 THEN 0 ELSE 1 END) AS active,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived
      FROM threads
    `).get();

    return {
      dbPath,
      counts: {
        total: Number(counts.total) || 0,
        active: Number(counts.active) || 0,
        archived: Number(counts.archived) || 0
      },
      projects: projects.map((row) => ({
        cwd: row.cwd,
        count: Number(row.count) || 0,
        activeCount: Number(row.active_count) || 0,
        lastUpdatedMs: Number(row.last_updated_ms) || 0
      })),
      providers: providers.map((row) => ({
        provider: row.model_provider || "(missing)",
        count: Number(row.count) || 0
      }))
    };
  } finally {
    db?.close();
  }
}

async function readSqliteProviderCounts() {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN model_provider IS NULL OR model_provider = '' THEN '(missing)'
          ELSE model_provider
        END AS provider,
        archived,
        COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, provider
    `).all();
    const counts = {
      sessions: {},
      archived_sessions: {}
    };
    for (const row of rows) {
      incrementCount(counts, row.archived ? "archived_sessions" : "sessions", row.provider);
      counts[row.archived ? "archived_sessions" : "sessions"][row.provider] = Number(row.count) || 0;
    }
    return {
      present: true,
      counts
    };
  } catch (error) {
    if (error?.code === "ERR_INVALID_STATE" || /no such table|not a database|malformed/i.test(error?.message ?? "")) {
      return {
        present: false,
        counts: {
          sessions: {},
          archived_sessions: {}
        },
        error: error instanceof Error ? error.message : String(error)
      };
    }
    throw error;
  } finally {
    db?.close();
  }
}

async function providerSyncStatus() {
  const config = await readConfigForProviderSync();
  const targetProvider = config.provider || defaultProvider;
  const [sqliteCounts, rollout, backupSummary] = await Promise.all([
    readSqliteProviderCounts(),
    collectProviderSyncChanges(targetProvider),
    providerSyncBackupSummary()
  ]);

  return {
    codexHome,
    dbPath,
    configPath,
    currentProvider: targetProvider,
    currentProviderImplicit: config.implicit,
    configMissing: Boolean(config.missing),
    configuredProviders: config.configuredProviders,
    sqlite: sqliteCounts,
    rollout: {
      counts: rollout.counts,
      changesNeeded: rollout.changes.length,
      unreadable: rollout.unreadable
    },
    backupRoot: providerSyncBackupRoot,
    backupSummary,
    needsSync: rollout.changes.length > 0
      || Object.entries(sqliteCounts.counts.sessions).some(([provider, count]) => provider !== targetProvider && count > 0)
      || Object.entries(sqliteCounts.counts.archived_sessions).some(([provider, count]) => provider !== targetProvider && count > 0)
  };
}

async function syncProvider(body = {}) {
  const releaseLock = await acquireProviderSyncLock("history-viewer-provider-sync");
  let backupDir = null;
  let appliedChanges = [];
  let transactionOpen = false;
  let db = null;

  try {
    const config = await readConfigForProviderSync();
    const requestedProvider = typeof body.provider === "string" ? body.provider.trim() : "";
    const targetProvider = requestedProvider || config.provider || defaultProvider;
    const collected = await collectProviderSyncChanges(targetProvider);
    backupDir = await createProviderSyncBackup(targetProvider, collected.changes);

    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const providerResult = db.prepare(`
      UPDATE threads
      SET model_provider = @provider
      WHERE COALESCE(model_provider, '') <> @provider
    `).run({ provider: targetProvider });

    for (const change of collected.changes) {
      const result = await rewriteRolloutFirstLine(change);
      if (result.updated) {
        appliedChanges.push(change);
      }
    }

    db.exec("COMMIT");
    transactionOpen = false;

    let checkpointWarning = null;
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      checkpointWarning = error instanceof Error ? error.message : String(error);
    }

    let pruneResult = null;
    let pruneWarning = null;
    try {
      pruneResult = await pruneProviderSyncBackups(providerSyncBackupKeepCount);
    } catch (error) {
      pruneWarning = error instanceof Error ? error.message : String(error);
    }

    return {
      codexHome,
      targetProvider,
      previousProvider: config.provider,
      backupDir,
      sqliteRowsUpdated: providerResult.changes ?? 0,
      changedSessionFiles: appliedChanges.length,
      skippedSessionFiles: collected.changes.length - appliedChanges.length,
      unreadableSessionFiles: collected.unreadable,
      rolloutCountsBefore: collected.counts,
      pruneResult,
      pruneWarning,
      checkpointWarning
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // Keep the original error visible to the user.
      }
    }
    if (appliedChanges.length > 0) {
      for (const change of appliedChanges) {
        try {
          await replaceCurrentRolloutFirstLine(change.path, change.originalFirstLine, change.separator);
        } catch {
          // The backup path is returned in the error so a manual restore is still possible.
        }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(backupDir ? `${message}。已创建备份：${backupDir}` : message);
  } finally {
    db?.close();
    await releaseLock();
  }
}

async function promoteProject(body) {
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) {
    throw new Error("请选择一个项目后再恢复到 Codex App 最近列表");
  }

  const archived = body.archived || "0";
  if (!["0", "1", "all"].includes(archived)) {
    throw new Error("archived must be 0, 1, or all");
  }

  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const backupPath = await createSqliteBackup();
  const desktopRootResult = await addProjectRootToDesktop(cwd);
  const params = { cwd };
  const clauses = ["cwd = @cwd"];
  if (archived !== "all") {
    clauses.push("archived = @archived");
    params.archived = Number(archived);
  }
  if (provider) {
    clauses.push("model_provider = @provider");
    params.provider = provider;
  }
  const whereSql = clauses.join(" AND ");

  let db;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const rows = db.prepare(`
      SELECT
        id,
        rollout_path,
        title,
        COALESCE(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0) AS sort_ts
      FROM threads
      WHERE ${whereSql}
      ORDER BY sort_ts DESC, id DESC
    `).all(params);

    if (rows.length === 0) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        backupPath,
        desktopRoot: desktopRootResult,
        promoted: 0,
        cwd,
        archived,
        provider,
        message: "这个筛选条件下没有可提升的会话"
      };
    }

    const maxRow = db.prepare(`
      SELECT MAX(COALESCE(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0)) AS max_ms
      FROM threads
    `).get();
    const maxMs = Number(maxRow?.max_ms) || 0;
    const startMs = Math.max(Date.now(), maxMs) + rows.length * 1000;
    const update = db.prepare(`
      UPDATE threads
      SET updated_at_ms = @updated_at_ms,
          updated_at = @updated_at
      WHERE id = @id
    `);

    let promoted = 0;
    const rolloutResults = [];
    rows.forEach((row, index) => {
      const nextMs = startMs - index * 1000;
      const rolloutResult = updateRolloutUpdatedAtSync(row.rollout_path, nextMs);
      if (rolloutResult) {
        rolloutResults.push({
          id: row.id,
          rolloutPath: row.rollout_path,
          ...rolloutResult
        });
      }
      promoted += update.run({
        id: row.id,
        updated_at_ms: nextMs,
        updated_at: Math.floor(nextMs / 1000)
      }).changes ?? 0;
    });

    db.exec("COMMIT");
    transactionOpen = false;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    return {
      backupPath,
      desktopRoot: desktopRootResult,
      promoted,
      cwd,
      archived,
      provider,
      firstUpdatedMs: startMs,
      lastUpdatedMs: startMs - (rows.length - 1) * 1000,
      rolloutResults
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // Keep the original error.
      }
    }
    throw error;
  } finally {
    db?.close();
  }
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }
    if (url.pathname.startsWith("/api/") && !hasValidAccessToken(req, url)) {
      forbidden(res, "Invalid local access token");
      return;
    }
    if (url.pathname === "/api/health") {
      if (req.method !== "GET") {
        badRequest(res, "GET required");
        return;
      }
      json(res, 200, {
        ok: true,
        codexHome,
        dbPath,
        configPath,
        platform: process.platform,
        node: process.version
      });
      return;
    }
    if (url.pathname === "/api/license/status") {
      if (req.method !== "GET") {
        badRequest(res, "GET required");
        return;
      }
      json(res, 200, await localLicenseSnapshot());
      return;
    }
    if (url.pathname === "/api/license/activate") {
      if (req.method !== "POST") {
        badRequest(res, "POST required");
        return;
      }
      json(res, 200, await activateLocalLicense(await readJsonBody(req)));
      return;
    }
    if (url.pathname === "/api/license/refresh") {
      if (req.method !== "POST") {
        badRequest(res, "POST required");
        return;
      }
      json(res, 200, await refreshLocalLicense());
      return;
    }
    if (url.pathname === "/api/license/deactivate") {
      if (req.method !== "POST") {
        badRequest(res, "POST required");
        return;
      }
      json(res, 200, await deactivateLocalLicense());
      return;
    }
    if (url.pathname === "/api/threads") {
      if (req.method !== "GET") {
        badRequest(res, "GET required");
        return;
      }
      if (!(await requireLicense(res))) {
        return;
      }
      json(res, 200, listThreads(url));
      return;
    }
    if (url.pathname === "/api/promote-project") {
      if (req.method !== "POST") {
        badRequest(res, "POST required");
        return;
      }
      if (!(await requireLicense(res))) {
        return;
      }
      json(res, 200, await promoteProject(await readJsonBody(req)));
      return;
    }
    if (url.pathname === "/api/provider-sync/status") {
      if (req.method !== "GET") {
        badRequest(res, "GET required");
        return;
      }
      if (!(await requireLicense(res))) {
        return;
      }
      json(res, 200, await providerSyncStatus());
      return;
    }
    if (url.pathname === "/api/provider-sync/sync") {
      if (req.method !== "POST") {
        badRequest(res, "POST required");
        return;
      }
      if (!(await requireLicense(res))) {
        return;
      }
      json(res, 200, await syncProvider(await readJsonBody(req)));
      return;
    }
    if (url.pathname === "/api/facets") {
      if (req.method !== "GET") {
        badRequest(res, "GET required");
        return;
      }
      if (!(await requireLicense(res))) {
        return;
      }
      json(res, 200, listFacets());
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
      dbPath
    });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Codex history viewer: http://${host}:${actualPort}`);
  console.log(`Reading SQLite database: ${dbPath}`);
});
