/* DocAgent 前端：任务提交 + 任务详情（轮询、待补卡、结果渲染）。 */

const $ = (id) => document.getElementById(id);
const PIPELINE_BASE = localStorage.getItem("pipelineBase") || "http://localhost:8000";

const state = {
  taskId: null,
  pollTimer: null,
};

/** 白名单净化（A3）：marked 输出的 HTML 只保留安全的标签与属性；
 * 净化器或 marked 不可用时降级为 textContent 展示原始 Markdown。 */
const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote",
  "ul", "ol", "li", "strong", "em", "del", "code", "pre",
  "a", "table", "thead", "tbody", "tr", "th", "td", "span", "div",
]);
const ALLOWED_ATTRS = new Set(["href", "title"]);

const DANGEROUS_TAGS = ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON"];

function sanitizeHtmlNode(node) {
  for (const child of [...node.children]) {
    const tag = String(child.tagName ?? "").toUpperCase();
    if (DANGEROUS_TAGS.includes(tag)) {
      child.remove(); // 可执行/可交互元素整删
      continue;
    }
    if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      const parent = child.parentNode;
      child.replaceWith(...child.childNodes); // 未知标签去壳，内容保留继续净化
      if (parent) sanitizeHtmlNode(parent);
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value ?? "").trim().toLowerCase();
      if (
        !ALLOWED_ATTRS.has(name) ||
        (name === "href" && (value.startsWith("javascript:") || value.startsWith("data:") || value.startsWith("vbscript:")))
      ) {
        child.removeAttribute(attr.name);
      }
    }
    sanitizeHtmlNode(child);
  }
}

function renderMarkdown(container, markdownText) {
  const parser = globalThis.marked;
  try {
    if (!parser || typeof parser.parse !== "function") throw new Error("renderer unavailable");
    const raw = parser.parse(markdownText, { breaks: true });
    const template = document.createElement("template");
    template.innerHTML = raw;
    sanitizeHtmlNode(template.content);
    container.replaceChildren(template.content);
    return;
  } catch {
    // 渲染器缺失或渲染异常：降级为纯文本，保证结论仍可读
    const pre = document.createElement("pre");
    pre.className = "markdown-fallback";
    pre.textContent = markdownText;
    container.replaceChildren(pre);
  }
}

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
  resetTaskView();
  startPolling();
}

/** P2：切换任务时清空上一份结果/终态/进度，旧轮询响应按任务号丢弃 */
function resetTaskView() {
  $("result-card").hidden = true;
  $("terminal-card").hidden = true;
  $("result-md").replaceChildren();
  $("result-materials").textContent = "";
  $("terminal-body").replaceChildren();
  $("progress-body").textContent = "等待执行…";
  $("materials-table").querySelector("tbody").replaceChildren();
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
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        scenario: $("scenario").value.trim(),
        skill: $("skill").value || "", // P1-8：原样提交所选 ref（name@version）
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
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

async function refreshTask() {
  if (!state.taskId) return;
  const requestedTask = state.taskId;
  try {
    const detail = await api(`/api/tasks/${requestedTask}`);
    if (state.taskId !== requestedTask) return; // 过期响应（已切换任务）
    renderTask(detail);
    if (["completed", "failed", "cancelled"].includes(detail.status)) {
      stopPolling();
      if (state.taskId === requestedTask) await renderResult(detail.status);
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

}






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
      renderMarkdown($("result-md"), result.conclusion_md);
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
