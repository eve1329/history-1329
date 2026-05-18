const state = {
  license: null,
  facets: null,
  providerSync: null,
  rows: [],
  total: 0,
  limit: 100,
  offset: 0,
  loading: false,
  syncingProvider: false
};

const apiBase = window.location.protocol === "file:" ? "http://127.0.0.1:3999" : "";
const queryAccessToken = new URLSearchParams(window.location.search).get("access_token") || "";
if (queryAccessToken) {
  window.sessionStorage.setItem("codexHistoryAccessToken", queryAccessToken);
}
const accessToken = queryAccessToken || window.sessionStorage.getItem("codexHistoryAccessToken") || "";

if (queryAccessToken && window.history.replaceState) {
  window.history.replaceState(null, "", window.location.pathname);
}

const elements = {
  licenseGate: document.querySelector("#licenseGate"),
  appShell: document.querySelector("#appShell"),
  licenseForm: document.querySelector("#licenseForm"),
  licenseKey: document.querySelector("#licenseKey"),
  activateLicense: document.querySelector("#activateLicense"),
  licenseStatus: document.querySelector("#licenseStatus"),
  licenseMessage: document.querySelector("#licenseMessage"),
  licenseInline: document.querySelector("#licenseInline"),
  licenseInlineText: document.querySelector("#licenseInlineText"),
  deactivateLicense: document.querySelector("#deactivateLicense"),
  dbPath: document.querySelector("#dbPath"),
  summary: document.querySelector("#summary"),
  query: document.querySelector("#query"),
  project: document.querySelector("#project"),
  provider: document.querySelector("#provider"),
  archived: document.querySelector("#archived"),
  projectList: document.querySelector("#projectList"),
  threads: document.querySelector("#threads"),
  resultInfo: document.querySelector("#resultInfo"),
  promoteStatus: document.querySelector("#promoteStatus"),
  promoteProject: document.querySelector("#promoteProject"),
  providerSyncSummary: document.querySelector("#providerSyncSummary"),
  providerSyncDetail: document.querySelector("#providerSyncDetail"),
  providerSyncWarning: document.querySelector("#providerSyncWarning"),
  providerSyncStatus: document.querySelector("#providerSyncStatus"),
  refreshProviderSync: document.querySelector("#refreshProviderSync"),
  fixProviderConfig: document.querySelector("#fixProviderConfig"),
  syncProvider: document.querySelector("#syncProvider"),
  loadMore: document.querySelector("#loadMore")
};

function formatDate(ms) {
  if (!ms) {
    return "未知时间";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function basename(input) {
  if (!input) {
    return "(无项目)";
  }
  const parts = input.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || input;
}

function dirname(input) {
  if (!input) {
    return "";
  }
  const normalized = input.replaceAll("\\", "/");
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(normalized);
  const isUnc = normalized.startsWith("//");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return input;
  }
  const joined = parts.slice(0, -1).join("/");
  if (isUnc) {
    return `//${joined}`;
  }
  return isWindowsAbsolute ? joined : `/${joined}`;
}

function truncate(input, size = 420) {
  const value = (input || "").trim();
  if (value.length <= size) {
    return value;
  }
  return `${value.slice(0, size)}...`;
}

function providerTotal(counts) {
  return Object.values(counts || {}).reduce((total, value) => total + Number(value || 0), 0);
}

function renderLicenseInline() {
  const license = state.license;
  if (!license?.active || !license.required) {
    elements.licenseInline.hidden = true;
    return;
  }
  elements.licenseInline.hidden = false;
  const licenseExpires = license.licenseExpiresAt ? `，授权码有效至：${formatDate(Date.parse(license.licenseExpiresAt))}` : "";
  const tokenRefresh = license.tokenExpiresAt ? `，本机下次需联网校验：${formatDate(Date.parse(license.tokenExpiresAt))}` : "";
  elements.licenseInlineText.textContent = `已激活 ${license.licenseKey || ""}，机器 ${license.machineCount || 1}/${license.maxMachines || 2}${licenseExpires}${tokenRefresh}`;
}

function renderLicenseStatus(message = "") {
  const license = state.license;
  elements.licenseStatus.textContent = message || license?.message || "";
  elements.licenseStatus.className = `license-status ${license?.active ? "success" : license?.reason === "license_not_configured" ? "error" : ""}`;

  if (license?.active) {
    elements.licenseMessage.textContent = license.required
      ? `已激活：${license.licenseKey || "当前机器"}。可用机器 ${license.machineCount || 1}/${license.maxMachines || 2}。`
      : "当前构建未启用激活限制。";
    elements.licenseGate.hidden = true;
    elements.appShell.hidden = false;
    renderLicenseInline();
    return;
  }

  elements.licenseGate.hidden = false;
  elements.appShell.hidden = true;
  elements.licenseInline.hidden = true;
  if (license?.reason === "license_not_configured") {
    elements.licenseMessage.textContent = "此构建要求激活，但没有内置授权服务器配置。请联系发布者重新打包。";
    elements.activateLicense.disabled = true;
  } else {
    elements.licenseMessage.textContent = "这个版本需要激活后使用。一个激活码最多可绑定 2 台机器。";
    elements.activateLicense.disabled = false;
  }
}

function licenseErrorMessage(error) {
  const payload = error.payload || {};
  if (payload.code === "machine_limit_reached") {
    return `这枚激活码已经绑定 ${payload.machineCount}/${payload.maxMachines} 台机器，不能继续激活。`;
  }
  if (payload.code === "license_not_found") {
    return "激活码不存在，请检查后重试。";
  }
  if (payload.code === "license_disabled") {
    return "激活码已被禁用，请联系发布者。";
  }
  if (payload.code === "license_expired") {
    return "激活码已过期，请联系发布者。";
  }
  return error.message;
}

function formatProviderCounts(counts) {
  const entries = Object.entries(counts || {}).filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) {
    return "无";
  }
  return entries
    .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]))
    .map(([provider, count]) => `${provider} ${count}`)
    .join(" / ");
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

async function requestJson(url) {
  const response = await fetch(`${apiBase}${url}`, {
    cache: "no-store",
    headers: accessToken ? { "x-codex-history-token": accessToken } : {}
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function postJson(url, body = {}) {
  const response = await fetch(`${apiBase}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { "x-codex-history-token": accessToken } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function selectedFilters() {
  return {
    q: elements.query.value.trim(),
    cwd: elements.project.value,
    provider: elements.provider.value,
    archived: elements.archived.value
  };
}

function buildThreadUrl({ append = false } = {}) {
  const filters = selectedFilters();
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(append ? state.offset : 0),
    archived: filters.archived
  });
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.cwd) {
    params.set("cwd", filters.cwd);
  }
  if (filters.provider) {
    params.set("provider", filters.provider);
  }
  return `/api/threads?${params}`;
}

function renderSummary() {
  const counts = state.facets?.counts || { total: 0, active: 0, archived: 0 };
  elements.summary.innerHTML = [
    ["全部", counts.total],
    ["未归档", counts.active],
    ["已归档", counts.archived]
  ].map(([label, value]) => `
    <div class="summary-item">
      <strong>${value}</strong>
      <span>${label}</span>
    </div>
  `).join("");
}

function renderSelects() {
  const currentProject = elements.project.value;
  const currentProvider = elements.provider.value;
  const projects = state.facets?.projects || [];
  const providers = state.facets?.providers || [];

  elements.project.innerHTML = [
    `<option value="">全部项目</option>`,
    ...projects.map((project) => (
      `<option value="${escapeHtml(project.cwd)}">${escapeHtml(basename(project.cwd))} (${project.activeCount}/${project.count}) — ${escapeHtml(dirname(project.cwd))}</option>`
    ))
  ].join("");
  elements.project.value = currentProject;

  elements.provider.innerHTML = [
    `<option value="">全部</option>`,
    ...providers.map((provider) => (
      `<option value="${escapeHtml(provider.provider)}">${escapeHtml(provider.provider)} (${provider.count})</option>`
    ))
  ].join("");
  elements.provider.value = currentProvider;
}

function renderProjects() {
  const selected = elements.project.value;
  const projects = state.facets?.projects || [];
  elements.projectList.innerHTML = projects.map((project) => {
    const isActive = selected === project.cwd;
    return `
      <button class="project-button ${isActive ? "active" : ""}" type="button" data-cwd="${escapeHtml(project.cwd)}">
        <div class="project-name" title="${escapeHtml(project.cwd)}">${escapeHtml(basename(project.cwd))}</div>
        <div class="project-meta">${project.activeCount} 未归档 / ${project.count} 全部 · ${formatDate(project.lastUpdatedMs)}</div>
      </button>
    `;
  }).join("");
}

function renderProviderSync() {
  const status = state.providerSync;
  elements.refreshProviderSync.disabled = state.syncingProvider;
  elements.fixProviderConfig.hidden = !status?.configProviderFixAvailable;
  elements.fixProviderConfig.disabled = state.syncingProvider || !status?.configProviderFixAvailable;
  elements.syncProvider.disabled = state.syncingProvider || !status || !status.needsSync || !status.configProviderDefined;

  if (!status) {
    elements.providerSyncSummary.textContent = "正在读取 Codex provider 状态...";
    elements.providerSyncDetail.textContent = "";
    elements.providerSyncWarning.hidden = true;
    elements.providerSyncWarning.textContent = "";
    return;
  }

  const current = status.currentProvider || "openai";
  const implicit = status.currentProviderImplicit ? "隐式默认" : "config.toml";
  const sqliteSessions = status.sqlite?.counts?.sessions || {};
  const sqliteArchived = status.sqlite?.counts?.archived_sessions || {};
  const rolloutSessions = status.rollout?.counts?.sessions || {};
  const rolloutArchived = status.rollout?.counts?.archived_sessions || {};
  const sqliteTotal = providerTotal(sqliteSessions) + providerTotal(sqliteArchived);
  const rolloutTotal = providerTotal(rolloutSessions) + providerTotal(rolloutArchived);
  const needsText = status.needsSync ? "需要同步" : "已同步";

  elements.providerSyncSummary.innerHTML = `
    <span>当前 Provider：<strong>${escapeHtml(current)}</strong></span>
    <span>${escapeHtml(implicit)}</span>
    <span class="${status.needsSync ? "sync-needed" : "sync-ok"}">${needsText}</span>
  `;
  elements.providerSyncDetail.textContent = [
    `SQLite ${sqliteTotal} 条：未归档 ${formatProviderCounts(sqliteSessions)}；已归档 ${formatProviderCounts(sqliteArchived)}`,
    `Rollout ${rolloutTotal} 个：未归档 ${formatProviderCounts(rolloutSessions)}；已归档 ${formatProviderCounts(rolloutArchived)}`,
    `config.toml 已定义 Provider：${(status.configuredProviders || []).join(" / ") || "无"}`,
    `备份 ${status.backupSummary?.count ?? 0} 个：${status.backupRoot}`
  ].join("\n");

  if (status.configProviderWarning) {
    const fixHint = status.configProviderFixAvailable && status.configProviderFixCandidate
      ? `可备份后把 [model_providers.${status.configProviderFixCandidate}] 重命名为 [model_providers.${current}]。`
      : "请手动确认要改哪一个 provider 配置块。";
    elements.providerSyncWarning.hidden = false;
    elements.providerSyncWarning.textContent = `${status.configProviderWarning} ${fixHint} Provider Sync 只同步历史记录，不会自动修改 config.toml。`;
  } else {
    elements.providerSyncWarning.hidden = true;
    elements.providerSyncWarning.textContent = "";
  }

  if (status.rollout?.unreadable?.length) {
    elements.providerSyncStatus.textContent = `有 ${status.rollout.unreadable.length} 个 rollout 文件读取失败，同步时会跳过。`;
    elements.providerSyncStatus.className = "provider-sync-status error";
  } else if (!elements.providerSyncStatus.classList.contains("success")) {
    elements.providerSyncStatus.textContent = "";
    elements.providerSyncStatus.className = "provider-sync-status";
  }
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function renderThreads() {
  elements.resultInfo.textContent = `显示 ${state.rows.length} / ${state.total}`;
  elements.loadMore.disabled = state.loading || state.rows.length >= state.total;
  elements.promoteProject.disabled = state.loading || !elements.project.value;

  if (state.rows.length === 0) {
    elements.threads.innerHTML = `<div class="empty">没有匹配的历史。</div>`;
    return;
  }

  elements.threads.innerHTML = state.rows.map((thread) => {
    const title = thread.title || thread.first_user_message || "(无标题)";
    const preview = truncate(thread.preview || thread.first_user_message || "");
    const resumeCommand = `codex resume ${thread.id}`;
    const badges = [
      thread.model_provider,
      thread.source,
      thread.model,
      thread.reasoning_effort,
      thread.archived ? "archived" : null
    ].filter(Boolean);

    return `
      <article class="thread">
        <div class="thread-header">
          <h2 class="thread-title">${escapeHtml(title)}</h2>
          <div class="thread-time">${formatDate(thread.updated_at_ms)}</div>
        </div>
        <div class="thread-path">${escapeHtml(thread.cwd)}</div>
        ${preview ? `<div class="thread-preview">${escapeHtml(preview)}</div>` : ""}
        <div class="badges">
          ${badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join("")}
        </div>
        <div class="thread-actions">
          <button type="button" data-copy="${escapeHtml(resumeCommand)}">复制恢复命令</button>
          <button type="button" data-copy="${escapeHtml(thread.id)}">复制 ID</button>
          <code>${escapeHtml(resumeCommand)}</code>
        </div>
      </article>
    `;
  }).join("");
}

async function loadFacets() {
  state.facets = await requestJson("/api/facets");
  elements.dbPath.textContent = state.facets.dbPath;
  renderSummary();
  renderSelects();
  renderProjects();
}

async function loadProviderSyncStatus() {
  try {
    state.providerSync = await requestJson("/api/provider-sync/status");
    renderProviderSync();
  } catch (error) {
    elements.providerSyncSummary.textContent = "Provider 状态读取失败";
    elements.providerSyncDetail.textContent = "";
    elements.providerSyncWarning.hidden = true;
    elements.providerSyncWarning.textContent = "";
    elements.providerSyncStatus.textContent = error.message;
    elements.providerSyncStatus.className = "provider-sync-status error";
    elements.fixProviderConfig.hidden = true;
    elements.fixProviderConfig.disabled = true;
    elements.syncProvider.disabled = true;
  }
}

async function loadThreads({ append = false } = {}) {
  if (state.loading) {
    return;
  }
  state.loading = true;
  elements.loadMore.disabled = true;
  try {
    const payload = await requestJson(buildThreadUrl({ append }));
    state.total = payload.total;
    state.offset = payload.offset + payload.rows.length;
    state.rows = append ? [...state.rows, ...payload.rows] : payload.rows;
    renderThreads();
  } catch (error) {
    elements.threads.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  } finally {
    state.loading = false;
    elements.loadMore.disabled = state.rows.length >= state.total;
    elements.promoteProject.disabled = !elements.project.value;
  }
}

async function resetAndLoad() {
  state.offset = 0;
  state.rows = [];
  elements.promoteStatus.textContent = "";
  elements.promoteStatus.className = "promote-status";
  renderProjects();
  await loadThreads();
}

elements.licenseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const licenseKey = elements.licenseKey.value.trim();
  if (!licenseKey) {
    renderLicenseStatus("请输入激活码。");
    return;
  }

  elements.activateLicense.disabled = true;
  renderLicenseStatus("正在连接授权服务器并激活...");
  try {
    state.license = await postJson("/api/license/activate", { licenseKey });
    renderLicenseStatus("激活成功，正在加载历史...");
    await bootApp();
  } catch (error) {
    elements.licenseStatus.textContent = licenseErrorMessage(error);
    elements.licenseStatus.className = "license-status error";
  } finally {
    elements.activateLicense.disabled = false;
  }
});

elements.deactivateLicense.addEventListener("click", async () => {
  const ok = window.confirm("解绑这台机器？解绑后本机需要重新激活才能继续使用，但会释放一个机器名额。");
  if (!ok) {
    return;
  }
  elements.deactivateLicense.disabled = true;
  try {
    state.license = await postJson("/api/license/deactivate");
    state.facets = null;
    state.providerSync = null;
    state.rows = [];
    renderLicenseStatus("已解绑本机。");
  } catch (error) {
    window.alert(error.message);
  } finally {
    elements.deactivateLicense.disabled = false;
  }
});

elements.projectList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cwd]");
  if (!button) {
    return;
  }
  const cwd = button.dataset.cwd;
  elements.project.value = elements.project.value === cwd ? "" : cwd;
  await resetAndLoad();
});

elements.query.addEventListener("input", debounce(resetAndLoad, 180));
elements.project.addEventListener("change", resetAndLoad);
elements.provider.addEventListener("change", resetAndLoad);
elements.archived.addEventListener("change", resetAndLoad);
elements.loadMore.addEventListener("click", () => loadThreads({ append: true }));
elements.refreshProviderSync.addEventListener("click", async () => {
  elements.providerSyncStatus.textContent = "";
  elements.providerSyncStatus.className = "provider-sync-status";
  await loadProviderSyncStatus();
});
elements.fixProviderConfig.addEventListener("click", async () => {
  const status = state.providerSync;
  const oldProvider = status?.configProviderFixCandidate;
  const newProvider = status?.currentProvider || "openai";
  if (!oldProvider) {
    return;
  }

  const ok = window.confirm(`备份 config.toml 后，把 [model_providers.${oldProvider}] 改名为 [model_providers.${newProvider}]，并同步 name 字段？`);
  if (!ok) {
    return;
  }

  state.syncingProvider = true;
  elements.fixProviderConfig.disabled = true;
  elements.syncProvider.disabled = true;
  elements.refreshProviderSync.disabled = true;
  elements.providerSyncStatus.textContent = "正在备份并修复 config.toml provider 配置名...";
  elements.providerSyncStatus.className = "provider-sync-status";

  try {
    const result = await postJson("/api/provider-sync/fix-config-provider");
    if (result.changed) {
      const nameText = result.renamedName ? "，并已更新 name 字段" : "";
      elements.providerSyncStatus.textContent = `已把 ${result.oldProvider} 改为 ${result.newProvider}${nameText}。备份：${result.backupPath}`;
    } else {
      elements.providerSyncStatus.textContent = result.reason || "config.toml 已经是自洽状态。";
    }
    elements.providerSyncStatus.className = "provider-sync-status success";
    await loadProviderSyncStatus();
  } catch (error) {
    elements.providerSyncStatus.textContent = error.message;
    elements.providerSyncStatus.className = "provider-sync-status error";
  } finally {
    state.syncingProvider = false;
    renderProviderSync();
  }
});
elements.syncProvider.addEventListener("click", async () => {
  const provider = state.providerSync?.currentProvider || "openai";
  const ok = window.confirm(`把历史会话 Provider 同步为「${provider}」？这会修改 state_5.sqlite 和 rollout 文件元数据，执行前会自动备份。`);
  if (!ok) {
    return;
  }

  state.syncingProvider = true;
  elements.syncProvider.disabled = true;
  elements.refreshProviderSync.disabled = true;
  elements.providerSyncStatus.textContent = "正在备份并同步 Provider...";
  elements.providerSyncStatus.className = "provider-sync-status";

  try {
    const result = await postJson("/api/provider-sync/sync", {
      provider
    });
    const warnings = [
      result.skippedSessionFiles ? `跳过 ${result.skippedSessionFiles} 个 rollout。` : "",
      result.checkpointWarning ? `SQLite checkpoint 警告：${result.checkpointWarning}` : "",
      result.pruneWarning ? `备份清理警告：${result.pruneWarning}` : ""
    ].filter(Boolean).join(" ");
    elements.providerSyncStatus.textContent = `已同步到 ${result.targetProvider}：SQLite ${result.sqliteRowsUpdated} 行，rollout ${result.changedSessionFiles} 个。备份：${result.backupDir}${warnings ? ` ${warnings}` : ""}`;
    elements.providerSyncStatus.className = "provider-sync-status success";
    await loadFacets();
    await loadProviderSyncStatus();
    await resetAndLoad();
  } catch (error) {
    elements.providerSyncStatus.textContent = error.message;
    elements.providerSyncStatus.className = "provider-sync-status error";
  } finally {
    state.syncingProvider = false;
    renderProviderSync();
  }
});
elements.promoteProject.addEventListener("click", async () => {
  const cwd = elements.project.value;
  if (!cwd) {
    elements.promoteStatus.textContent = "先选择一个项目。";
    elements.promoteStatus.className = "promote-status error";
    return;
  }

  const selected = selectedFilters();
  const projectName = basename(cwd);
  const ok = window.confirm(`把项目「${projectName}」的会话恢复到 Codex App 最近列表？这会修改这些会话的排序时间。`);
  if (!ok) {
    return;
  }

  elements.promoteProject.disabled = true;
  elements.promoteStatus.textContent = "正在备份并恢复...";
  elements.promoteStatus.className = "promote-status";

  try {
    const result = await postJson("/api/promote-project", {
      cwd,
      archived: selected.archived,
      provider: selected.provider
    });
    const rootText = result.desktopRoot?.updated ? "已加入 Codex App 项目列表。" : "Codex App 项目列表已存在。";
    const retryText = Number(result.desktopRoot?.attempts) > 1 ? `（自动重试 ${result.desktopRoot.attempts} 次）` : "";
    const remoteHint = Array.isArray(result.desktopRoot?.clearedRemoteKeys) && result.desktopRoot.clearedRemoteKeys.length > 0
      ? "已清理远程会话选择状态。"
      : "";
    const verifiedText = result.desktopRoot?.verified
      ? `已确认生效（连续稳定 ${result.desktopRoot.verification?.stableChecks || 2} 次）。`
      : "尚未确认稳定生效，可能还在被 Codex 写回覆盖。";
    const warningText = result.desktopRoot?.warning ? ` 注意：${result.desktopRoot.warning}` : "";
    elements.promoteStatus.textContent = `已恢复 ${result.promoted} 条。${rootText}${retryText}${remoteHint ? ` ${remoteHint}` : ""} ${verifiedText} 备份：${result.backupPath}${warningText}`;
    elements.promoteStatus.className = "promote-status success";
    await loadFacets();
    await loadThreads();
  } catch (error) {
    elements.promoteStatus.textContent = error.message;
    elements.promoteStatus.className = "promote-status error";
  } finally {
    elements.promoteProject.disabled = !elements.project.value;
  }
});

elements.threads.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) {
    return;
  }
  const value = button.dataset.copy;
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = "已复制";
  window.setTimeout(() => {
    button.textContent = original;
  }, 900);
});

async function bootApp() {
  if (!state.license?.active) {
    renderLicenseStatus();
    return;
  }
  await loadFacets();
  await loadProviderSyncStatus();
  await loadThreads();
}

async function boot() {
  try {
    state.license = await requestJson("/api/license/status");
    renderLicenseStatus();
    if (state.license.active) {
      await bootApp();
    }
  } catch (error) {
    elements.licenseGate.hidden = false;
    elements.appShell.hidden = true;
    elements.licenseStatus.textContent = error.message;
    elements.licenseStatus.className = "license-status error";
  }
}

await boot();
