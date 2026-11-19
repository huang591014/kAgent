/** A2 验收：本地模型替身驱动真实 runTask。
 *
 * - 三次请求都实际到达替身（skill → write_file → 最终响应）；
 * - 消息以 SDK ModelMessage 形态往返，工具调用与结果按原 ID 配对且各出现一次；
 * - request_input：暂停 → 接纳 → 恢复，回执无重复，恢复后首请求通过 SDK 校验。
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
import { taskService } from "../src/taskService.js";

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

const identity = { tenant_id: "t1", user_id: "u1" };

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
       VALUES (?, 't1', 'u1', '', 'demo-skill@x', '{}', 'queued', 1, NULL, 0, '{}', NULL, ?, ?)`,
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

describe("runTask（模型替身 e2e）", () => {
  it("工具循环贯通：三次请求到达替身，底稿落盘并发布 complete 结果", async () => {
    const taskId = seedTask();
    const { model, prompts } = makeFakeModel([
      { toolCalls: [{ id: "call_1", name: "skill", input: {} }] },
      { toolCalls: [{ id: "call_2", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(FULL_PAPERS) } }] },
      { text: "审核完成，意见如底稿所述。" },
    ]);

    await runTask(depsFor(model), taskId);

    expect(prompts).toHaveLength(3); // 验收：三次请求都实际到达替身
    // 第 2 次请求包含 call_1 的 tool-result（配对完整、形态合法）
    const second = JSON.stringify(prompts[1]!.messages);
    expect(second).toContain("call_1");
    // 第 3 次请求包含 call_2 的 tool-result
    expect(JSON.stringify(prompts[2]!.messages)).toContain("call_2");

    const task = db.getTask(taskId)!;
    expect(task.status).toBe("completed");
    const result = db.db.prepare("SELECT * FROM results WHERE task_id = ?").get(taskId) as Record<string, string>;
    expect(result.review_outcome).toBe("complete");
    expect(result.conclusion_md).toContain("未约定验收标准");
    // B1：活动范围已独立保存
    const scope = db.getActiveScope(taskId, 1);
    expect(scope?.expected_item_ids).toEqual(["c1", "c2"]);
  });

  it("request_input 暂停与恢复：回执唯一，恢复后首请求通过 SDK 校验", async () => {
    const taskId = seedTask();

    // 第一轮：模型提问 → 任务暂停
    const first = makeFakeModel([
      { toolCalls: [{ id: "call_q", name: "request_input", input: { question: "按人天还是按结果验收？", impact: "决定专项卡", accepted_inputs: ["text"] } }] },
    ]);
    await runTask(depsFor(first.model), taskId);
    expect(db.getTask(taskId)!.status).toBe("waiting_for_input");
    const open = db.openRequest(taskId);
    expect(open).toBeDefined();
    expect(open!.question).toContain("人天");

    // 检查点中的消息包含 assistant tool-call 与配对 tool-result（各一次）
    const checkpoint = db.latestCheckpoint(taskId)!;
    const messages = JSON.parse(checkpoint.messages) as Array<{ role: string; content: unknown; toolCalls?: Array<{ id: string }> }>;
    const assistantCalls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []);
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]!.id).toBe("call_q");
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const blocks = toolMessages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.toolCallId).toBe("call_q");

    // 用户补充文字 → 接纳 → 恢复执行
    taskService.acceptInput({ db }, identity, taskId, {
      request_id: open!.request_id,
      action: "supplement",
      text: "按季度运维结果验收",
    });
    expect(db.getTask(taskId)!.status).toBe("queued");
    expect(db.getTask(taskId)!.input_revision).toBe(2);

    // 第二轮：复核并写底稿 → 完成
    const second = makeFakeModel([
      { toolCalls: [{ id: "call_w", name: "write_file", input: { path: WORKING_PAPERS_PATH, content: JSON.stringify(FULL_PAPERS) } }] },
      { text: "已按运维服务规则复核完成。" },
    ]);
    await runTask(depsFor(second.model), taskId);

    // 恢复后的首个模型请求：request_input 回执恰好一条（无重复）
    const resumed = JSON.stringify(second.prompts[0]!.messages);
    const occurrences = resumed.split("call_q").length - 1; // tool-call 块 1 + tool-result 块 1 = 2
    expect(occurrences).toBe(2);
    expect(db.getTask(taskId)!.status).toBe("completed");
    const result = db.db.prepare("SELECT * FROM results WHERE task_id = ?").get(taskId) as Record<string, unknown>;
    expect(Number(result.input_revision)).toBe(2);
  });

  it("claimTask 原子领取：并发两次 runTask 只有一个执行", async () => {
    const taskId = seedTask();
    const { model } = makeFakeModel([{ text: "无材料可审。" }]);
    const deps = depsFor(model);
    const [a, b] = await Promise.all([runTask(deps, taskId), runTask(deps, taskId)]);
    void a;
    void b;
    const events = db.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_complete'")
      .get(taskId) as { n: number };
    expect(events.n).toBe(1);
  });
});
