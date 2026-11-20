import { describe, expect, it } from "vitest";
import { composeConclusion, determineOutcome } from "../src/outcome.js";
import type { MaterialIssue, PapersDoc } from "../src/types.js";

const materials = [
  { doc_id: "d_01", version: 1, label: "主合同.docx", role: "主合同" },
  { doc_id: "d_02", version: 1, label: "采购纪要.docx", role: "纪要" },
];

const item = (overrides: Record<string, unknown> = {}) => ({
  item_id: "item-1",
  rule_card: "C6 付款与发票",
  status: "checked",
  finding: {
    problem: "付款条件使用“验收完成”，但合同未明确验收通过的标准和确认人。",
    suggestion: "建议补充验收标准与确认流程。",
  },
  used_materials: [{ doc_id: "d_01", version: 1 }],
  pending_reason: null,
  missing_role: null,
  not_applicable_reason: null,
  ...overrides,
});

describe("determineOutcome", () => {
  it("全部适用项已核 → complete", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6"], expected_item_ids: ["item-1"] },
      conclusion_hint: null,
      items: [item()],
    };
    expect(determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] })).toBe("complete");
  });

  it("存在待核 → partial（即使有已核项）", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6"], expected_item_ids: ["item-1", "item-2"] },
      conclusion_hint: null,
      items: [
        item(),
        item({ item_id: "item-2", status: "pending", finding: null, pending_reason: "纪要解析失败，金额一致性未核", missing_role: "纪要", used_materials: [] }),
      ],
    };
    expect(determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] })).toBe("partial");
  });

  it("主合同不可读、无任何已核 → insufficient_materials", () => {
    const papers: PapersDoc = { scope: null, conclusion_hint: null, items: [] };
    expect(
      determineOutcome(papers, {
        revisionMaterials: materials,
        materialIssues: [{ doc_id: "d_01", version: 1, label: "主合同.docx", issue: "解析失败", impact: "-" }],
        allMaterialsUnreadable: true,
      }),
    ).toBe("insufficient_materials");
  });

  it("路径未确定且无已核 → insufficient_materials", () => {
    const papers: PapersDoc = {
      scope: null,
      conclusion_hint: null,
      task_gaps: [],
      items: [item({ status: "pending", finding: null, pending_reason: "合同类型无法判定，无法确定适用规则" })],
    };
    expect(determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] })).toBe("insufficient_materials");
  });

  it("全部不适用且各有理由 → complete", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6"], expected_item_ids: ["item-1"] },
      conclusion_hint: null,
      items: [item({ status: "not_applicable", finding: null, not_applicable_reason: "本合同不涉及付款环节" })],
    };
    expect(determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] })).toBe("complete");
  });
});

describe("composeConclusion", () => {
  it("partial：交付发现 + 未能核查事项 + 范围摘要", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6 付款"], expected_item_ids: ["item-1", "item-2"] },
      conclusion_hint: null,
      items: [
        item(),
        item({ item_id: "item-2", status: "pending", finding: null, pending_reason: "采购纪要解析失败，金额一致性未核", used_materials: [] }),
      ],
    };
    const composed = composeConclusion({
      papers,
      outcome: "partial",
      ctx: { revisionMaterials: materials, materialIssues: [] },
    });
    expect(composed.conclusion_md).toContain("【结论】");
    expect(composed.conclusion_md).toContain("【审核意见】");
    expect(composed.conclusion_md).toContain("验收完成");
    expect(composed.conclusion_md).toContain("【未能核查的事项】");
    expect(composed.conclusion_md).toContain("纪要");
    expect(composed.conclusion_md).toContain("【核查范围摘要】");
    expect(composed.used_materials).toEqual([{ doc_id: "d_01", version: 1, label: "主合同.docx" }]);
    expect(composed.review_outcome).toBe("partial");
  });

  it("complete 且无发现：必须写明“未发现问题”并附范围摘要", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6"], expected_item_ids: ["item-1"] },
      conclusion_hint: null,
      items: [item({ finding: null, used_materials: [{ doc_id: "d_01", version: 1 }] })],
    };
    const composed = composeConclusion({
      papers,
      outcome: "complete",
      ctx: { revisionMaterials: materials, materialIssues: [] },
    });
    expect(composed.conclusion_md).toContain("本次审核未发现问题");
    expect(composed.conclusion_md).toContain("预期检查项 1 项");
    expect(composed.conclusion_md).toContain("不适用 0 项");
  });

  it("insufficient：列出缺口与所需材料", () => {
    const papers: PapersDoc = {
      scope: null,
      conclusion_hint: null,
      items: [],
    };
    const issues: MaterialIssue[] = [
      { doc_id: "d_01", version: 1, label: "主合同.docx", issue: "疑似扫描件", impact: "无法开展实质审核" },
    ];
    const composed = composeConclusion({
      papers,
      outcome: "insufficient_materials",
      ctx: { revisionMaterials: materials, materialIssues: issues, allMaterialsUnreadable: true },
    });
    expect(composed.conclusion_md).toContain("【所需材料】");
    expect(composed.conclusion_md).toContain("主合同.docx");
    expect(composed.conclusion_md).toContain("扫描件");
  });

  it("conclusion_hint 优先于推导口径", () => {
    const papers: PapersDoc = {
      scope: { rule_cards: ["C6"], expected_item_ids: ["item-1"] },
      conclusion_hint: "拟同意",
      items: [item({ finding: null })],
    };
    const composed = composeConclusion({
      papers,
      outcome: "complete",
      ctx: { revisionMaterials: materials, materialIssues: [] },
    });
    expect(composed.conclusion_md).toContain("拟同意");
  });
});
