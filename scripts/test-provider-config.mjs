import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  parseCurrentProvider,
  configuredProviderIds,
  explicitConfiguredProviderIds,
  configProviderDiagnostics,
  renameProviderSectionInConfig
} from "../server.mjs";

const sampleConfig = `model_provider = "cherry"
model = "gpt-5.4"

[model_providers.qt]
name = "qt"
base_url = "https://gptch.cloud/v1"
wire_api = "responses"
requires_openai_auth = true

[features]
multi_agent = true
`;

const parsed = parseCurrentProvider(sampleConfig);
assert.deepEqual(parsed, { provider: "cherry", implicit: false });
assert.deepEqual(configuredProviderIds(sampleConfig), ["openai", "qt"]);
assert.deepEqual(explicitConfiguredProviderIds(sampleConfig), ["qt"]);

const diagnostics = configProviderDiagnostics({
  ...parsed,
  configuredProviders: configuredProviderIds(sampleConfig),
  explicitProviders: explicitConfiguredProviderIds(sampleConfig)
});
assert.equal(diagnostics.configProviderDefined, false);
assert.equal(diagnostics.configProviderFixAvailable, true);
assert.equal(diagnostics.configProviderFixCandidate, "qt");
assert.match(diagnostics.configProviderWarning, /model_provider = "cherry"/);

const renamed = renameProviderSectionInConfig(sampleConfig, "qt", "cherry");
assert.match(renamed.text, /\[model_providers\.cherry]/);
assert.match(renamed.text, /name = "cherry"/);
assert.match(renamed.text, /base_url = "https:\/\/gptch\.cloud\/v1"/);
assert.equal(renamed.renamedName, true);

const providerAfterRename = {
  ...parseCurrentProvider(renamed.text),
  configuredProviders: configuredProviderIds(renamed.text),
  explicitProviders: explicitConfiguredProviderIds(renamed.text)
};
assert.equal(configProviderDiagnostics(providerAfterRename).configProviderDefined, true);

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-provider-config-"));
const codexHome = path.join(tmpRoot, ".codex");
await fs.mkdir(codexHome, { recursive: true });
await fs.writeFile(path.join(codexHome, "config.toml"), sampleConfig, "utf8");
await fs.writeFile(path.join(tmpRoot, "license.json"), JSON.stringify({ required: false }), "utf8");

const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
db.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    model_provider TEXT,
    archived INTEGER,
    updated_at_ms INTEGER
  );
  INSERT INTO threads (id, cwd, model_provider, archived, updated_at_ms)
  VALUES ('thread-1', '/tmp/project', 'qt', 0, 1);
`);
db.close();

const token = "provider-config-test-token";
const port = await freePort();
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_HISTORY_LICENSE_CONFIG: path.join(tmpRoot, "license.json"),
    CODEX_HISTORY_VIEWER_TOKEN: token,
    PORT: String(port),
    HOST: "127.0.0.1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForServer(child, port);
  const statusBefore = await getJson(port, "/api/provider-sync/status", token);
  assert.equal(statusBefore.currentProvider, "cherry");
  assert.equal(statusBefore.configProviderDefined, false);
  assert.equal(statusBefore.configProviderFixAvailable, true);
  assert.equal(statusBefore.configProviderFixCandidate, "qt");
  await assert.rejects(
    () => postJson(port, "/api/provider-sync/sync", token),
    /Provider "cherry" is not defined/
  );

  const fix = await postJson(port, "/api/provider-sync/fix-config-provider", token);
  assert.equal(fix.changed, true);
  assert.equal(fix.oldProvider, "qt");
  assert.equal(fix.newProvider, "cherry");

  const fixedConfig = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(fixedConfig, /\[model_providers\.cherry]/);
  assert.match(fixedConfig, /name = "cherry"/);
  assert.doesNotMatch(fixedConfig, /\[model_providers\.qt]/);

  const backupConfig = await fs.readFile(fix.backupPath, "utf8");
  assert.equal(backupConfig, sampleConfig);

  const statusAfter = await getJson(port, "/api/provider-sync/status", token);
  assert.equal(statusAfter.configProviderDefined, true);
  assert.equal(statusAfter.configProviderWarning, "");

  const sync = await postJson(port, "/api/provider-sync/sync", token);
  assert.equal(sync.targetProvider, "cherry");
  assert.equal(sync.sqliteRowsUpdated, 1);
} finally {
  child.kill();
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log("provider config diagnostics ok");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`server did not start on port ${port}: ${output}`));
      }
    }, 5000);

    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (!settled && output.includes(`http://127.0.0.1:${port}`)) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited with code ${code}: ${output}`));
      }
    });
  });
}

function getJson(port, pathname, token) {
  return requestJson(port, pathname, token, "GET");
}

function postJson(port, pathname, token) {
  return requestJson(port, pathname, token, "POST");
}

function requestJson(port, pathname, token, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        "x-codex-history-token": token,
        "content-type": "application/json"
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const payload = text ? JSON.parse(text) : {};
        if (res.statusCode < 200 || res.statusCode >= 300 || payload.error) {
          reject(new Error(payload.error || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(payload);
      });
    });
    req.on("error", reject);
    if (method === "POST") {
      req.write("{}");
    }
    req.end();
  });
}
