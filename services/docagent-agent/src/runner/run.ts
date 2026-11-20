/** 任务执行循环（v0.6 §2/§3：单次提交，无用户交互）。

读取任务输入与最近完整检查点 → 判断材料可用性 → 调用模型 →
工具调用配对执行 → 缺口登记进底稿（检查项 pending / 任务级 task_gaps）→
按有效底稿成文发布。发布前检查任务仍为有效批次且未取消。
*/

import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { config } from "../config.js";
import type { Db, TaskRow } from "../db.js";
import { newBatchId } from "../ids.js";
import { composeConclusion, determineOutcome } from "../outcome.js";
import type { MaterialIssue, PapersDoc, StoredMessage, TaskUsage } from "../types.js";
import { coverageStats, enforceActiveScope, type ActiveScope } from "../papers.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OpenSearchRetrieval } from "../opensearch.js";
import { pipeline } from "../pipelineClient.js";
import { fitMessagesToBudget } from "./context.js";
import { chatModel, modelCallOptions } from "./model.js";
import { executeTool, toolSchemas, WORKING_PAPERS_PATH, type ToolContext } from "./tools.js";

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

class CancelledError extends Error {
  constructor() {
    super("任务已取消");
  }
}

export async function runTask(deps: RunnerDeps, taskId: string): Promise<void> {
  const { db } = deps;
  // 原子领取（v0.6 §3：领取成功后再绑定取消句柄）
  const batch = newBatchId();
  const claim = db.claimTask(taskId, batch);
  if (!claim.claimed || !claim.task) return;
  const controller = new AbortController();
  deps.activeRuns.set(taskId, controller);
  const task = claim.task;
  const startedAt = Date.now();

  const materials = db.latestMaterials(taskId).map((m) => ({
    doc_id: m.doc_id,
    version: m.version,
    role: m.role,
    label: m.label,
  }));

  const papers = loadPapers(db, taskId);
  const ctx: ToolContext = {
    db,
    task: { ...task, status: "running", current_batch: batch },
    materials,
    identity: { tenant_id: task.tenant_id, user_id: task.submitted_by, admin: task.is_admin === 1 },
    skills: deps.skills,
    retrieval: deps.retrieval,
    docStatusCache: new Map(),
    papers,
    activeScope: db.getActiveScope(taskId, task.input_revision),
    evidence: restoreEvidence(db, taskId, task.input_revision, papers),
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

      // ===== 预算检查（设计 §4.4）：wall 为历史累计 + 本批次增量，不重复相加 =====
      const wallMinutes = (usage.wall_seconds * 1000 + (Date.now() - startedAt)) / 60_000;
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
        for (const call of result.toolCalls) {
          const executed = await executeTool(call.toolName, call.input as Record<string, unknown>, ctx);
          toolBlocks.push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: executed.output,
            isError: executed.isError,
          });
        }
        messages.push({ role: "tool", content: toolBlocks });
        saveCheckpoint(deps, taskId, batch, messages, effectivePapers(ctx), usage, ctx.evidence);
        db.appendEvent(taskId, "progress", {
          step: usage.steps,
          checked: coverageStats(effectivePapers(ctx)).checked,
        });
        continue;
      }

      // ===== 无工具调用：成文或追问修正（v0.6 §2：只在服务端给一次纠正机会）=====
      if (isFollowUpOnly(assistantText) && !nudgedOnce) {
        nudgedOnce = true;
        messages.push({
          role: "user",
          content:
            "刚才的回复只包含追问，不能作为交付。本流程不与用户交互：请继续可做的检查；确有缺口时，把缺什么、影响哪项判断登记进 working-papers.json（对应检查项标 pending 并写明原因，任务级缺口写入 task_gaps），然后直接结束（无需输出全文，运行时会按底稿成文）。",
        });
        continue;
      }

      const notes: string[] = [];
      if (nudgedOnce) {
        notes.push("模型重试后仍未给出最终意见，以下结果由运行时按有效底稿整理。");
      }
      // P1-2a：还有待核项且依赖的材料仍在处理且未超时 → 保存检查点转 waiting_index，等就绪/失败/截止再收尾
      await refreshStatusCache(ctx);
      const statsNow = coverageStats(effectivePapers(ctx));
      const timedOutNow = db.timedOutDocs(taskId, task.input_revision);
      const stillProcessing = ctx.materials.filter((m) => {
        const cached = ctx.docStatusCache.get(`${m.doc_id}@${m.version}`);
        return cached && !cached.ready && ["uploaded", "parsing", "structuring", "indexing"].includes(cached.status) && !timedOutNow.has(`${m.doc_id}@${m.version}`);
      });
      if (statsNow.pending > 0 && stillProcessing.length > 0) {
        for (const m of stillProcessing) {
          db.getOrCreateWait(taskId, task.input_revision, m.doc_id, m.version, config.waitingIndexTimeoutSeconds * 1000);
        }
        saveCheckpoint(deps, taskId, batch, messages, effectivePapers(ctx), usage, ctx.evidence);
        if (db.transitionTask(taskId, "running", "waiting_index")) {
          db.appendEvent(taskId, "progress", { note: `等待 ${stillProcessing.length} 份材料索引完成后继续` });
          return; // 释放执行槽
        }
      }
      await finalize(deps, ctx, taskId, usage, startedAt, notes, false);
      return;
    }
  } catch (error) {
    if (error instanceof CancelledError || controller.signal.aborted) {
      // 条件更新：仅 running 且属本批次时落取消（取消服务可能已先写入）
      db.transitionTask(taskId, "running", "cancelled", { status_reason: "用户取消" });
      db.appendEvent(taskId, "task_cancelled", {});
    } else {
      // P1-3：异常也统一走判定——已核≥1 交付部分意见；零已核但已登记可独立阻断审核的材料缺口
      // 交付 insufficient；否则 no_valid_output → failed。不再绕过已登记的缺口。
      await finalize(
        deps,
        ctx,
        taskId,
        usage,
        startedAt,
        [`执行异常：${(error as Error).message}。`],
        true,
      );
    }
  } finally {
    deps.activeRuns.delete(taskId);
    deps.onSettled?.(taskId);
  }
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

  // P1-1：凭据闸门——未成功加载 skill、或从未实际读到任何材料时，不发布实质合同意见
  const evidenceOk = ctx.evidence.skillLoaded && (ctx.materials.length === 0 || ctx.evidence.readDocs.size > 0);
  if (stats.findings > 0 && !evidenceOk) {
    const reason = !ctx.evidence.skillLoaded
      ? "未成功加载绑定的 skill，发现的意见缺乏依据，不发布"
      : "未实际读取任何材料内容，发现的意见缺乏依据，不发布";
    db.updateTask(taskId, { status: "failed", status_reason: reason });
    db.appendEvent(taskId, "task_failed", { reason });
    return;
  }

  const timedOut = db.timedOutDocs(taskId, ctx.task.input_revision);
  // P1-3：只有**材料性**不可读才计入——扫描件、不可重试的解析失败；
  // 索引写入失败（可重试）与等待超时属技术原因，状态查询失败同理，均不能推出用户缺材料
  const clearlyUnreadable = (docId: string, version: number): boolean => {
    const cached = ctx.docStatusCache.get(`${docId}@${version}`);
    if (!cached || cached.ready) return false;
    if (cached.status === "needs_ocr") return true;
    if (cached.status === "failed") {
      const error = cached.error as { retryable?: boolean } | null;
      return error?.retryable === false;
    }
    return false;
  };
  void timedOut;
  const allUnreadable = ctx.materials.length > 0 && ctx.materials.every((m) => clearlyUnreadable(m.doc_id, m.version));

  const outcome = determineOutcome(papers, {
    revisionMaterials: ctx.materials,
    materialIssues,
    allMaterialsUnreadable: allUnreadable,
  });

  if (outcome === "no_valid_output") {
    // v0.6 §4：无已证实的材料/事实缺口，也无可用审核结果 → failed（含空底稿/普通待执行/状态查询失败的情形）
    const reason = extraNotes[0] ?? "未产出有效审核结果（无已核项，也无已证实的材料或事实缺口）";
    db.updateTask(taskId, { status: "failed", status_reason: reason.slice(0, 500) });
    db.appendEvent(taskId, "task_failed", { reason });
    return;
  }

  // 执行故障/预算耗尽，既无可用实质审核结果、也无材料不足事实 → 任务失败（v0.6 §4 表末行）
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

  usage.wall_seconds = usage.wall_seconds + Math.round((Date.now() - startedAt) / 1000);

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
  const empty: PapersDoc = { scope: null, items: [], task_gaps: [], conclusion_hint: null };
  const file = db.getFile(taskId, WORKING_PAPERS_PATH);
  if (!file) return empty;
  try {
    const parsed = JSON.parse(file.content);
    return {
      scope: parsed.scope ?? null,
      items: parsed.items ?? [],
      task_gaps: Array.isArray(parsed.task_gaps) ? parsed.task_gaps : [],
      conclusion_hint: parsed.conclusion_hint ?? null,
    };
  } catch {
    return empty;
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
    "本流程为单次提交：缺材料或类型不明时继续可做的检查，把缺口登记进底稿（pending 原因 / task_gaps）后结束。",
  ].join("\n");

  // P1-6：仅复用与当前输入修订一致的检查点；陈旧检查点（补件后未写新检查点）从头重建，
  // 已接纳的补充文字作为既定事实注入，旧待补问句只留作历史、不作为已核事实。
  if (checkpoint && checkpoint.input_revision === task.input_revision) {
    return JSON.parse(checkpoint.messages) as StoredMessage[];
  }
  if (checkpoint) {
    db.appendEvent(task.task_id, "progress", {
      note: `检查点修订 ${checkpoint.input_revision} 落后于输入修订 ${task.input_revision}，按已接纳事实重建上下文`,
    });
  }

  const supplements = db.listSupplementTexts(task.task_id, task.input_revision);
  if (supplements.length === 0) {
    return [{ role: "user", content: initialBrief }];
  }
  const factLines = supplements.map((s) => `- （修订 r${s.revision}）${s.text}`);
  return [
    {
      role: "user",
      content: [
        initialBrief,
        "",
        "【已确认的补充事实】（用户此前已提供，作为既定输入，不要再次询问）：",
        ...factLines,
      ].join("\n"),
    },
  ];
}

/** 恢复运行时凭据（P1-1）：优先取最近同修订检查点的 evidence；
 * 无则从当前底稿的 used_materials 重建（写入时已校验其必为实际读过的版本）。 */
function restoreEvidence(db: Db, taskId: string, revision: number, papers: PapersDoc): { skillLoaded: boolean; readDocs: Set<string> } {
  const checkpoint = db.latestCheckpoint(taskId);
  if (checkpoint && checkpoint.evidence && checkpoint.input_revision === revision) {
    try {
      const parsed = JSON.parse(checkpoint.evidence) as { skillLoaded?: boolean; readDocs?: string[] };
      return { skillLoaded: parsed.skillLoaded === true, readDocs: new Set(parsed.readDocs ?? []) };
    } catch {
      /* 损坏则走重建 */
    }
  }
  const readDocs = new Set<string>();
  for (const item of papers.items) {
    for (const ref of item.used_materials) {
      readDocs.add(`${ref.doc_id}@${ref.version}`);
    }
  }
  return { skillLoaded: papers.items.length > 0 || papers.scope !== null, readDocs };
}

function saveCheckpoint(
  deps: RunnerDeps,
  taskId: string,
  batch: string,
  messages: StoredMessage[],
  papers: PapersDoc,
  usage: TaskUsage,
  evidence?: { skillLoaded: boolean; readDocs: Set<string> },
): void {
  deps.db.saveCheckpoint({
    task_id: taskId,
    batch,
    step_no: usage.steps,
    input_revision: deps.db.getTask(taskId)?.input_revision ?? 1,
    messages: JSON.stringify(messages),
    papers: JSON.stringify(papers),
    evidence: evidence ? JSON.stringify({ skillLoaded: evidence.skillLoaded, readDocs: [...evidence.readDocs] }) : null,
    created_at: Date.now(),
  });
}

// ===== 系统提示 =====

function buildSystemPrompt(deps: RunnerDeps, ctx: ToolContext): string {
  const parts: string[] = [];
  parts.push(
    [
      "你是 DocAgent 平台的合同合规审核 Agent。本次审核为单次提交：不与用户交互、不能提问或等待补充。你的工作是按绑定的 skill 完成现有材料上可做的全部检查，把过程、结论与缺口落到任务工作区的 working-papers.json 底稿。",
      "",
      "工作纪律：",
      "1. 先用 skill 工具加载技能正文，用 doc_status / doc_outline 了解材料，再开始审查。",
      "2. 确定审查路径后，立即在 working-papers.json 登记 scope（rule_cards + expected_item_ids）并为每个预期检查项建立 pending 记录。合同类型不明时：先完成能确定的共性/非标兜底规则，专项适用性无法确定的缺口写入 task_gaps（category=route_undetermined）。",
      `3. 底稿用 write_file / edit_file 维护，路径必须是 ${WORKING_PAPERS_PATH}。每核完一项即更新：状态 checked（finding 填 problem+suggestion，可附 location/basis）、pending（pending_reason 写清涉及判断与具体原因：缺材料/缺事实/文件处理失败）、not_applicable（not_applicable_reason）。实际使用的材料记入 used_materials。`,
      "4. 缺材料（如采购纪要）只影响依赖它的检查项：这些项保持 pending 并写明原因与影响；从未提交的材料只写用途（missing_role），不要虚构文件标识。",
      "5. 任务级缺口（专项路由待确定、关键事实缺失、已提交文件处理失败但不落在具体检查项）写入底稿的 task_gaps 数组：gap_id、category（missing_material/missing_fact/file_issue/route_undetermined/budget）、statement（陈述句：现有材料支持什么、缺什么）、impact。",
      "6. 单份材料失败不阻塞其余审查：继续可审内容。检索无命中时先查目录或通读相关范围，再判断条款是否缺失。",
      "7. 全部处理完毕后直接结束输出简短总结即可——最终意见书由运行时按底稿组装，正文中的材料引用注明所用材料（文件）即可，不需要定位到段落或条款。",
      "8. 任何时候都不要向用户提问或要求补充——缺口登记进底稿即可，用户会在结果中看到。",
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
