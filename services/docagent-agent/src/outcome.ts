/** 审核覆盖判定与发布正文成文（设计 §5）。

review_outcome 由运行时以当前审核范围和有效底稿确定；
结论正文始终由运行时从底稿组装（模型成文与兜底成文使用同一逻辑），
空底稿或损坏的写入不能产生"全部核查完毕"的统计。
*/

import { collectUsedMaterials, coverageStats } from "./papers.js";
import type { MaterialIssue, PapersDoc, ReviewOutcome, UsedMaterial } from "./types.js";

export interface OutcomeContext {
  /** 当前输入修订的材料（含 label） */
  revisionMaterials: ReadonlyArray<{ doc_id: string; version: number; label: string; role: string }>;
  /** 当前仍影响结论的材料处理问题 */
  materialIssues: MaterialIssue[];
  /** 全部材料是否都**明确**不可读（failed/needs_ocr/超时；查询失败不算，v0.6 §4） */
  allMaterialsUnreadable?: boolean;
  /** 材料性不可读的版本集合（P1-3 复核）：file_issue 缺口仅当其文件属于该集合时
   * 才视为材料性证据；纯技术故障（索引写入失败等）不算用户缺材料 */
  materialUnreadableDocs?: ReadonlySet<string>;
}

/** 内部判定值：无可交付审核结果且无已证实的材料/事实缺口 → 交由运行时按 failed 处理。 */
export type DeterminedOutcome = ReviewOutcome | "no_valid_output";

/** insufficient 的证据必须是**结构性**的（v0.6 §4）：
 * 任务级缺口（非预算类）或指向具体材料用途的待核项（missing_role）。
 * 不再从 pending_reason 文本推断——技术性原因（预算/模型/存储/索引故障）与占位“待执行”
 * 一律不能推出用户缺材料。 */
export function determineOutcome(papers: PapersDoc, ctx: OutcomeContext): DeterminedOutcome {
  const stats = coverageStats(papers);
  const openGaps = stats.openTaskGaps;

  // complete：范围确定非空、适用项全核、其余不适用、且无遗留任务级缺口
  if (
    stats.scopeDetermined &&
    stats.total > 0 &&
    papers.scope !== null &&
    papers.scope.expected_item_ids.length > 0 &&
    papers.items.every((i) => i.status === "checked" || i.status === "not_applicable") &&
    openGaps.length === 0
  ) {
    return "complete";
  }
  if (stats.checked >= 1) return "partial";

  // 零已核：只有可明确指出的材料/事实缺口才交付 insufficient。
  // file_issue 需其文件确属材料性不可读（扫描件/不可重试失败）才算材料证据；
  // 已提交文件的纯技术故障（如索引写入失败）不算用户缺材料（P1-3 复核）。
  if (ctx.allMaterialsUnreadable) return "insufficient_materials";
  const materialUnreadable = ctx.materialUnreadableDocs ?? new Set<string>();
  const gapProofs = openGaps.filter((g) => {
    if (g.category === "budget") return false;
    if (g.category === "file_issue") {
      return g.doc_id !== undefined && g.version !== undefined
        ? materialUnreadable.has(`${g.doc_id}@${g.version}`)
        : false;
    }
    return true; // missing_material / missing_fact / route_undetermined 为结构性证据
  });
  if (gapProofs.length > 0) return "insufficient_materials";
  const missingRoleProofs = papers.items.filter((i) => i.status === "pending" && i.missing_role !== null);
  if (papers.items.length > 0 && missingRoleProofs.length > 0) return "insufficient_materials";

  // 空底稿 / 普通待执行 / 状态查询失败 / 仅技术原因：不能推出缺材料 → 无有效产出
  return "no_valid_output";
}

export interface ComposeInput {
  papers: PapersDoc;
  outcome: ReviewOutcome;
  ctx: OutcomeContext;
  /** 待核说明的补充（如预算耗尽时的未完成范围） */
  extraNotes?: string[];
}

/** 任务级缺口的正文行（v0.6 §4：全局缺口也进入正文；已解决的不列）。 */
function taskGapLines(papers: PapersDoc): string[] {
  return (papers.task_gaps ?? [])
    .filter((gap) => gap.resolved !== true)
    .map((gap) => {
      const label = gap.label ?? (gap.doc_id ? `${gap.doc_id}@v${gap.version ?? "?"}` : null) ?? (gap.missing_role ? `用途「${gap.missing_role}」` : null);
      const scope = label ? `（${label}）` : "";
      return `- ${gapCategoryText(gap.category)}${scope}：${gap.statement}。影响：${gap.impact}`;
    });
}

function gapCategoryText(category: string): string {
  switch (category) {
    case "missing_material":
      return "缺少材料";
    case "missing_fact":
      return "关键事实未确定";
    case "file_issue":
      return "材料处理问题";
    case "route_undetermined":
      return "专项规则待确定";
    case "budget":
      return "执行预算限制";
    default:
      return "缺口";
  }
}

export interface ComposedResult {
  conclusion_md: string;
  review_outcome: ReviewOutcome;
  used_materials: UsedMaterial[];
  stats: ReturnType<typeof coverageStats>;
}

export function composeConclusion(input: ComposeInput): ComposedResult {
  const { papers, outcome, ctx } = input;
  const stats = coverageStats(papers);
  const usedMaterials = collectUsedMaterials(papers, ctx.revisionMaterials);
  const sections: string[] = [];

  const findings = papers.items.filter((i) => i.status === "checked" && i.finding !== null);
  const pending = papers.items.filter((i) => i.status === "pending");
  const naItems = papers.items.filter((i) => i.status === "not_applicable");
  const allNotApplicable =
    stats.scopeDetermined && stats.applicable === 0 && naItems.length > 0 && findings.length === 0;

  // B2/P1-5：全部不适用是独立交付口径，仅在 complete（无未决缺口）时使用；
  // 其他覆盖值（如专项仍待确定）走通用组装，避免跳过缺口与材料问题。
  if (allNotApplicable && outcome === "complete") {
    sections.push("【结论】\n本次规则均不适用。已确认的规则卡各项均给出不适用理由，详见核查范围摘要。");
    // P1-5 复核：该分支同样输出材料处理说明——无关附件失败不影响完整交付，但必须进入正文
    if (ctx.materialIssues.length > 0) {
      sections.push(
        `【材料处理说明】\n${ctx.materialIssues
          .map((issue) => `- 「${issue.label}」${issue.issue}：${issue.impact}。该问题不影响本次核查范围的适用性判定。`)
          .join("\n")}`,
      );
    }
    sections.push(
      `【核查范围摘要】\n${scopeSummary(stats, naItems, usedMaterials)}\n- 逐项不适用理由：\n${naItems
        .map((i) => `  · ${i.item_id}（${i.rule_card}）：${i.not_applicable_reason}`)
        .join("\n")}`,
    );
    return {
      conclusion_md: sections.join("\n\n"),
      review_outcome: outcome,
      used_materials: usedMaterials,
      stats,
    };
  }

  sections.push(`【结论】\n${conclusionLine(papers, outcome, stats, ctx)}`);

  if (outcome === "insufficient_materials") {
    const gaps: string[] = [...taskGapLines(papers)];
    if (!stats.scopeDetermined && gaps.length === 0) {
      gaps.push("关键事实缺失，无法确定适用的审查规则（合同类型/条线无法判定）。");
    }
    for (const item of pending) {
      if (item.missing_role) gaps.push(`缺少${item.missing_role}：${item.pending_reason ?? "影响该项核查"}`);
      else if (item.pending_reason) gaps.push(`${item.rule_card}：${item.pending_reason}`);
    }
    for (const issue of ctx.materialIssues) {
      gaps.push(`材料「${issue.label}」${issue.issue}：${issue.impact}`);
    }
    sections.push(`【所需材料】\n${numbered(gaps.length > 0 ? gaps : ["无法确定具体缺口，请补充关键材料后重新提交。"])}`);
    if (pending.length > 0) sections.push(pendingSection(pending));
    sections.push(`【核查范围摘要】\n${scopeSummary(stats, naItems, usedMaterials)}`);
    return {
      conclusion_md: sections.join("\n\n"),
      review_outcome: outcome,
      used_materials: usedMaterials,
      stats,
    };
  }

  if (findings.length > 0) {
    const lines = findings.map((item, idx) => {
      const f = item.finding!;
      const parts: string[] = [];
      if (f.location) parts.push(f.location);
      parts.push(f.problem);
      const basis = f.basis ? `依据：${f.basis}。` : "";
      return `${idx + 1}. ${parts.join("，")}。${basis}建议：${f.suggestion}（${item.rule_card}）`;
    });
    sections.push(`【审核意见】\n${lines.join("\n")}`);
  } else if (outcome === "complete") {
    sections.push(
      `【审核意见】\n本次审核未发现问题。适用检查项均已核查，详见核查范围摘要。`,
    );
  } else {
    sections.push(`【审核意见】\n现有材料下未形成具体发现；未完成核查的事项见下节。`);
  }

  if (outcome === "partial") {
    sections.push(pendingSection(pending, ctx.materialIssues, papers));
  } else if (ctx.materialIssues.length > 0) {
    // v0.6 §4：无关附件失败也要在正文说明，且不影响完整交付
    sections.push(
      `【材料处理说明】\n${ctx.materialIssues
        .map((issue) => `- 「${issue.label}」${issue.issue}：${issue.impact}。该问题不影响本次已完成核查的范围。`)
        .join("\n")}`,
    );
  }

  if (input.extraNotes && input.extraNotes.length > 0) {
    sections.push(`【执行说明】\n${input.extraNotes.map((n) => `- ${n}`).join("\n")}`);
  }

  sections.push(`【核查范围摘要】\n${scopeSummary(stats, naItems, usedMaterials)}`);

  return {
    conclusion_md: sections.join("\n\n"),
    review_outcome: outcome,
    used_materials: usedMaterials,
    stats,
  };
}

/** 首句由覆盖值与缺口决定，再按相容性采纳模型提示（P1-5）：
 * conclusion_hint 只在 complete 时作为结论口径；partial/insufficient 一律用运行时口径，
 * 避免出现“拟同意。现有材料不足以开展实质审核”这类自相矛盾的首句。
 * “请补充材料”首句同样只认材料性证据：file_issue 须其文件属材料性不可读（P1-3 复核）。 */
function conclusionLine(
  papers: PapersDoc,
  outcome: ReviewOutcome,
  stats: ReturnType<typeof coverageStats>,
  ctx: OutcomeContext,
): string {
  const openGaps = stats.openTaskGaps;
  const materialUnreadable = ctx.materialUnreadableDocs ?? new Set<string>();
  const missingMaterialEvidence =
    openGaps.some(
      (g) =>
        g.category === "missing_material" ||
        (g.category === "file_issue" &&
          g.doc_id !== undefined &&
          g.version !== undefined &&
          materialUnreadable.has(`${g.doc_id}@${g.version}`)),
    ) || papers.items.some((i) => i.status === "pending" && i.missing_role !== null);

  if (outcome === "complete" && papers.conclusion_hint) {
    const suffix = stats.findings === 0 ? "本次审核未发现问题。" : "";
    return suffix ? `${papers.conclusion_hint}。${suffix}` : `${papers.conclusion_hint}。`;
  }
  switch (outcome) {
    case "complete":
      return stats.findings > 0
        ? `请修改后再提交。本次审核发现 ${stats.findings} 项问题，详见审核意见。`
        : "拟同意。本次审核未发现问题，核查范围见摘要。";
    case "partial":
      return missingMaterialEvidence
        ? "请补充材料后提交新任务。本次基于现有材料出具部分意见，未能核查的事项见下文。"
        : "本次基于现有进度交付部分意见，未完成的原因见下文（如需完整核查，可在补齐条件后提交新任务）。";
    case "insufficient_materials":
      return "无法开展实质审核。现有材料不足以支撑审查，所需材料见下文。";
  }
}

function pendingSection(
  pending: PapersDoc["items"],
  materialIssues: MaterialIssue[] = [],
  papers?: PapersDoc,
): string {
  const lines: string[] = [];
  for (const item of pending) {
    const reason = item.pending_reason ?? "待执行";
    lines.push(`- ${item.rule_card} / ${item.item_id}：${reason}${item.missing_role ? `（缺少${item.missing_role}）` : ""}`);
  }
  if (papers) {
    lines.push(...taskGapLines(papers));
  }
  for (const issue of materialIssues) {
    lines.push(`- 材料「${issue.label}」${issue.issue}：${issue.impact}`);
  }
  return `【未能核查的事项】\n${lines.length > 0 ? lines.join("\n") : "无"}`;
}

function scopeSummary(
  stats: ReturnType<typeof coverageStats>,
  naItems: PapersDoc["items"],
  usedMaterials: UsedMaterial[],
): string {
  const lines: string[] = [];
  if (stats.scopeDetermined) {
    lines.push(
      `- 审查范围：${stats.ruleCards.join("、")}；预期检查项 ${stats.expected} 项，已核查完成 ${stats.checked} 项，待核 ${stats.pending} 项，不适用 ${stats.notApplicable} 项。`,
    );
  } else {
    lines.push("- 审核路径未能确定，未建立预期检查项清单。");
  }
  if (naItems.length > 0) {
    lines.push(`- 不适用原因：${naItems.map((i) => `${i.item_id}（${i.not_applicable_reason}）`).join("；")}。`);
  }
  if (usedMaterials.length > 0) {
    lines.push(`- 本次实际使用材料：${usedMaterials.map((m) => `${m.label}（v${m.version}）`).join("、")}。`);
  } else {
    lines.push("- 本次未使用文件材料支撑核查。");
  }
  return lines.join("\n");
}

function numbered(lines: string[]): string {
  return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
}
