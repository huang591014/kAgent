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
  /** 全部材料是否都不可读（主合同级别缺失时进入 insufficient） */
  allMaterialsUnreadable?: boolean;
}

export function determineOutcome(papers: PapersDoc, ctx: OutcomeContext): ReviewOutcome {
  const stats = coverageStats(papers);
  if (
    stats.scopeDetermined &&
    stats.total > 0 &&
    papers.scope !== null &&
    papers.scope.expected_item_ids.length > 0 &&
    papers.items.every((i) => i.status !== "pending") &&
    papers.items.every((i) => i.status === "checked" || i.status === "not_applicable")
  ) {
    return "complete";
  }
  if (stats.checked >= 1) return "partial";
  // 没有任何已核项：
  if (ctx.allMaterialsUnreadable) return "insufficient_materials";
  const blockingByMaterials = papers.items.every(
    (i) => i.status === "pending" && (i.missing_role !== null || i.pending_reason !== null),
  );
  if (!stats.scopeDetermined && stats.checked === 0) return "insufficient_materials";
  if (papers.items.length === 0) return "insufficient_materials";
  if (blockingByMaterials) return "insufficient_materials";
  return "partial";
}

export interface ComposeInput {
  papers: PapersDoc;
  outcome: ReviewOutcome;
  ctx: OutcomeContext;
  /** 待核说明的补充（如预算耗尽时的未完成范围） */
  extraNotes?: string[];
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

  sections.push(`【结论】\n${conclusionLine(papers, outcome, stats)}`);

  if (outcome === "insufficient_materials") {
    const gaps: string[] = [];
    if (!stats.scopeDetermined) {
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
    sections.push(pendingSection(pending, ctx.materialIssues));
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

function conclusionLine(papers: PapersDoc, outcome: ReviewOutcome, stats: ReturnType<typeof coverageStats>): string {
  if (papers.conclusion_hint) {
    const suffix =
      outcome === "complete" && stats.findings === 0
        ? "本次审核未发现问题。"
        : outcome === "partial"
          ? "本次基于现有材料出具部分意见。"
          : outcome === "insufficient_materials"
            ? "现有材料不足以开展实质审核。"
            : "";
    return suffix ? `${papers.conclusion_hint}。${suffix}` : `${papers.conclusion_hint}。`;
  }
  switch (outcome) {
    case "complete":
      return stats.findings > 0
        ? `请修改后再提交。本次审核发现 ${stats.findings} 项问题，详见审核意见。`
        : "拟同意。本次审核未发现问题，核查范围见摘要。";
    case "partial":
      return "请补充材料后再提交。本次基于现有材料出具部分意见，未能核查的事项见下文。";
    case "insufficient_materials":
      return "无法开展实质审核。现有材料不足以支撑审查，所需材料见下文。";
  }
}

function pendingSection(pending: PapersDoc["items"], materialIssues: MaterialIssue[] = []): string {
  const lines: string[] = [];
  for (const item of pending) {
    const reason = item.pending_reason ?? "待执行";
    lines.push(`- ${item.rule_card} / ${item.item_id}：${reason}${item.missing_role ? `（缺少${item.missing_role}）` : ""}`);
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
