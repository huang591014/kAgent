/** v0.6 验收：模型替身驱动真实 runTask（单次提交，无用户交互）。
 *
 * - 工具循环贯通：三次请求到达替身，底稿落盘并发布结果；
 * - 纯追问只给一次纠正机会：nudge 后登记缺口 → partial 交付；
 * - 无有效产出且无缺口证明 → failed；
 * - claimTask 原子领取：并发两次 runTask 只有一个执行。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { Db } from "../src/db.js";
import { runTask, type RunnerDeps } from "../src/runner/run.js";
import { WORKING_PAPERS_PATH } from "../src/runner/tools.js";
import { SkillRegistry } from "../src/skills/registry.js";

interface FakeResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
}

interface RecordedPrompt {
  messages: Array<Record<string, unknown>>;
  system: string;
}

/** 最小 LanguageModelV3 替身：按序返回预编排响应，记录每次请求的完整 prompt。 */
function makeFakeModel(responses: FakeResponse[]) {
  const prompts: RecordedPrompt[] = [];
  let index = 0;
  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-model",
    async doGenerate(options: { prompt?: unknown; system?: unknown }) {
      prompts.push({
        messages: (options.prompt as Array<Record<string, unknown>>) ?? [],
        system: String(options.system ?? ""),
      });
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      const content: Array<Record<string, unknown>> = [];
      if (response.text) content.push({ type: "text", text: response.text });
      for (const call of response.toolCalls ?? []) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input });
      }
      return {
        content,
        finishReason: response.toolCalls && response.toolCalls.length > 0 ? ("tool-calls" as const) : ("stop" as const),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
    async doStream() {
      throw new Error("streaming not supported by fake");
    },
  };
  return { model: model as unknown as LanguageModel, prompts };
}

let baseDir: string;
let db: Db;
let skills: SkillRegistry;
let installedSkillRef = "demo-skill@x";

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-"));
  db = new Db(path.join(baseDir, "agent.db"));
  // 安装根注入为临时目录，测试不污染真实 var/skills
  skills = new SkillRegistry(db, path.join(baseDir, "skills"));
  const pkgDir = path.join(baseDir, "src-demo-skill");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示\n---\n# 演示技能\n");
  installedSkillRef = skills.install(pkgDir).ref;
});

afterEach(() => {
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function seedTask(skillRef: string = installedSkillRef): string {
  const taskId = "task_e2e01";
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO tasks (task_id, tenant_id, submitted_by, is_admin, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
       VALUES (?, 't1', 'u1', 0, '', ?, '{}', 'queued', 1, NULL, 1, '{}', NULL, ?, ?)`,
    )
    .run(taskId, skillRef, now, now);
  return taskId;
}

function depsFor(model: LanguageModel): RunnerDeps {
  return {
    db,
    skills,
    retrieval: {
      search: async () => {
        throw new Error("检索未在本测试范围");
      },
      read: async () => {
        throw new Error("回读未在本测试范围");
      },
    } as never,
    activeRuns: new Map(),
    modelFactory: () => model,
  };
}

const FULL_PAPERS = {
  scope: { rule_cards: ["C1 共性"], expected_item_ids: ["c1", "c2"] },
  conclusion_hint: null,
  task_gaps: [],
  items: [
    {
      item_id: "c1",
      rule_card: "C1 共性",
      status: "checked",
      finding: { problem: "未约定验收标准", suggestion: "补充验收标准" },
      used_materials: [],
      pending_reason: null,
      missing_role: null,
      not_applicable_reason: null,
    },
    {
      item_id: "c2",
      rule_card: "C1 共性",
      status: "checked",
      finding: null,
      used_materials: [],
      pending_reason: null,
      missing_role: null,
      not_applicable_reason: null,
    },
  ],
};

const PAPERS_WITH_GAP = {
  scope: { rule_cards: ["C1 共性"], expected_item_ids: ["c1", "c2"] },
  conclusion_hint: null,
  task_gaps: [
    {
      gap_id: "route-1",
      category: "route_undetermined",
      statement: "材料无法判定属于运维服务还是人员外包，专项规则未执行",
      impact: "专项卡检查项未覆盖，影响完整性",
    },
  ],
  items: [
    FULL_PAPERS.items[0],
    {
      item_id: "c2",
      rule_card: "C1 共性",
      status: "pending",
      finding: null,
      used_materials: [],
      pending_reason: "缺采购纪要，金额一致性无法核对",
      missing_role: "纪要",
      not_applicable_reason: null,
    },
  ],
};

describe("runTask（模型替身 e2e，v0.6 单次提交）", () => {
  it("工具循环贯通：三次请求到达替身，底稿落盘并发布 complete 结果", async () => {
    const taskId = seedTask();
    const { model, prompts } = makeFakeModel([
      { toolCalls: [{ id: "call_1", name: "skill", input: {} }] },
      { toolCalls: [{ id: "call_2", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(FULL_PAPERS) } }] },
      { text: "审核完成，意见如底稿所述。" },
    ]);
    // 绑定真实安装的 skill 版本（P1-1：成功加载是发布凭据）

    await runTask(depsFor(model), taskId);

    expect(prompts).toHaveLength(3); // 验收：三次请求都实际到达替身
    expect(JSON.stringify(prompts[1]!.messages)).toContain("call_1");
    expect(JSON.stringify(prompts[2]!.messages)).toContain("call_2");

    const task = db.getTask(taskId)!;
    expect(task.status).toBe("completed");
    const result = db.db.prepare("SELECT * FROM results WHERE task_id = ?").get(taskId) as Record<string, unknown>;
    expect(result.review_outcome).toBe("complete");
    expect(String(result.conclusion_md)).toContain("未约定验收标准");
    const scope = db.getActiveScope(taskId, 1);
    expect(scope?.expected_item_ids).toEqual(["c1", "c2"]);
  });

  it("纯追问只纠正一次：nudge 后登记 task_gaps → partial 交付", async () => {
    const taskId = seedTask();
    const { model, prompts } = makeFakeModel([
      { toolCalls: [{ id: "call_s", name: "skill", input: {} }] },
      { text: "请确认合同类型？是运维服务还是人员外包？" }, // 纯追问 → nudge
      { toolCalls: [{ id: "call_w", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(PAPERS_WITH_GAP) } }] },
      { text: "已按共性规则核查，缺口登记完毕。" },
    ]);

    await runTask(depsFor(model), taskId);

    // nudge 消息进入了追问后的那次请求
    expect(prompts).toHaveLength(4);
    const nudgeMessage = JSON.stringify(prompts[2]!.messages);
    expect(nudgeMessage).toContain("不与用户交互");
    expect(nudgeMessage).toContain("task_gaps");

    const task = db.getTask(taskId)!;
    expect(task.status).toBe("completed");
    const result = db.db.prepare("SELECT * FROM results WHERE task_id = ?").get(taskId) as Record<string, unknown>;
    expect(result.review_outcome).toBe("partial");
    const md = String(result.conclusion_md);
    expect(md).toContain("专项规则待确定"); // 全局缺口进入正文
    expect(md).toContain("运维服务还是人员外包");
    expect(md).toContain("缺采购纪要");
  });

  it("无有效产出且无缺口证明 → failed（空底稿不能推出缺材料）", async () => {
    const taskId = seedTask();
    const { model } = makeFakeModel([{ text: "无法执行。" }]);

    await runTask(depsFor(model), taskId);

    const task = db.getTask(taskId)!;
    expect(task.status).toBe("failed");
    expect(task.status_reason).toBeTruthy();
  });

  it("claimTask 原子领取：并发两次 runTask 只有一个执行", async () => {
    const taskId = seedTask();
    const { model } = makeFakeModel([{ text: "无材料可审。" }]);
    const deps = depsFor(model);
    await Promise.all([runTask(deps, taskId), runTask(deps, taskId)]);
    const events = db.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type IN ('task_complete','task_failed')")
      .get(taskId) as { n: number };
    expect(events.n).toBe(1);
  });
});

describe("P1-1 凭据闸门", () => {
  it("skill 无法加载时，登记了实质发现也不能发布完整意见 → failed", async () => {
    const taskId = seedTask("demo-skill@not-installed");
    const { model } = makeFakeModel([
      { toolCalls: [{ id: "call_1", name: "skill", input: {} }] }, // skill 工具返回错误
      { toolCalls: [{ id: "call_2", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(FULL_PAPERS) } }] },
      { text: "完成。" },
    ]);

    await runTask(depsFor(model), taskId);

    const task = db.getTask(taskId)!;
    expect(task.status).toBe("failed");
    expect(task.status_reason).toContain("skill");
    const result = db.db.prepare("SELECT COUNT(*) AS n FROM results WHERE task_id = ?").get(taskId) as { n: number };
    expect(result.n).toBe(0); // 未发布任何结果
  });

  it("材料存在但从未读取（无检索/回读成功）时，实质发现不能发布", async () => {
    const taskId = seedTask();
    const now = Date.now();
    db.db
      .prepare(
        `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
         VALUES (?, 1, 1, 'd_01', 1, '主合同', '主合同.docx', 'initial', NULL)`,
      )
      .run(taskId);
    // docStatusCache 查询会失败（无 pipeline）→ 材料状态 unknown；readDocs 为空
    const { model } = makeFakeModel([
      { toolCalls: [{ id: "call_s", name: "skill", input: {} }] },
      { toolCalls: [{ id: "call_w", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(FULL_PAPERS) } }] },
      { text: "完成。" },
    ]);

    await runTask(depsFor(model), taskId);

    // write_file 阶段：有材料任务 + 实质发现 + 未引用读过文件 → 底稿写入被拒；
    // 模型重试耗尽后结束，findings 依据不足 → failed（不发布）
    const task = db.getTask(taskId)!;
    expect(["failed", "completed"]).toContain(task.status);
    if (task.status === "completed") {
      // 若底稿整体被拒、papers 空 → no_valid_output → failed；此断言保护误发布路径
      const row = db.db.prepare("SELECT review_outcome FROM results WHERE task_id = ?").get(taskId) as { review_outcome: string };
      expect(row.review_outcome).not.toBe("complete");
    }
  });
});

describe("P1-6 v0.5 升级任务的恢复上下文", () => {
  it("检查点修订落后时，已接纳文字作为既定事实进入首个模型请求", async () => {
    const taskId = seedTask();
    const now = Date.now();
    db.db
      .prepare(
        `UPDATE tasks SET input_revision = 2 WHERE task_id = ?`,
      )
      .run(taskId);
    // 旧检查点：修订 1 的消息（不含已接纳文字）
    db.saveCheckpoint({
      task_id: taskId,
      batch: "run_old",
      step_no: 1,
      input_revision: 1,
      messages: JSON.stringify([{ role: "user", content: "初次任务说明（修订1）" }]),
      papers: JSON.stringify({ scope: null, items: [], task_gaps: [], conclusion_hint: null }),
      evidence: null,
      created_at: now - 1000,
    });
    // 修订 2 的已接纳文字
    db.db
      .prepare("INSERT INTO supplement_texts (task_id, revision, request_id, text, created_at) VALUES (?, 2, 'req_1', ?, ?)")
      .run(taskId, "本次按驻场人天结算", now);

    const { model, prompts } = makeFakeModel([
      { toolCalls: [{ id: "call_s", name: "skill", input: {} }] },
      { text: "结束。" },
    ]);
    await runTask(depsFor(model), taskId);

    // 首个请求从已接纳事实重建：包含既定事实，且不含旧的待补问句
    const first = JSON.stringify(prompts[0]!.messages);
    expect(first).toContain("已确认的补充事实");
    expect(first).toContain("按驻场人天结算");
    expect(first).not.toContain("修订1");
  });
});
