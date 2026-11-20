import { describe, expect, it } from "vitest";
import { collectUsedMaterials, coverageStats, invalidateForReplace, validatePapers } from "../src/papers.js";

const materials = [
  { doc_id: "d_01", version: 1, label: "主合同.docx", role: "主合同" },
  { doc_id: "d_02", version: 2, label: "采购纪要.docx", role: "纪要" },
];

const validItem = (overrides: Partial<import("../src/types.js").PaperItem> = {}): import("../src/types.js").PaperItem => ({
  item_id: "c6-payment",
  rule_card: "C6 付款与发票",
  status: "checked",
  finding: {
    problem: "合同以验收完成作为付款条件，但未约定验收通过标准。",
    suggestion: "请在验收条款中补充通过标准和确认流程。",
  },
  used_materials: [{ doc_id: "d_01", version: 1 }],
  pending_reason: null,
  missing_role: null,
  not_applicable_reason: null,
  ...overrides,
});

describe("validatePapers", () => {
  it("接受合法底稿", () => {
    const result = validatePapers(
      {
        scope: { rule_cards: ["C1-C14 共性"], expected_item_ids: ["c6-payment"] },
        items: [validItem()],
        conclusion_hint: null,
      },
      materials,
    );
    expect(result.ok).toBe(true);
  });

  it("拒绝损坏 JSON 形态与缺字段", () => {
    expect(validatePapers("nope" as unknown, materials).ok).toBe(false);
    expect(validatePapers({}, materials).ok).toBe(false);
    expect(validatePapers({ items: "x" }, materials).ok).toBe(false);
    const missingReason = validatePapers(
      { items: [{ ...validItem(), status: "pending", finding: null }] },
      materials,
    );
    expect(missingReason.ok).toBe(false);
    if (!missingReason.ok) expect(missingReason.errors.join()).toContain("pending_reason");
  });

  it("状态与字段匹配校验", () => {
    const checkedWithPendingReason = validatePapers(
      { items: [validItem({ pending_reason: "缺纪要" })] },
      materials,
    );
    expect(checkedWithPendingReason.ok).toBe(false);

    const pendingWithFinding = validatePapers(
      { items: [validItem({ status: "pending", pending_reason: "待执行" })] },
      materials,
    );
    expect(pendingWithFinding.ok).toBe(false);

    const naNoReason = validatePapers(
      { items: [validItem({ status: "not_applicable", finding: null })] },
      materials,
    );
    expect(naNoReason.ok).toBe(false);
  });

  it("finding 必须包含 problem 与 suggestion", () => {
    const bad = validatePapers(
      { items: [validItem({ finding: { problem: "只有问题" } as never })] } as never,
      materials,
    );
    expect(bad.ok).toBe(false);
  });

  it("used_materials 必须属于当前修订（补件替换后旧版本失效）", () => {
    const stale = validatePapers(
      { items: [validItem({ used_materials: [{ doc_id: "d_02", version: 1 }] })] },
      materials,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errors.join()).toContain("当前修订之外");
  });

  it("scope 登记后预期项必须完整且不允许意外项", () => {
    const incomplete = validatePapers(
      {
        scope: { rule_cards: ["共性"], expected_item_ids: ["a", "b"] },
        items: [validItem({ item_id: "a" })],
      },
      materials,
    );
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.errors.join()).toContain("缺失：b");

    const extra = validatePapers(
      {
        scope: { rule_cards: ["共性"], expected_item_ids: ["a"] },
        items: [validItem({ item_id: "a" }), validItem({ item_id: "b" })],
      },
      materials,
    );
    expect(extra.ok).toBe(false);
  });

  it("item_id 重复被拒绝", () => {
    const dup = validatePapers(
      { items: [validItem(), validItem()] },
      materials,
    );
    expect(dup.ok).toBe(false);
  });
});

describe("coverageStats", () => {
  it("统计已核/待核/不适用与发现数", () => {
    const stats = coverageStats({
      scope: { rule_cards: ["共性"], expected_item_ids: ["a", "b", "c"] },
       task_gaps: [],
      conclusion_hint: null,
      items: [
        validItem({ item_id: "a" }),
        validItem({ item_id: "b", status: "pending", finding: null, pending_reason: "待执行", used_materials: [] }),
        validItem({ item_id: "c", status: "not_applicable", finding: null, not_applicable_reason: "不涉密", used_materials: [] }),
      ],
    });
    expect(stats.checked).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.notApplicable).toBe(1);
    expect(stats.findings).toBe(1);
    expect(stats.applicable).toBe(2);
    expect(stats.scopeDetermined).toBe(true);
  });
});

describe("invalidateForReplace", () => {
  it("引用旧版本的意见标为待复核且清掉 finding", () => {
    const papers = {
      scope: { rule_cards: ["共性"], expected_item_ids: ["a", "b"] },
       task_gaps: [],
      conclusion_hint: null,
      items: [
        validItem({ item_id: "a", used_materials: [{ doc_id: "d_01", version: 1 }] }),
        validItem({ item_id: "b", used_materials: [{ doc_id: "d_02", version: 2 }] }),
      ],
    };
    const next = invalidateForReplace(papers, { doc_id: "d_01", version: 1 }, "原版本已被替换");
    expect(next.items[0]!.status).toBe("pending");
    expect(next.items[0]!.finding).toBeNull();
    expect(next.items[0]!.pending_reason).toContain("替换");
    expect(next.items[0]!.used_materials).toHaveLength(0);
    expect(next.items[1]!.status).toBe("checked");
  });
});

describe("collectUsedMaterials", () => {
  it("按 doc+version 去重并取当前修订的 label", () => {
    const used = collectUsedMaterials(
      {
        scope: null,
         task_gaps: [],
        conclusion_hint: null,
        items: [
          validItem({ item_id: "a", used_materials: [{ doc_id: "d_01", version: 1 }, { doc_id: "d_02", version: 2 }] }),
          validItem({ item_id: "b", used_materials: [{ doc_id: "d_01", version: 1 }] }),
          validItem({ item_id: "c", status: "pending", finding: null, pending_reason: "x", used_materials: [{ doc_id: "d_02", version: 2 }] }),
        ],
      },
      materials,
    );
    expect(used).toEqual([
      { doc_id: "d_01", version: 1, label: "主合同.docx" },
      { doc_id: "d_02", version: 2, label: "采购纪要.docx" },
    ]);
  });
});
