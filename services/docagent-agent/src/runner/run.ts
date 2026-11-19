/** 任务执行循环（设计 §4.2 / §4.4）。

读取任务输入与最近完整检查点 → 判断材料可用性 → 调用模型 →
工具调用配对执行 → request_input 暂停等待 → 输出意见时按底稿成文发布。
发布前检查任务仍为有效批次、输入修订一致且未取消。
*/

import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { config } from "../config.js";
import type { Db, TaskRow } from "../db.js";
import { newBatchId, newRequestId } from "../ids.js";
import { determineOutcome, composeConclusion } from "../outcome.js";
import type { MaterialIssue, PapersDoc, StoredMessage, TaskUsage } from "../types.js";
import { coverageStats, enforceActiveScope, validatePapers, type ActiveScope } from "../papers.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OpenSearchRetrieval } from "../opensearch.js";
import { pipeline, type DocVersionStatus } from "../pipelineClient.js";
import { fitMessagesToBudget, estimateTokens } from "./context.js";
import { chatModel, modelCallOptions } from "./model.js";
import { executeTool, toolSchemas, WORKING_PAPERS_PATH, type ToolContext } from "./tools.js";
import { z } from "zod";

export interface RunnerDeps {
  db: Db;
  skills: SkillRegistry;
  retrieval: OpenSearchRetrieval;
  /** 运行中任务的取消句柄 */
  activeRuns: Map<string, AbortController>;
  /** 调度器回调：本任务结束后触发下一轮调度 */
  onSettled?: (taskId: string) => void;
  /** 模型工厂（测试注入替身；缺省用内网端点） */
  modelFactory?: () => LanguageModel;
}

const requestInputSchema = z.object({
  question: z.string().min(1),
  impact: z.string().min(1),
  accepted_inputs: z.array(z.enum(["text", "file"])).min(1),
  replace_target: z
    .object({ doc_id: z.string(), version: z.number().int().min(1) })
    .optional(),
});

class CancelledError extends Error {
  constructor() {
    super("任务已取消");
  }
}

export async function runTask(deps: RunnerDeps, taskId: string): Promise<void> {
  const { db } = deps;
  const controller = new AbortController();
  deps.activeRuns.set(taskId, controller);

  // 原子领取（C1）：仅当任务仍为 queued 时占用执行槽并分配批次，防止并发派发双跑
  const batch = newBatchId();
  const claim = db.claimTask(taskId, batch);
  if (!claim.claimed || !claim.task) {
    deps.activeRuns.delete(taskId);
    return;
  }
  const task = claim.task;
  const startedAt = Date.now();

  const materials = db.latestMaterials(taskId).map((m) => ({
    doc_id: m.doc_id,
    version: m.version,
    role: m.role,
    label: m.label,
  }));

  const ctx: ToolContext = {
    db,
    task: { ...task, status: "running", current_batch: batch },
    materials,
    identity: { tenant_id: task.tenant_id, user_id: task.submitted_by },
    skills: deps.skills,
    retrieval: deps.retrieval,
    docStatusCache: new Map(),
    papers: loadPapers(db, taskId),
    activeScope: db.getActiveScope(taskId, task.input_revision),
  };

  const usage = loadUsage(task.usage);

  try {
    await refreshStatusCache(ctx);
    let messages = restoreMessages(deps, ctx, task);

    let nudgedOnce = false;
    let stepGuard = usage.steps;

    while (true) {
      if (controller.signal.aborted) throw new CancelledError();
      const taskNow = db.getTask(taskId);
      if (!taskNow || taskNow.status === "cancelled") throw new CancelledError();

      // ===== 预算检查（设计 §4.4）=====
      const wallMinutes = (Date.now() - startedAt + usage.wall_seconds * 1000) / 60_000;
      const budgetNotes: string[] = [];
      let budgetExhausted = false;
      if (stepGuard >= config.maxSteps) {
        budgetNotes.push(`已达到最大执行步数（${config.maxSteps} 步），未完成的检查项按待核交付。`);
        budgetExhausted = true;
      }
      if (usage.input_tokens + usage.output_tokens >= config.maxTaskTokens) {
        budgetNotes.push("已达到任务 token 预算，未完成的检查项按待核交付。");
        budgetExhausted = true;
      }
      if (wallMinutes >= config.maxTaskWallMinutes) {
        budgetNotes.push(`已达到任务活动时长上限（${config.maxTaskWallMinutes} 分钟）。`);
        budgetExhausted = true;
      }
      if (budgetExhausted) {
        await finalize(deps, ctx, taskId, usage, startedAt, budgetNotes, true);
        return;
      }

      // ===== 模型调用 =====
      const fitted = fitMessagesToBudget(messages);
      const modelMessages = toModelMessages(fitted.messages);
      const result = await generateText({
        model: deps.modelFactory ? deps.modelFactory() : chatModel(),
        system: buildSystemPrompt(deps, ctx),
        messages: modelMessages,
        tools: toolSchemas,
        toolChoice: "auto",
        temperature: modelCallOptions.temperature,
        maxOutputTokens: modelCallOptions.maxOutputTokens,
        abortSignal: controller.signal,
      });
      usage.steps = ++stepGuard;
      usage.input_tokens += result.usage.inputTokens ?? 0;
      usage.output_tokens += result.usage.outputTokens ?? 0;
      usage.wall_seconds = Math.round((Date.now() - startedAt) / 1000);
      db.updateTask(taskId, { usage: JSON.stringify(usage) });

      const assistantText = result.text ?? "";
      messages.push({
        role: "assistant",
        content: assistantText,
        ...(result.toolCalls.length > 0
          ? {
              toolCalls: result.toolCalls.map((call) => ({
                id: call.toolCallId,
                name: call.toolName,
                input: call.input as unknown,
              })),
            }
          : {}),
      });

      // ===== 工具调用处理：每个调用恰好一条回执，tool 消息只写一次 =====
      if (result.toolCalls.length > 0) {
        const toolBlocks: Array<Record<string, unknown>> = [];
        let pausePlan: PausePlan | null = null;
        for (const call of result.toolCalls) {
          if (call.toolName === "request_input") {
            const prepared = prepareRequestInput(deps, ctx, call.toolCallId, call.input as unknown);
            toolBlocks.push(prepared.block);
            if (prepared.pause) pausePlan = prepared.pause;
            if (pausePlan) {
              // 暂停后同组剩余调用给出明确的跳过回执
              toolBlocks.push(...skippedBlocks(result.toolCalls, call.toolCallId));
              break;
            }
          } else {
            const executed = await executeTool(call.toolName, call.input as Record<string, unknown>, ctx);
            toolBlocks.push({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: executed.output,
              isError: executed.isError,
            });
          }
        }
        messages.push({ role: "tool", content: toolBlocks });

        if (pausePlan) {
          // 待补落库（单事务）：保存请求、检查点（含配对回执）与待补状态
          commitRequestInput(deps, ctx, pausePlan, messages, usage);
          return; // 释放执行槽
        }
        saveCheckpoint(deps, taskId, batch, messages, effectivePapers(ctx), usage);
        db.appendEvent(taskId, "progress", {
          step: usage.steps,
          checked: coverageStats(effectivePapers(ctx)).checked,
        });
        continue;
      }

      // ===== 无工具调用：成文或追问修正 =====
      if (isFollowUpOnly(assistantText) && !nudgedOnce) {
        nudgedOnce = true;
        messages.push({
          role: "user",
          content:
            "刚才的回复只包含追问，不能作为交付。请选择有效动作：需要用户补充时调用 request_input 工具；已有充分内容时，完成 working-papers.json 中各检查项的核对后直接结束（无需再输出全文，运行时会按底稿成文）。",
        });
        continue;
      }

      const notes: string[] = [];
      if (nudgedOnce) {
        notes.push("模型重试后仍未给出最终意见，以下结果由运行时按有效底稿整理。");
      }
      await finalize(deps, ctx, taskId, usage, startedAt, notes, false);
      return;
    }
  } catch (error) {
    if (error instanceof CancelledError || controller.signal.aborted) {
      db.transaction(() => {
        db.updateTask(taskId, { status: "cancelled", status_reason: "用户取消" });
        const open = db.openRequest(taskId);
        if (open) db.settleRequest(open.request_id, "closed", null, null);
      });
      db.appendEvent(taskId, "task_cancelled", {});
    } else {
      const stats = coverageStats(effectivePapers(ctx));
      if (stats.checked >= 1) {
        await finalize(deps, ctx, taskId, usage, startedAt, [`执行异常：${(error as Error).message}。以下为基于已核项的部分意见。`], true);
      } else {
        db.updateTask(taskId, {
          status: "failed",
          status_reason: `执行失败：${(error as Error).message}`.slice(0, 500),
        });
        db.appendEvent(taskId, "task_failed", { reason: (error as Error).message });
      }
    }
  } finally {
    deps.activeRuns.delete(taskId);
    deps.onSettled?.(taskId);
  }
}

// ===== request_input（设计 §4.2 提问上限 / 怎样恢复）=====
// 拆成两步：prepare 做纯决策（参数/幂等/上限），commit 在外层写完唯一的 tool 消息后
// 于单事务内落库——回执只写一次，检查点里带的就是配对后的消息。

interface PausePlan {
  requestId: string;
  toolCallId: string;
  seq: number;
  data: z.infer<typeof requestInputSchema>;
  reuseExisting: boolean;
}

interface RequestInputPrepared {
  block: Record<string, unknown>;
  pause: PausePlan | null;
}

function prepareRequestInput(
  deps: RunnerDeps,
  ctx: ToolContext,
  toolCallId: string,
  input: unknown,
): RequestInputPrepared {
  const { db } = deps;
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      pause: null,
      block: {
        type: "tool-result",
        toolCallId,
        toolName: "request_input",
        isError: true,
        output: { message: "参数校验失败（question/impact/accepted_inputs），请修正后重试。", issues: z.treeifyError(parsed.error) },
      },
    };
  }

  // 幂等：同一 tool_call_id 复用已创建的卡（服务重启 / 前端刷新 / 重试）
  const existing = db.getRequestByToolCall(ctx.task.task_id, toolCallId);
  if (existing) {
    return {
      pause: existing.status === "open"
        ? { requestId: existing.request_id, toolCallId, seq: existing.seq, data: parsed.data, reuseExisting: true }
        : null,
      block: {
        type: "tool-result",
        toolCallId,
        toolName: "request_input",
        output: {
          request_id: existing.request_id,
          status: existing.status,
          message: existing.status === "open" ? "该提问已登记，任务进入待补状态。" : "该提问已处理。",
        },
      },
    };
  }

  if (ctx.task.input_closed) {
    return {
      pause: null,
      block: {
        type: "tool-result",
        toolCallId,
        toolName: "request_input",
        isError: true,
        output: {
          message:
            "提问入口已关闭（用户已选择按现有材料出结果，或已达提问上限）。请基于现有材料完成可做的检查，在底稿中记录剩余缺口后结束。",
        },
      },
    };
  }

  const count = db.countRequests(ctx.task.task_id);
  if (count >= config.requestInputLimit) {
    db.updateTask(ctx.task.task_id, { input_closed: 1 });
    ctx.task.input_closed = 1;
    return {
      pause: null,
      block: {
        type: "tool-result",
        toolCallId,
        toolName: "request_input",
        isError: true,
        output: {
          message: `已达提问上限（${config.requestInputLimit} 张待补卡）。本任务提问入口已关闭：请按现有材料完成可做的检查，并在底稿与结果中说明剩余缺口。`,
        },
      },
    };
  }

  return {
    pause: { requestId: newRequestId(), toolCallId, seq: count + 1, data: parsed.data, reuseExisting: false },
    block: {
      type: "tool-result",
      toolCallId,
      toolName: "request_input",
      output: { message: "已向用户提出补充请求，任务即将暂停等待补充。" },
    },
  };
}

function commitRequestInput(
  deps: RunnerDeps,
  ctx: ToolContext,
  plan: PausePlan,
  messages: StoredMessage[],
  usage: TaskUsage,
): void {
  const { db } = deps;
  db.transaction(() => {
    if (!plan.reuseExisting) {
      db.createRequest({
        request_id: plan.requestId,
        task_id: ctx.task.task_id,
        tool_call_id: plan.toolCallId,
        seq: plan.seq,
        question: plan.data.question,
        impact: plan.data.impact,
        accepted_inputs: plan.data.accepted_inputs,
        status: "open",
        answer: null,
        answer_identity: null,
        created_at: Date.now(),
        answered_at: null,
        ...(plan.data.replace_target ? { replace_target: plan.data.replace_target } : {}),
      });
    }
    saveCheckpoint(deps, ctx.task.task_id, ctx.task.current_batch!, messages, effectivePapers(ctx), usage);
    db.updateTask(ctx.task.task_id, { status: "waiting_for_input" });
    db.appendEvent(ctx.task.task_id, "input_requested", { request_id: plan.requestId });
  });
}

/** 暂停后同组未执行调用的跳过回执（每个调用恰好一条结果，保持配对完整）。 */
function skippedBlocks(calls: ReadonlyArray<{ toolCallId: string; toolName: string }>, afterCallId: string): Array<Record<string, unknown>> {
  const index = calls.findIndex((c) => c.toolCallId === afterCallId);
  return calls
    .slice(index + 1)
    .map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      isError: true,
      output: { message: "任务因待补暂停，本调用未执行；恢复后请按需重新发起。" },
    }));
}

/** 统计/落库用底稿：以运行时保存的活动范围为准（缺失项按待核兜底）。 */
function effectivePapers(ctx: ToolContext): PapersDoc {
  return enforceActiveScope(ctx.papers, ctx.activeScope);
}

// ===== 成文与发布（设计 §5 / §4.4 发布竞态）=====

async function finalize(
  deps: RunnerDeps,
  ctx: ToolContext,
  taskId: string,
  usage: TaskUsage,
  startedAt: number,
  extraNotes: string[],
  executionBlocked: boolean,
): Promise<void> {
  const { db } = deps;
  await refreshStatusCache(ctx);
  const papers = effectivePapers(ctx);
  const materialIssues = buildMaterialIssues(ctx);
  const stats = coverageStats(papers);
  const allUnreadable = ctx.materials.length > 0 && ctx.materials.every((m) => {
    const cached = ctx.docStatusCache.get(`${m.doc_id}@${m.version}`);
    return !cached?.ready;
  });

  const outcome = determineOutcome(papers, {
    revisionMaterials: ctx.materials,
    materialIssues,
    allMaterialsUnreadable: allUnreadable,
  });

  // 执行故障/预算耗尽，既无可用实质审核结果、也无材料不足事实 → 任务失败（设计 §5 末段）
  if (executionBlocked && stats.checked === 0 && stats.findings === 0 && outcome !== "insufficient_materials") {
    db.updateTask(taskId, { status: "failed", status_reason: extraNotes[0] ?? "无可用审核结果" });
    db.appendEvent(taskId, "task_failed", { reason: extraNotes[0] ?? "无可用审核结果" });
    return;
  }

  const composed = composeConclusion({
    papers,
    outcome,
    ctx: {
      revisionMaterials: ctx.materials,
      materialIssues,
    },
    extraNotes,
  });

  usage.wall_seconds = Math.max(usage.wall_seconds, Math.round((Date.now() - startedAt) / 1000));

  // 发布事务：检查任务仍为有效批次、输入修订一致且未取消
  const published = db.transaction((): boolean => {
    const current = db.getTask(taskId);
    if (!current || current.status !== "running" || current.current_batch !== ctx.task.current_batch) {
      return false;
    }
    if (current.input_revision !== ctx.task.input_revision) return false;
    db.db
      .prepare(
        `INSERT OR REPLACE INTO results (task_id, conclusion_md, review_outcome, used_materials, material_issues, skill_ref, input_revision, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        composed.conclusion_md,
        composed.review_outcome,
        JSON.stringify(composed.used_materials),
        JSON.stringify(materialIssues),
        ctx.task.skill_ref,
        ctx.task.input_revision,
        JSON.stringify(usage),
        Date.now(),
      );
    db.updateTask(taskId, { status: "completed", status_reason: null, usage: JSON.stringify(usage) });
    db.appendEvent(taskId, "task_complete", { review_outcome: composed.review_outcome });
    return true;
  });

  if (!published) {
    // 批次或修订已变化：本批次结果丢弃（新批次会重跑）
    db.appendEvent(taskId, "progress", { note: "结果发布被跳过：任务批次/修订已变化" });
  }
}

// ===== 材料状态与 material_issues =====

async function refreshStatusCache(ctx: ToolContext): Promise<void> {
  for (const material of ctx.materials) {
    try {
      const status = await pipeline.docStatus(ctx.identity, material.doc_id, material.version);
      ctx.docStatusCache.set(`${material.doc_id}@${material.version}`, {
        status: status.status,
        ready: status.ready,
        needs_ocr: status.needs_ocr,
        error: status.error,
        parse_gaps: status.parse_gaps ?? [],
      });
    } catch (error) {
      ctx.docStatusCache.set(`${material.doc_id}@${material.version}`, {
        status: "unknown",
        ready: false,
        needs_ocr: false,
        error: { stage: "query", reason: (error as Error).message, retryable: true },
        parse_gaps: [],
      });
    }
  }
}

function buildMaterialIssues(ctx: ToolContext): MaterialIssue[] {
  const issues: MaterialIssue[] = [];
  const timedOut = ctx.db.timedOutDocs(ctx.task.task_id, ctx.task.input_revision);
  for (const material of ctx.materials) {
    const cached = ctx.docStatusCache.get(`${material.doc_id}@${material.version}`);
    if (!cached) continue;
    let issue: string | null = null;
    if (cached.status === "needs_ocr") issue = "疑似扫描件，暂不可读（M1 不支持 OCR）";
    else if (cached.status === "failed") {
      const error = cached.error as { reason?: string } | null;
      issue = `处理失败：${error?.reason ?? "未知原因"}`;
    } else if (!cached.ready && timedOut.has(`${material.doc_id}@${material.version}`)) {
      issue = `等待索引超时（>${Math.round(config.waitingIndexTimeoutSeconds / 60)} 分钟），本次按单份材料不可用处理`;
    } else if (!cached.ready && ["parsing", "structuring", "indexing", "uploaded"].includes(cached.status)) {
      issue = `材料仍在处理中（${cached.status}），本次未能纳入核查`;
    } else if (cached.status === "unknown") {
      issue = "材料状态查询失败";
    }
    if (!issue) continue;
    const affected = ctx.papers.items.filter(
      (item) =>
        item.status === "pending" &&
        (item.missing_role === material.role ||
          item.used_materials.some((m) => m.doc_id === material.doc_id && m.version === material.version)),
    );
    issues.push({
      doc_id: material.doc_id,
      version: material.version,
      label: material.label,
      issue,
      impact:
        affected.length > 0
          ? `${affected.length} 项检查依赖该材料，未能核查：${affected.map((i) => i.item_id).slice(0, 6).join("、")}`
          : "依赖该材料的检查项未能核查",
    });
  }
  return issues;
}

// ===== 消息与底稿装载 =====

function loadPapers(db: Db, taskId: string): PapersDoc {
  const file = db.getFile(taskId, WORKING_PAPERS_PATH);
  if (!file) return { scope: null, items: [], conclusion_hint: null };
  try {
    const parsed = JSON.parse(file.content);
    return { scope: parsed.scope ?? null, items: parsed.items ?? [], conclusion_hint: parsed.conclusion_hint ?? null };
  } catch {
    return { scope: null, items: [], conclusion_hint: null };
  }
}

function loadUsage(raw: string): TaskUsage {
  try {
    const parsed = JSON.parse(raw) as TaskUsage;
    return {
      steps: parsed.steps ?? 0,
      input_tokens: parsed.input_tokens ?? 0,
      output_tokens: parsed.output_tokens ?? 0,
      wall_seconds: parsed.wall_seconds ?? 0,
    };
  } catch {
    return { steps: 0, input_tokens: 0, output_tokens: 0, wall_seconds: 0 };
  }
}

function restoreMessages(deps: RunnerDeps, ctx: ToolContext, task: TaskRow): StoredMessage[] {
  const { db } = deps;
  const checkpoint = db.latestCheckpoint(task.task_id);
  const materialsBrief = ctx.materials
    .map((m) => `- ${m.label}（doc_id=${m.doc_id}，v${m.version}，用途=${m.role}）`)
    .join("\n");

  const initialBrief = [
    `请审核以下材料。场景：${task.scenario || "合同合规审核"}。`,
    "绑定 skill：" + task.skill_ref,
    "材料清单：",
    materialsBrief || "（无材料，仅有文字说明）",
    "",
    "请先加载 skill、查看材料状态与目录，确定审查路径后在 working-papers.json 登记 scope 与预期检查项（全部初始 pending），逐项核查并更新，全部完成后结束。",
  ].join("\n");

  if (!checkpoint) {
    return [{ role: "user", content: initialBrief }];
  }

  const messages = JSON.parse(checkpoint.messages) as StoredMessage[];

  // 恢复待补回答后的上下文：追加用户补充消息
  const answered = findLatestAnswer(deps, task.task_id, task.input_revision);
  if (answered) {
    const lines: string[] = [`【用户补充】（request_id=${answered.request_id}）`];
    if (answered.receipt.text) lines.push(`文字回答：${answered.receipt.text}`);
    for (const doc of answered.receipt.add_docs) {
      lines.push(`新增材料：${doc.label ?? doc.doc_id}（doc_id=${doc.doc_id}，v${doc.version}，用途=${doc.role}）`);
    }
    for (const rep of answered.receipt.replace_docs) {
      lines.push(`替换材料：${rep.old.doc_id}@v${rep.old.version} → ${rep.new.doc_id}@v${rep.new.version}（用途=${rep.role}）；引用旧版本的意见已标记为待复核`);
    }
    if (answered.receipt.action === "finish_with_available") {
      lines.push("用户决定：按现有材料出结果。本任务已关闭后续补充请求，请完成可做的核查并在底稿中记录剩余缺口后结束。");
    } else {
      lines.push("请按当前规则卡复核受影响的检查项（missing_role 匹配或原为待核的事项），更新底稿后继续。");
    }
    messages.push({ role: "user", content: lines.join("\n") });
  }

  return messages;
}

function findLatestAnswer(deps: RunnerDeps, taskId: string, revision: number): { request_id: string; receipt: NonNullable<import("../types.js").InputAnswerReceipt> } | null {
  const { db } = deps;
  const rows = db.db
    .prepare(
      "SELECT request_id, answer FROM input_requests WHERE task_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 5",
    )
    .all(taskId) as Array<{ request_id: string; answer: string }>;
  for (const row of rows) {
    try {
      const receipt = JSON.parse(row.answer) as import("../types.js").InputAnswerReceipt;
      if (receipt.accepted_revision === revision) return { request_id: row.request_id, receipt };
    } catch {
      /* 跳过损坏回执 */
    }
  }
  return null;
}

function saveCheckpoint(deps: RunnerDeps, taskId: string, batch: string, messages: StoredMessage[], papers: PapersDoc, usage: TaskUsage): void {
  deps.db.saveCheckpoint({
    task_id: taskId,
    batch,
    step_no: usage.steps,
    input_revision: deps.db.getTask(taskId)?.input_revision ?? 1,
    messages: JSON.stringify(messages),
    papers: JSON.stringify(papers),
    created_at: Date.now(),
  });
}

// ===== 系统提示 =====

function buildSystemPrompt(deps: RunnerDeps, ctx: ToolContext): string {
  const parts: string[] = [];
  parts.push(
    [
      "你是 DocAgent 平台的合同合规审核 Agent。你的工作是按绑定的 skill 完成材料审查，并把过程与结论落到任务工作区的 working-papers.json 底稿。",
      "",
      "工作纪律：",
      "1. 先用 skill 工具加载技能正文，用 doc_status / doc_outline 了解材料，再开始审查。",
      "2. 确定审查路径后，立即在 working-papers.json 登记 scope（rule_cards + expected_item_ids）并为每个预期检查项建立 pending 记录。",
      `3. 底稿用 write_file / edit_file 维护，路径必须是 ${WORKING_PAPERS_PATH}。每核完一项即更新：状态 checked（finding 填 problem+suggestion，可附 location/basis）、pending（pending_reason+missing_role）、not_applicable（not_applicable_reason）。实际使用的材料记入 used_materials。`,
      "4. 只有「缺失信息会改变规则卡选择」或「关键输入缺失使实质审核无法继续」时才调用 request_input 提问；问题面向用户能回答的业务事实，并说明影响哪项判断。最多 3 次提问。",
      "5. 单份材料失败不阻塞其余审查：继续可审内容，相关项保持 pending 并注明原因。",
      "6. 全部检查项处理完毕后直接结束输出简短总结即可——最终意见书由运行时按底稿组装，正文中的材料引用注明所用材料（文件）即可，不需要定位到段落或条款。",
      "7. 不要在正文中向用户追问业务事实——等待用户回答必须通过 request_input 工具。",
    ].join("\n"),
  );
  parts.push(deps.skills.manifestListing());
  const statusLines = ctx.materials.map((m) => {
    const cached = ctx.docStatusCache.get(`${m.doc_id}@${m.version}`);
    const state = cached?.ready ? "已就绪" : cached ? `状态=${cached.status}` : "未知";
    return `- ${m.label}（doc_id=${m.doc_id}，v${m.version}，用途=${m.role}）：${state}`;
  });
  if (statusLines.length > 0) {
    parts.push(["当前材料状态：", ...statusLines].join("\n"));
  }
  return parts.join("\n\n");
}

// ===== 工具函数 =====

/** 正文是否只是追问（设计 §4.2：含章标题的纯追问也进入修正路径）。 */
export function isFollowUpOnly(text: string): boolean {
  const stripped = text
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/【[^】]*】/g, "")
    .trim();
  const compact = stripped.replace(/\s+/g, "");
  if (compact.length === 0) return false;
  // 问句 = 以 ？/? 结尾的片段（其余标点/换行为界）
  const questionSegments = compact.match(/[^。！？!?；;\n]*[？?]/g) ?? [];
  const questionChars = questionSegments.reduce((sum, s) => sum + s.length, 0);
  if (questionChars === 0) return false;
  // 问句里要有面向用户的祈使语气（请…）才算是追问；纯陈述性的设问不算
  const asking = questionSegments.some((s) => /(请|能否|是否|可否|麻烦)/.test(s));
  if (!asking) return false;
  return questionChars / compact.length > 0.4;
}

/** StoredMessage → AI SDK ModelMessage（v5+ 形态）：
 * - assistant 的工具调用是 content 数组里的 `tool-call` 块（不再使用旧 toolCalls 字段）；
 * - tool 的 output 必须包装为 SDK 支持的 ToolResultContent：对象 → {type:'json'}，
 *   字符串 → {type:'text'}，错误 → {type:'error-text'}。
 */
function toModelMessages(messages: readonly StoredMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = typeof message.content === "string" ? message.content : "";
      if (text.length > 0) content.push({ type: "text", text });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: (call.input ?? {}) as Record<string, unknown>,
        });
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      return { role: "assistant", content } as ModelMessage;
    }
    if (message.role === "tool") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      return {
        role: "tool",
        content: blocks.map((raw) => {
          const block = raw as Record<string, unknown>;
          return {
            type: "tool-result",
            toolCallId: String(block.toolCallId),
            toolName: String(block.toolName),
            output: toToolResultContent(block.output, block.isError === true),
            ...(block.isError === true ? { isError: true } : {}),
          };
        }),
      } as ModelMessage;
    }
    return {
      role: message.role,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    } as ModelMessage;
  });
}

function toToolResultContent(
  output: unknown,
  isError: boolean,
): { type: "json"; value: unknown } | { type: "text"; value: string } | { type: "error-text"; value: string } {
  if (isError && typeof output === "string") return { type: "error-text", value: output };
  if (typeof output === "string") return { type: "text", value: output };
  if (output === null || output === undefined) return { type: "json", value: null };
  if (typeof output === "object") return { type: "json", value: output };
  return { type: "json", value: { value: output } };
}

export { validatePapers, estimateTokens };
