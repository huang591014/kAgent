/** 任务服务：创建（幂等）、取消、详情（v0.6 §5：单次提交，无补件接口）。

幂等创建：同一提交人并发重发同一键和内容时只创建一个任务；
同键不同内容报告冲突（409）。新任务从首个输入版本起关闭追加入口。
*/

import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { newTaskId } from "./ids.js";
import { pipeline } from "./pipelineClient.js";
import type { SkillRegistry } from "./skills/registry.js";

export interface CreateTaskInput {
  scenario: string;
  skill: string;
  docs: Array<{ doc_id: string; version?: number; role?: string; label?: string }>;
  idempotency_key?: string;
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

function canonicalCreateInput(input: CreateTaskInput): string {
  const normalized = {
    scenario: input.scenario ?? "",
    skill: input.skill ?? "",
    docs: (input.docs ?? []).map((d) => ({
      doc_id: d.doc_id,
      version: d.version ?? null,
      role: d.role ?? "",
      label: d.label ?? "",
    })),
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
    const key = input.idempotency_key ? `${identity.tenant_id}:${identity.user_id}:${input.idempotency_key}` : null;
    const payloadHash = key ? createHash("sha256").update(canonicalCreateInput(input)).digest("hex") : null;

    if (key) {
      const existing = db.db
        .prepare("SELECT task_id, payload_hash FROM idempotency WHERE key = ?")
        .get(key) as { task_id: string; payload_hash: string | null } | undefined;
      if (existing) {
        if (existing.payload_hash && existing.payload_hash !== payloadHash) {
          throw new AcceptConflictError(409, "同一幂等键已被不同内容的提交使用", { key_used: true });
        }
        const task = db.getTask(existing.task_id);
        if (task) {
          return {
            task_id: task.task_id,
            status: task.status,
            inputs: db.materialsAt(task.task_id, task.input_revision).map(materialSummary),
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
    const outcome = db.transaction((): { task_id: string; created: boolean } => {
      // 并发重发：事务内再查一次；同键同内容返回首个任务，异内容报冲突
      if (key) {
        const raced = db.db
          .prepare("SELECT task_id, payload_hash FROM idempotency WHERE key = ?")
          .get(key) as { task_id: string; payload_hash: string | null } | undefined;
        if (raced) {
          if (raced.payload_hash && raced.payload_hash !== payloadHash) {
            throw new AcceptConflictError(409, "同一幂等键已被不同内容的提交使用", { key_used: true });
          }
          return { task_id: raced.task_id, created: false };
        }
      }
      db.db
        .prepare(
          `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, NULL, 1, '{}', NULL, ?, ?)`,
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
      if (key) {
        db.db
          .prepare("INSERT INTO idempotency (key, task_id, created_at, payload_hash) VALUES (?, ?, ?, ?)")
          .run(key, taskId, now, payloadHash);
      }
      db.appendEvent(taskId, "task_accepted", { skill_ref: skillRef, docs: resolvedInputs.length });
      return { task_id: taskId, created: true };
    });

    if (!outcome.created) {
      const task = db.getTask(outcome.task_id);
      return {
        task_id: outcome.task_id,
        status: task?.status ?? "queued",
        inputs: task ? db.materialsAt(task.task_id, task.input_revision).map(materialSummary) : [],
      };
    }
    return { task_id: taskId, status: "queued", inputs: resolvedInputs };
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
    // 条件更新：仅非终态可取消，迟到回调不能改写终态
    const info = db.db
      .prepare("UPDATE tasks SET status = 'cancelled', status_reason = '用户取消', updated_at = ? WHERE task_id = ? AND status NOT IN ('completed','failed','cancelled')")
      .run(Date.now(), taskId);
    if (Number(info.changes) === 0) {
      return { task_id: taskId, status: db.getTask(taskId)?.status ?? "unknown" };
    }
    db.appendEvent(taskId, "task_cancelled", {});
    return { task_id: taskId, status: "cancelled" };
  },
};

function materialSummary(m: { doc_id: string; version: number; role: string; label: string }) {
  return { doc_id: m.doc_id, version: m.version, role: m.role, label: m.label };
}
