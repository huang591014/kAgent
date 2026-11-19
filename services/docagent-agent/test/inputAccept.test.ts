/** 补件接纳协议测试（设计 §4.6）：
- 同请求同内容重发 → 首次回执
- 不同内容竞争同一请求 / 已回答 → 409
- 终态任务回答 → 409
- replace 后引用旧版本的意见标为待复核
- finish_with_available 关闭提问入口并递增修订
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { taskService, AcceptConflictError } from "../src/taskService.js";

const identity = { tenant_id: "t1", user_id: "u1" };
const other = { tenant_id: "t1", user_id: "u2" };

let dbFile: string;
let db: Db;

beforeEach(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "accept-test-")), "agent.db");
  db = new Db(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

function seedTask(status = "waiting_for_input", opts: { inputClosed?: number } = {}): string {
  const taskId = "task_seed01";
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
       VALUES (?, 't1', 'u1', '', 'demo@v1', '{}', ?, 1, NULL, ?, '{}', NULL, ?, ?)`,
    )
    .run(taskId, status, opts.inputClosed ?? 0, now, now);
  db.db
    .prepare(
      `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
       VALUES (?, 1, 1, 'd_01', 1, '主合同', '主合同.docx', 'initial', NULL)`,
    )
    .run(taskId);
  db.db
    .prepare(
      `INSERT INTO input_requests (request_id, task_id, tool_call_id, seq, question, impact, accepted_inputs, status, answer, answer_identity, created_at, answered_at)
       VALUES ('req_1', ?, 'call_1', 1, '按人天还是按结果验收？', '影响专项卡选择', '["text","file"]', 'open', NULL, NULL, ?, NULL)`,
    )
    .run(taskId, now);
  return taskId;
}

describe("acceptInput", () => {
  it("同请求同内容重发返回首次回执", () => {
    const taskId = seedTask();
    const payload = {
      request_id: "req_1",
      action: "supplement" as const,
      text: "按季度运维结果验收",
      add_docs: [],
      replace_docs: [],
    };
    const first = taskService.acceptInput({ db }, identity, taskId, payload);
    expect(first.input_revision).toBe(2);
    // 字段顺序不同但内容相同的重发
    const retry = taskService.acceptInput(
      { db },
      identity,
      taskId,
      { action: "supplement", text: "按季度运维结果验收", request_id: "req_1" },
    );
    expect(retry.receipt.accepted_revision).toBe(first.receipt.accepted_revision);
    expect(retry.input_revision).toBe(2);
  });

  it("不同内容竞争同一请求 → 409", () => {
    const taskId = seedTask();
    taskService.acceptInput({ db }, identity, taskId, {
      request_id: "req_1",
      action: "supplement",
      text: "回答A",
    });
    expect(() =>
      taskService.acceptInput({ db }, identity, taskId, {
        request_id: "req_1",
        action: "supplement",
        text: "回答B",
      }),
    ).toThrow(AcceptConflictError);
    try {
      taskService.acceptInput({ db }, identity, taskId, { request_id: "req_1", action: "supplement", text: "回答B" });
    } catch (error) {
      expect((error as AcceptConflictError).statusCode).toBe(409);
    }
  });

  it("supplement 空内容 → 400", () => {
    const taskId = seedTask();
    try {
      taskService.acceptInput({ db }, identity, taskId, { request_id: "req_1", action: "supplement" });
      expect.unreachable("应抛 400");
    } catch (error) {
      expect((error as AcceptConflictError).statusCode).toBe(400);
    }
  });

  it("非待补状态回答 → 409", () => {
    const taskId = seedTask("running");
    try {
      taskService.acceptInput({ db }, identity, taskId, { request_id: "req_1", action: "finish_with_available" });
      expect.unreachable("应抛 409");
    } catch (error) {
      expect((error as AcceptConflictError).statusCode).toBe(409);
    }
  });

  it("他人回答 → 403", () => {
    const taskId = seedTask();
    try {
      taskService.acceptInput({ db }, other, taskId, { request_id: "req_1", action: "finish_with_available" });
      expect.unreachable("应抛 403");
    } catch (error) {
      expect((error as AcceptConflictError).statusCode).toBe(403);
    }
  });

  it("replace 后底稿引用旧版本的意见标为待复核", () => {
    const taskId = seedTask();
    db.putFile(
      taskId,
      "working-papers.json",
      JSON.stringify({
        scope: { rule_cards: ["C6"], expected_item_ids: ["c6"] },
        conclusion_hint: null,
        items: [
          {
            item_id: "c6",
            rule_card: "C6 付款",
            status: "checked",
            finding: { problem: "问题P", suggestion: "建议S" },
            used_materials: [{ doc_id: "d_01", version: 1 }],
            pending_reason: null,
            missing_role: null,
            not_applicable_reason: null,
          },
        ],
      }),
    );
    const result = taskService.acceptInput({ db }, identity, taskId, {
      request_id: "req_1",
      action: "supplement",
      replace_docs: [{ old: { doc_id: "d_01", version: 1 }, new: { doc_id: "d_01", version: 2 }, role: "主合同" }],
    });
    expect(result.input_revision).toBe(2);
    const materials = db.materialsAt(taskId, 2);
    expect(materials).toHaveLength(1);
    expect(materials[0]!.version).toBe(2);
    const papers = JSON.parse(db.getFile(taskId, "working-papers.json")!.content);
    expect(papers.items[0].status).toBe("pending");
    expect(papers.items[0].pending_reason).toContain("替换");
  });

  it("replace 目标不在当前修订 → 400", () => {
    const taskId = seedTask();
    try {
      taskService.acceptInput({ db }, identity, taskId, {
        request_id: "req_1",
        action: "supplement",
        replace_docs: [{ old: { doc_id: "d_99", version: 9 }, new: { doc_id: "d_01", version: 2 }, role: "主合同" }],
      });
      expect.unreachable("应抛 400");
    } catch (error) {
      expect((error as AcceptConflictError).statusCode).toBe(400);
    }
  });

  it("finish_with_available 关闭提问入口", () => {
    const taskId = seedTask();
    const result = taskService.acceptInput({ db }, identity, taskId, {
      request_id: "req_1",
      action: "finish_with_available",
    });
    expect(result.input_revision).toBe(2);
    expect(db.getTask(taskId)!.input_closed).toBe(1);
    expect(db.getTask(taskId)!.status).toBe("queued");
  });

  it("接纳后补充文字进入 supplement_texts，任务回到 queued", () => {
    const taskId = seedTask();
    taskService.acceptInput({ db }, identity, taskId, {
      request_id: "req_1",
      action: "supplement",
      text: "本次按运维结果验收",
    });
    const task = db.getTask(taskId)!;
    expect(task.status).toBe("queued");
    expect(task.input_revision).toBe(2);
    const row = db.db
      .prepare("SELECT * FROM supplement_texts WHERE task_id = ? AND revision = 2")
      .get(taskId) as { text: string };
    expect(row.text).toBe("本次按运维结果验收");
  });
});
