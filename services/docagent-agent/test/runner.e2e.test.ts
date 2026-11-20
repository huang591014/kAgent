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

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-"));
  db = new Db(path.join(baseDir, "agent.db"));
  // 安装根注入为临时目录，测试不污染真实 var/skills
  skills = new SkillRegistry(db, path.join(baseDir, "skills"));
  const pkgDir = path.join(baseDir, "src-demo-skill");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示\n---\n# 演示技能\n");
  skills.install(pkgDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function seedTask(): string {
  const taskId = "task_e2e01";
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO tasks (task_id, tenant_id, submitted_by, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
       VALUES (?, 't1', 'u1', '', 'demo-skill@x', '{}', 'queued', 1, NULL, 1, '{}', NULL, ?, ?)`,
    )
    .run(taskId, now, now);
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
      { text: "请确认合同类型？是运维服务还是人员外包？" }, // 纯追问 → nudge
      { toolCalls: [{ id: "call_w", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(PAPERS_WITH_GAP) } }] },
      { text: "已按共性规则核查，缺口登记完毕。" },
    ]);

    await runTask(depsFor(model), taskId);

    // nudge 消息进入了第二次请求
    expect(prompts).toHaveLength(3);
    const nudgeMessage = JSON.stringify(prompts[1]!.messages);
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
