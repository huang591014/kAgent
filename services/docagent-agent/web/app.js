/* DocAgent 前端：任务提交 + 任务详情（轮询、待补卡、结果渲染）。 */

const $ = (id) => document.getElementById(id);
const PIPELINE_BASE = localStorage.getItem("pipelineBase") || "http://localhost:8000";

const state = {
  taskId: null,
  pollTimer: null,
  pendingUploads: [], // 待补卡上传的文件 → {doc_id, version, role}
  currentPending: null,
};

const identity = () => ({
  "x-tenant-id": $("tenant").value.trim() || "demo-tenant",
  "x-user-id": $("user").value.trim() || "demo-user",
});

async function api(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...identity(), ...(options.headers || {}) },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || `${resp.status}`);
  return body;
}

// ===== 视图路由 =====
function showSubmit() {
  location.hash = "";
  $("submit-view").hidden = false;
  $("task-view").hidden = true;
  stopPolling();
}

function showTask(taskId) {
  location.hash = `#/task/${taskId}`;
  $("submit-view").hidden = true;
  $("task-view").hidden = false;
  state.taskId = taskId;
  startPolling();
}

window.addEventListener("hashchange", () => route());
function route() {
  const match = /^#\/task\/(.+)$/.exec(location.hash);
  if (match) showTask(match[1]);
  else showSubmit();
}

// ===== 提交页 =====
const ROLES = ["主合同", "附件", "范本", "制度", "纪要", "补充材料"];

function addDocRow() {
  const row = document.createElement("div");
  row.className = "doc-row";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".pdf,.docx";
  const role = document.createElement("select");
  role.className = "role-select";
  for (const r of ROLES) {
    const option = document.createElement("option");
    option.value = r;
    option.textContent = r;
    role.appendChild(option);
  }
  role.value = "主合同";
  const status = document.createElement("span");
  status.className = "status";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "✕";
  remove.onclick = () => row.remove();
  row.append(file, role, status, remove);
  $("doc-rows").appendChild(row);
  return { row, file, role, status };
}

async function uploadFile(file, role, status) {
  const form = new FormData();
  form.append("file", file);
  status.textContent = "上传中…";
  const resp = await fetch(`${PIPELINE_BASE}/api/v1/docs`, {
    method: "POST",
    body: form,
    headers: identity(),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.detail || `上传失败 ${resp.status}`);
  status.textContent = `v${body.version} 处理中`;
  return body; // {doc_id, version, job_id}
}

$("add-doc").onclick = () => addDocRow();

$("submit-form").onsubmit = async (event) => {
  event.preventDefault();
  const status = $("submit-status");
  status.textContent = "";
  try {
    $("submit-task").disabled = true;
    const docs = [];
    for (const row of document.querySelectorAll("#doc-rows .doc-row")) {
      const file = row.querySelector('input[type="file"]');
      const role = row.querySelector("select").value;
      if (!file.files?.length) continue;
      const receipt = await uploadFile(file.files[0], role, row.querySelector(".status"));
      docs.push({ doc_id: receipt.doc_id, version: receipt.version, role, label: file.files[0].name });
    }
    const skills = await api("/api/skills");
    const skillSelect = $("skill");
    const chosen = skills.skills.find((s) => s.ref === skillSelect.value);
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        scenario: $("scenario").value.trim(),
        skill: chosen?.name || skillSelect.value || "",
        docs,
      }),
    });
    showTask(created.task_id);
  } catch (error) {
    status.textContent = `提交失败：${error.message}`;
  } finally {
    $("submit-task").disabled = false;
  }
};

// ===== 任务详情 =====
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refreshTask, 2000);
  void refreshTask();
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

const STATUS_TEXT = {
  queued: "排队中",
  waiting_index: "等待材料处理",
  running: "审核进行中",
  waiting_for_input: "等待您补充",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

async function refreshTask() {
  if (!state.taskId) return;
  try {
    const detail = await api(`/api/tasks/${state.taskId}`);
    renderTask(detail);
    if (["completed", "failed", "cancelled"].includes(detail.status)) {
      stopPolling();
      await renderResult(detail.status);
    }
  } catch (error) {
    console.error(error);
  }
}

function renderTask(detail) {
  $("task-id").textContent = detail.task_id;
  const badge = $("task-status");
  badge.textContent = STATUS_TEXT[detail.status] || detail.status;
  badge.className = `badge ${detail.status}`;

  const tbody = $("materials-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const material of detail.materials || []) {
    const tr = document.createElement("tr");
    const statusText =
      material.pipeline_status === "ready"
        ? "✓ 已就绪"
        : material.pipeline_status === "failed"
          ? "✕ 处理失败"
          : material.pipeline_status === "needs_ocr"
            ? "✕ 扫描件，暂不可读"
            : `… ${material.pipeline_status}`;
    tr.innerHTML = `<td>${escapeHtml(material.label)}</td><td>v${material.version}</td><td>${escapeHtml(material.role)}</td><td>${escapeHtml(statusText)}</td>`;
    tbody.appendChild(tr);
  }

  if (detail.progress) {
    const p = detail.progress;
    $("progress-body").innerHTML = `
      <div>检查项：已核 <b>${p.checked}</b> / 待核 <b>${p.pending}</b> / 不适用 <b>${p.notApplicable}</b>（预期 ${p.expected} 项）</div>
      <div class="small muted">发现问题 ${p.findings} 项 · 执行步数 ${p.step ?? "-"} · 输入修订 r${detail.input_revision}</div>`;
  }

  $("cancel-task").hidden = ["completed", "failed", "cancelled"].includes(detail.status);

  // 待补卡
  if (detail.status === "waiting_for_input" && detail.pending_input) {
    renderPendingCard(detail.pending_input, detail);
  } else {
    $("pending-card").hidden = true;
    state.currentPending = null;
  }
}

function renderPendingCard(pending, detail) {
  const card = $("pending-card");
  if (state.currentPending?.request_id !== pending.request_id) {
    state.currentPending = pending;
    state.pendingUploads = [];
    $("pending-question").textContent = pending.question;
    $("pending-impact").textContent = pending.impact;
    $("pending-text").value = "";
    $("pending-file").value = "";
    $("pending-status").textContent = "";
    const acceptsFile = pending.accepted_inputs.includes("file");
    $("pending-file").disabled = !acceptsFile;
    if (!acceptsFile) $("pending-file").title = "该问题仅接受文字回答";
  }
  card.hidden = false;
}

$("pending-file").onchange = async (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  const status = $("pending-status");
  try {
    state.pendingUploads = [];
    for (const file of files) {
      status.textContent = `上传 ${file.name}…`;
      const receipt = await uploadFile(file, "补充材料", { textContent: "" });
      state.pendingUploads.push({ doc_id: receipt.doc_id, version: receipt.version, role: "补充材料", label: file.name });
    }
    status.textContent = `已上传 ${state.pendingUploads.length} 个文件（提交补充时一并生效）`;
  } catch (error) {
    status.textContent = `上传失败：${error.message}`;
  }
};

async function submitPending(action) {
  const pending = state.currentPending;
  if (!pending) return;
  const status = $("pending-status");
  const button = action === "supplement" ? $("pending-submit") : $("pending-finish");
  try {
    button.disabled = true;
    status.textContent = "提交中…";
    const body = { request_id: pending.request_id, action };
    if (action === "supplement") {
      const text = $("pending-text").value.trim();
      if (text) body.text = text;
      if (state.pendingUploads.length > 0) body.add_docs = state.pendingUploads;
      if (!text && state.pendingUploads.length === 0) {
        throw new Error("请填写文字或上传文件");
      }
    }
    await api(`/api/tasks/${state.taskId}/input`, { method: "POST", body: JSON.stringify(body) });
    status.textContent = "已接纳";
    $("pending-card").hidden = true;
    state.currentPending = null;
    startPolling();
  } catch (error) {
    status.textContent = `失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$("pending-submit").onclick = () => void submitPending("supplement");
$("pending-finish").onclick = () => void submitPending("finish_with_available");

$("cancel-task").onclick = async () => {
  if (!confirm("确定取消该任务？")) return;
  try {
    await api(`/api/tasks/${state.taskId}/cancel`, { method: "POST", body: "{}" });
    void refreshTask();
  } catch (error) {
    alert(`取消失败：${error.message}`);
  }
};

async function renderResult(status) {
  try {
    const result = await api(`/api/tasks/${state.taskId}/result`);
    if (result.conclusion_md) {
      $("result-card").hidden = false;
      const outcomeBadge = $("result-outcome");
      outcomeBadge.textContent =
        result.review_outcome === "complete"
          ? "全部核查完成"
          : result.review_outcome === "partial"
            ? "部分审核"
            : "材料不足";
      outcomeBadge.className = `badge ${result.review_outcome}`;
      $("result-md").innerHTML = marked.parse(result.conclusion_md, { breaks: true });
      const used = (result.used_materials || []).map((m) => `${m.label}（v${m.version}）`).join("、");
      $("result-materials").textContent = used ? `本次实际使用材料：${used}` : "本次未使用文件材料。";
      const issues = result.material_issues || [];
      if (issues.length > 0) {
        $("result-materials").textContent += `　|　材料问题：${issues.map((i) => i.label).join("、")}`;
      }
    } else {
      $("terminal-card").hidden = false;
      $("terminal-body").innerHTML = `
        <p>状态：${STATUS_TEXT[result.status] || result.status}</p>
        <p class="muted">${escapeHtml(result.reason || "")}</p>`;
    }
  } catch (error) {
    $("terminal-card").hidden = false;
    $("terminal-body").textContent = `结果获取失败：${error.message}`;
  }
  void status;
}

$("back").onclick = (event) => {
  event.preventDefault();
  showSubmit();
};

// ===== 初始化 =====
async function init() {
  addDocRow();
  try {
    const skills = await api("/api/skills");
    const select = $("skill");
    select.innerHTML = "";
    for (const skill of skills.skills) {
      const option = document.createElement("option");
      option.value = skill.ref;
      option.textContent = `${skill.name}（v${skill.version}）`;
      select.appendChild(option);
    }
  } catch (error) {
    $("submit-status").textContent = `skill 列表加载失败：${error.message}`;
  }
  route();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

init();
