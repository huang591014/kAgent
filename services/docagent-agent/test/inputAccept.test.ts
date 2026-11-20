/** v0.6 单次提交切换测试：
- 旧 waiting_for_input 任务迁移：关卡、转 queued、input_closed、幂等
- 新任务 input_closed=1（追加入口关闭）
- cancel 条件更新：终态不可取消
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { taskService } from "../src/taskService.js";

const identity = { tenant_id: "t1", user_id: "u1" };

let baseDir: string;
let db: Db;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "v06-test-"));
  db = new Db(path.join(baseDir, "agent.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function seedWaitingForInputTask(): string {
  const taskId = "task_seed01";
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
       VALUES (?, 't1', 'u1', '', 'demo@v1', '{}', 'waiting_for_input', 2, NULL, 0, '{}', NULL, ?, ?)`,
    )
    .run(taskId, now, now);
  db.db
    .prepare(
      `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
       VALUES (?, 2, 1, 'd_01', 1, '主合同', '主合同.docx', 'supplement', 'req_1')`,
    )
    .run(taskId);
  db.db
    .prepare(
      `INSERT INTO input_requests (request_id, task_id, tool_call_id, seq, question, impact, accepted_inputs, status, answer, answer_identity, created_at, answered_at)
       VALUES ('req_1', ?, 'call_1', 1, '按人天还是按结果？', '影响专项卡', '["text"]', 'open', NULL, NULL, ?, NULL)`,
    )
    .run(taskId, now);
  return taskId;
}

describe("v0.6 迁移：待补任务切换单次提交", () => {
  it("waiting_for_input → 关卡 + 转 queued + 关闭追加入口 + 记迁移事件", () => {
    const taskId = seedWaitingForInputTask();
    // 手动触发迁移（新库构造时已跑过一次但当时无待补任务）
    (db as unknown as { migrateToSingleSubmission(): void }).migrateToSingleSubmission();
    const task = db.getTask(taskId)!;
    expect(task.status).toBe("queued");
    expect(task.input_closed).toBe(1);
    expect(task.input_revision).toBe(2); // 按最后已接纳输入继续
    expect(db.openRequest(taskId)).toBeUndefined(); // 卡已关闭
    const events = db.db
      .prepare("SELECT type FROM events WHERE task_id = ? AND type = 'migrated_to_single_submission'")
      .all(taskId);
    expect(events).toHaveLength(1);
  });

  it("迁移幂等：已迁移任务再跑不产生第二个事件", () => {
    const taskId = seedWaitingForInputTask();
    const dbInternal = db as unknown as { migrateToSingleSubmission(): void };
    dbInternal.migrateToSingleSubmission();
    dbInternal.migrateToSingleSubmission();
    const events = db.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'migrated_to_single_submission'")
      .get(taskId) as { n: number };
    expect(events.n).toBe(1);
    expect(db.getTask(taskId)!.status).toBe("queued");
  });

  it("终态与运行中任务不受迁移影响", () => {
    const now = Date.now();
    for (const [id, status] of [["t_done", "completed"], ["t_run", "running"]] as const) {
      db.db
        .prepare(
          `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
           VALUES (?, 't1', 'u1', '', 'demo@v1', '{}', ?, 1, NULL, 0, '{}', NULL, ?, ?)`,
        )
        .run(id, status, now, now);
    }
    (db as unknown as { migrateToSingleSubmission(): void }).migrateToSingleSubmission();
    expect(db.getTask("t_done")!.status).toBe("completed");
    expect(db.getTask("t_run")!.status).toBe("running");
  });
});

describe("v0.6 cancel 条件更新", () => {
  it("终态任务不可取消，迟到回调不改写终态", () => {
    const now = Date.now();
    db.db
      .prepare(
        `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
         VALUES ('t_x', 't1', 'u1', '', 'demo@v1', '{}', 'completed', 1, NULL, 1, '{}', NULL, ?, ?)`,
      )
      .run(now, now);
    const result = taskService.cancelTask({ db, activeRuns: new Map() }, identity, "t_x");
    expect(result.status).toBe("completed");
    expect(db.getTask("t_x")!.status).toBe("completed");
  });

  it("非终态任务可取消", () => {
    const now = Date.now();
    db.db
      .prepare(
        `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
         VALUES ('t_y', 't1', 'u1', '', 'demo@v1', '{}', 'queued', 1, NULL, 1, '{}', NULL, ?, ?)`,
      )
      .run(now, now);
    const result = taskService.cancelTask({ db, activeRuns: new Map() }, identity, "t_y");
    expect(result.status).toBe("cancelled");
  });
});
