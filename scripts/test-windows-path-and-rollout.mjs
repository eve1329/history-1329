import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  desktopStateMatchesProject,
  normalizeDesktopStateForProject,
  normalizePathForComparison,
  putPathFirst,
  updateRolloutUpdatedAtSync
} from "../server.mjs";

const windowsSamples = [
  {
    input: String.raw`C:\Users\ming\project`,
    expected: String.raw`c:\users\ming\project`
  },
  {
    input: String.raw`\\?\C:\Users\ming\project`,
    expected: String.raw`c:\users\ming\project`
  },
  {
    input: String.raw`\\?\UNC\server\share\project`,
    expected: String.raw`\\server\share\project`
  },
  {
    input: String.raw`\\server\share\project`,
    expected: String.raw`\\server\share\project`
  }
];

for (const sample of windowsSamples) {
  assert.equal(normalizePathForComparison(sample.input, "win32"), sample.expected);
}

assert.deepEqual(
  putPathFirst(
    [
      String.raw`\\?\C:\Users\ming\project`,
      String.raw`C:\Users\ming\other`
    ],
    String.raw`C:\Users\ming\project`,
    "win32"
  ),
  [String.raw`C:\Users\ming\project`, String.raw`C:\Users\ming\other`]
);

const originalState = {
  "project-order": [String.raw`\\?\C:\Users\ming\project`, String.raw`C:\Users\ming\project\older`],
  "electron-saved-workspace-roots": [String.raw`\\?\C:\Users\ming\project`],
  "active-workspace-roots": [String.raw`C:\Users\ming\other`],
  "selected-remote-host-id": "remote-1",
  "active-remote-project-id": "remote-project-1"
};
const normalized = normalizeDesktopStateForProject(originalState, String.raw`C:\Users\ming\project`, "win32");
assert.deepEqual(normalized.nextState["project-order"][0], String.raw`C:\Users\ming\project`);
assert.deepEqual(normalized.nextState["electron-saved-workspace-roots"][0], String.raw`C:\Users\ming\project`);
assert.deepEqual(normalized.nextState["active-workspace-roots"], [String.raw`C:\Users\ming\other`]);
assert.equal(normalized.nextState["selected-remote-host-id"], "remote-1");
assert.equal(normalized.nextState["active-remote-project-id"], "remote-project-1");
assert.equal(desktopStateMatchesProject(normalized.nextState, String.raw`C:\Users\ming\project`, "win32"), true);

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-rollout-test-"));
try {
  const filePath = path.join(tmpDir, "rollout-123.jsonl");
  const first = { type: "session_meta", payload: { model_provider: "anthropic" }, timestamp: "2026-01-01T00:00:00.000Z" };
  const second = { type: "event", payload: { value: 1 } };
  await fsp.writeFile(filePath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

  let readAsString = false;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (args.length === 1 && args[0] === filePath) {
      const result = originalReadFileSync(...args);
      readAsString = readAsString || typeof result === "string";
      return result;
    }
    return originalReadFileSync(...args);
  };

  const result = updateRolloutUpdatedAtSync(filePath, Date.parse("2026-05-20T12:34:56.000Z"));
  fs.readFileSync = originalReadFileSync;

  assert.equal(readAsString, false);
  assert.equal(result?.updated, true);
  assert.equal(result?.line, 2);

  const updated = await fsp.readFile(filePath, "utf8");
  assert.match(updated, /"timestamp":"2026-05-20T12:34:56\.000Z"/);
  assert.match(updated, /"type":"event"/);
  assert.ok(updated.endsWith("\n"));
} finally {
  await fsp.rm(tmpDir, { recursive: true, force: true });
}

console.log("windows path and rollout regressions ok");
