/** 任务服务：创建、补件接纳（幂等协议）、取消、详情（设计 §4.6）。

接纳协议（参考 command-inbox 的请求身份去重）：
- 同一 request 与相同规范化内容的重发返回首次接纳回执；
- 不同内容竞争同一个请求 / 回答已失效的问题 / 终态任务提交 → 409；
- 服务端在一个事务里保存答复、关请求、递增输入修订并登记待调度。
*/

import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { newTaskId } from "./ids.js";
import { invalidateForReplace } from "./papers.js";
import { pipeline } from "./pipelineClient.js";
import type { InputAnswerReceipt } from "./types.js";
import type { SkillRegistry } from "./skills/registry.js";

export interface CreateTaskInput {
  scenario: string;
  skill: string;
  docs: Array<{ doc_id: string; version?: number; role?: string; label?: string }>;
  idempotency_key?: string;
}

export interface SupplementPayload {
  request_id: string;
  action: "supplement" | "finish_with_available";
  text?: string;
  add_docs?: Array<{ doc_id: string; version: number; role?: string; label?: string }>;
  replace_docs?: Array<{
    old: { doc_id: string; version: number };
    new: { doc_id: string; version: number };
    role?: string;
    label?: string;
  }>;
}

export class AcceptConflictError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public currentState: unknown,
  ) {
    super(message);
  }
}

/** 规整为语义标准形：缺省字段补默认、文字去首尾空白，再做键序无关的序列化。 */
function canonicalize(payload: SupplementPayload): string {
  const normalized = {
    request_id: payload.request_id,
    action: payload.action,
    text: payload.text?.trim() || null,
    add_docs: payload.add_docs ?? [],
    replace_docs: payload.replace_docs ?? [],
  };
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sorted(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sorted(normalized));
}

export const taskService = {
  async createTask(
    deps: { db: Db; skills: SkillRegistry },
    identity: { tenant_id: string; user_id: string },
    input: CreateTaskInput,
  ): Promise<{ task_id: string; status: string; inputs: Array<{ doc_id: string; version: number; role: string; label: string }> }> {
    const { db, skills } = deps;

    if (input.idempotency_key) {
      const existing = db.db
        .prepare("SELECT task_id FROM idempotency WHERE key = ?")
        .get(`${identity.tenant_id}:${input.idempotency_key}`) as { task_id: string } | undefined;
      if (existing) {
        const task = db.getTask(existing.task_id);
        if (task) {
          return {
            task_id: task.task_id,
            status: task.status,
            inputs: db.materialsAt(task.task_id, 1).map(materialSummary),
          };
        }
      }
    }

    // skill 解析：缺省取清单第一个；固定为已安装的具体版本
    const skillRow = input.skill ? skills.get(input.skill) : skills.defaultSkill();
    if (!skillRow) {
      throw new AcceptConflictError(400, `skill 未安装：${input.skill || "（未指定且无已安装 skill）"}`, null);
    }
    const skillRef = skillRow.ref;

    // 材料版本解析：省略版本时取已发布版本；校验属主
    const resolvedInputs: Array<{ doc_id: string; version: number; role: string; label: string }> = [];
    for (const doc of input.docs ?? []) {
      const status = doc.version
        ? await pipeline.docStatus(identity, doc.doc_id, doc.version)
        : await pipeline.docStatus(identity, doc.doc_id);
      const version = doc.version ?? status.current_version;
      if (!version) throw new AcceptConflictError(400, `材料 ${doc.doc_id} 尚无已发布版本`, null);
      resolvedInputs.push({
        doc_id: doc.doc_id,
        version,
        role: doc.role || "未分类",
        label: doc.label || status.filename || doc.doc_id,
      });
    }

    const taskId = newTaskId();
    const now = Date.now();
    db.transaction(() => {
      db.db
        .prepare(
          `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, NULL, 0, '{}', NULL, ?, ?)`,
        )
        .run(
          taskId,
          identity.tenant_id,
          identity.user_id,
          input.scenario ?? "",
          skillRef,
          JSON.stringify({ model: config.modelName, temperature: config.modelTemperature }),
          now,
          now,
        );
      resolvedInputs.forEach((doc, index) => {
        db.db
          .prepare(
            `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
             VALUES (?, 1, ?, ?, ?, ?, ?, 'initial', NULL)`,
          )
          .run(taskId, index + 1, doc.doc_id, doc.version, doc.role, doc.label);
      });
      if (input.idempotency_key) {
        db.db
          .prepare("INSERT OR IGNORE INTO idempotency (key, task_id, created_at) VALUES (?, ?, ?)")
          .run(`${identity.tenant_id}:${input.idempotency_key}`, taskId, now);
      }
      db.appendEvent(taskId, "task_accepted", { skill_ref: skillRef, docs: resolvedInputs.length });
    });

    return { task_id: taskId, status: "queued", inputs: resolvedInputs };
  },

  /** 补件接纳：原子保存答复、标记请求已处理、递增输入修订并登记待调度。 */
  acceptInput(
    deps: { db: Db },
    identity: { tenant_id: string; user_id: string },
    taskId: string,
    payload: SupplementPayload,
  ): { task_id: string; status: string; input_revision: number; receipt: InputAnswerReceipt } {
    const { db } = deps;

    const result = db.transaction((): {
      task_id: string;
      status: string;
      input_revision: number;
      receipt: InputAnswerReceipt;
    } => {
      const task = db.getTask(taskId);
      if (!task || task.tenant_id !== identity.tenant_id) {
        throw new AcceptConflictError(404, "任务不存在", null);
      }
      if (task.submitted_by !== identity.user_id) {
        throw new AcceptConflictError(403, "仅任务提交者可回应待补请求", { status: task.status });
      }
      const request = db.getRequest(payload.request_id);
      if (!request || request.task_id !== taskId) {
        throw new AcceptConflictError(404, "待补请求不存在", null);
      }

      // 幂等优先于状态检查：同请求同规范化内容 → 无论当前状态都返回首次回执
      const identityHash = createHash("sha256").update(canonicalize(payload)).digest("hex");
      if (request.answer_identity === identityHash && request.answer) {
        const receipt = JSON.parse(request.answer) as InputAnswerReceipt;
        return { task_id: taskId, status: task.status, input_revision: task.input_revision, receipt };
      }
      if (request.answer_identity !== null) {
        throw new AcceptConflictError(409, "该请求已被不同内容的回答接纳", { status: task.status, request_id: request.request_id });
      }

      if (task.status !== "waiting_for_input") {
        throw new AcceptConflictError(409, `任务当前状态为 ${task.status}，不能回应该请求`, { status: task.status });
      }

      const text = (payload.text ?? null) === null || payload.text?.trim() === "" ? null : payload.text!.trim();
      const addDocs = payload.add_docs ?? [];
      const replaceDocs = payload.replace_docs ?? [];

      if (payload.action === "supplement" && !text && addDocs.length === 0 && replaceDocs.length === 0) {
        throw new AcceptConflictError(400, "supplement 至少包含文字或文件", { status: task.status });
      }

      // replace_docs 的 old 必须属于当前输入修订
      const currentMaterials = db.materialsAt(taskId, task.input_revision);
      for (const rep of replaceDocs) {
        const exists = currentMaterials.some(
          (m) => m.doc_id === rep.old.doc_id && m.version === rep.old.version,
        );
        if (!exists) {
          throw new AcceptConflictError(400, `替换目标不在当前输入修订：${rep.old.doc_id}@v${rep.old.version}`, { status: task.status });
        }
      }

      const nextRevision = task.input_revision + 1;
      db.forkInputs(taskId, task.input_revision, nextRevision);
      // 普通补件沿用有效审查范围（B1）；路由确需变化时由模型带 scope_change_reason 重登记
      db.carryScopeToRevision(taskId, task.input_revision, nextRevision);

      // 修改下一修订的材料集合
      let seq = currentMaterials.length;
      const replacedOldKeys = new Set(replaceDocs.map((r) => `${r.old.doc_id}@${r.old.version}`));
      if (replacedOldKeys.size > 0) {
        const keepRows = db.materialsAt(taskId, nextRevision).filter(
          (m) => !replacedOldKeys.has(`${m.doc_id}@${m.version}`),
        );
        db.db.prepare("DELETE FROM task_inputs WHERE task_id = ? AND revision = ?").run(taskId, nextRevision);
        keepRows.forEach((row, index) => {
          db.db
            .prepare(
              `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(taskId, nextRevision, index + 1, row.doc_id, row.version, row.role, row.label, row.origin_kind, row.origin_request);
        });
        seq = keepRows.length;
      }
      for (const doc of addDocs) {
        seq += 1;
        db.db
          .prepare(
            `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'supplement', ?)`,
          )
          .run(taskId, nextRevision, seq, doc.doc_id, doc.version, doc.role || "补充材料", doc.label || doc.doc_id, payload.request_id);
      }
      for (const rep of replaceDocs) {
        seq += 1;
        db.db
          .prepare(
            `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'supplement', ?)`,
          )
          .run(taskId, nextRevision, seq, rep.new.doc_id, rep.new.version, rep.role || "替换材料", rep.label || rep.new.doc_id, payload.request_id);
      }

      if (text) {
        db.db
          .prepare("INSERT INTO supplement_texts (task_id, revision, request_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(taskId, nextRevision, payload.request_id, text, Date.now());
      }

      // 替换材料 → 底稿依赖失效（引用旧版本的意见标为待复核）
      if (replaceDocs.length > 0) {
        const papersFile = db.getFile(taskId, "working-papers.json");
        if (papersFile) {
          try {
            const papers = JSON.parse(papersFile.content);
            let mutated = papers;
            for (const rep of replaceDocs) {
              mutated = invalidateForReplace(
                mutated,
                rep.old,
                `原版本已被替换（v${rep.old.version} → v${rep.new.version}），待按新材料复核`,
              );
            }
            db.putFile(taskId, "working-papers.json", JSON.stringify(mutated, null, 2));
          } catch {
            /* 底稿损坏时保留原样，运行时按待核处理 */
          }
        }
      }

      const receipt: InputAnswerReceipt = {
        action: payload.action,
        text,
        add_docs: addDocs,
        replace_docs: replaceDocs,
        accepted_revision: nextRevision,
        accepted_at: Date.now(),
      };
      db.settleRequest(payload.request_id, "answered", receipt, identityHash);

      const inputClosed = payload.action === "finish_with_available" ? 1 : task.input_closed;
      db.updateTask(taskId, {
        status: "queued",
        input_revision: nextRevision,
        input_closed: inputClosed,
        current_batch: null,
        status_reason: null,
      });
      db.appendEvent(taskId, "input_received", {
        request_id: payload.request_id,
        action: payload.action,
        revision: nextRevision,
      });

      return { task_id: taskId, status: "queued", input_revision: nextRevision, receipt };
    });

    return result;
  },

  cancelTask(deps: { db: Db; activeRuns: Map<string, AbortController> }, identity: { tenant_id: string; user_id: string }, taskId: string): { task_id: string; status: string } {
    const { db, activeRuns } = deps;
    const task = db.getTask(taskId);
    if (!task || task.tenant_id !== identity.tenant_id) throw new AcceptConflictError(404, "任务不存在", null);
    if (task.submitted_by !== identity.user_id) throw new AcceptConflictError(403, "仅任务提交者可取消", null);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      return { task_id: taskId, status: task.status };
    }
    const controller = activeRuns.get(taskId);
    if (controller) {
      controller.abort(); // runner 捕获后落终态
      return { task_id: taskId, status: "cancelling" };
    }
    db.transaction(() => {
      db.updateTask(taskId, { status: "cancelled", status_reason: "用户取消" });
      const open = db.openRequest(taskId);
      if (open) db.settleRequest(open.request_id, "closed", null, null);
    });
    db.appendEvent(taskId, "task_cancelled", {});
    return { task_id: taskId, status: "cancelled" };
  },
};

function materialSummary(m: { doc_id: string; version: number; role: string; label: string }) {
  return { doc_id: m.doc_id, version: m.version, role: m.role, label: m.label };
}
