/** B1/B2 验收测试：活动范围固定与全部不适用成文。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { enforceActiveScope, validatePapers } from "../src/papers.js";
import { composeConclusion, determineOutcome } from "../src/outcome.js";

let baseDir: string;
let db: Db;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-test-"));
  db = new Db(path.join(baseDir, "agent.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

const materials = [{ doc_id: "d_01", version: 1, label: "主合同.docx", role: "主合同" }];

const item = (overrides: Record<string, unknown> = {}) => ({
  item_id: "a",
  rule_card: "C1",
  status: "checked",
  finding: null,
  used_materials: [],
  pending_reason: null,
  missing_role: null,
  not_applicable_reason: null,
  ...overrides,
});

describe("B1 活动范围固定", () => {
  it("首次确定路径时保存范围；同路由下缩减 expected（删除待核项）被拒绝", () => {
    const first = validatePapers(
      {
        scope: { rule_cards: ["C1"], expected_item_ids: ["a", "b"] },
        conclusion_hint: null,
        items: [
          item(),
          item({ item_id: "b", status: "pending", pending_reason: "待执行" }),
        ],
      },
      materials,
      null,
    );
    expect(first.ok).toBe(true);

    // 模拟 tools 层保存活动范围
    if (first.ok && first.papers.scope) {
      db.saveActiveScope("t1", 1, {
        rule_cards: first.papers.scope.rule_cards,
        expected_item_ids: first.papers.scope.expected_item_ids,
        reason: "initial",
      });
    }

    // 缩减分母：同步删除 b 与 expected —— 与已保存范围不一致且无理由 → 拒绝
    const shrunk = validatePapers(
      {
        scope: { rule_cards: ["C1"], expected_item_ids: ["a"] },
        conclusion_hint: null,
        items: [item()],
      },
      materials,
      db.getActiveScope("t1", 1),
    );
    expect(shrunk.ok).toBe(false);
    if (!shrunk.ok) expect(shrunk.errors.join()).toContain("不一致");

    // 同路由下缺项写入也被拒绝（items 缺 b）
    const missing = validatePapers(
      {
        scope: { rule_cards: ["C1"], expected_item_ids: ["a", "b"] },
        conclusion_hint: null,
        items: [item()],
      },
      materials,
      db.getActiveScope("t1", 1),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join()).toContain("缺失：b");
  });

  it("有依据的路由变化（scope_change_reason）允许并登记新范围", () => {
    db.saveActiveScope("t1", 1, { rule_cards: ["运维"], expected_item_ids: ["a"], reason: "initial" });
    const changed = validatePapers(
      {
        scope: { rule_cards: ["人员外包"], expected_item_ids: ["x", "y"] },
        scope_change_reason: "用户补充：本次按驻场人天结算，改用人员外包专项卡",
        conclusion_hint: null,
        items: [
          item({ item_id: "x", rule_card: "人员外包", status: "pending", pending_reason: "待执行" }),
          item({ item_id: "y", rule_card: "人员外包", status: "pending", pending_reason: "待执行" }),
        ],
      },
      materials,
      db.getActiveScope("t1", 1),
    );
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.scopeChanged).toBe(true);
  });

  it("enforceActiveScope：底稿缺失的预期项按待核兜底，complete 判定不成立", () => {
    const saved = { rule_cards: ["C1"], expected_item_ids: ["a", "b"], reason: "initial" };
    const papers = enforceActiveScope(
      {
        scope: { rule_cards: ["C1"], expected_item_ids: ["a", "b"] },
        conclusion_hint: null,
        items: [item()], // b 被意外丢弃
      },
      saved,
    );
    expect(papers.items).toHaveLength(2);
    expect(papers.items[1]!.status).toBe("pending");
    expect(
      determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] }),
    ).toBe("partial");
  });

  it("补件接纳把活动范围沿用到新修订", () => {
    db.saveActiveScope("t1", 1, { rule_cards: ["C1"], expected_item_ids: ["a"], reason: "initial" });
    db.carryScopeToRevision("t1", 1, 2);
    const carried = db.getActiveScope("t1", 2);
    expect(carried?.expected_item_ids).toEqual(["a"]);
    expect(carried?.reason).toContain("carried-from-r1");
  });
});

describe("v0.6 任务级缺口与无效产出判定", () => {
  it("存在 route_undetermined 缺口时不能判 complete（共性全核也不行）", () => {
    const papers = {
      scope: { rule_cards: ["C1 共性"], expected_item_ids: ["a"] },
      conclusion_hint: null,
      task_gaps: [
        { gap_id: "g1", category: "route_undetermined" as const, statement: "运维/外包无法判定", impact: "专项卡未执行" },
      ],
      items: [item()],
    };
    expect(determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] })).toBe("partial");
  });

  it("空底稿 / 普通待执行 → no_valid_output（不能推出缺材料）", () => {
    expect(
      determineOutcome(
        { scope: null, conclusion_hint: null, task_gaps: [], items: [] },
        { revisionMaterials: materials, materialIssues: [] },
      ),
    ).toBe("no_valid_output");
    expect(
      determineOutcome(
        {
          scope: { rule_cards: ["C1"], expected_item_ids: ["a"] },
          conclusion_hint: null,
          task_gaps: [],
          items: [item({ status: "pending", finding: null, pending_reason: "待执行" })],
        },
        { revisionMaterials: materials, materialIssues: [] },
      ),
    ).toBe("no_valid_output");
  });

  it("complete 交付时无关附件失败进入【材料处理说明】", () => {
    const papers = {
      scope: { rule_cards: ["C1"], expected_item_ids: ["a"] },
      conclusion_hint: null,
      task_gaps: [],
      items: [item()],
    };
    const issues = [
      { doc_id: "d_02", version: 1, label: "附件-报价单.pdf", issue: "解析失败", impact: "与任何适用项无关" },
    ];
    const composed = composeConclusion({
      papers,
      outcome: determineOutcome(papers, { revisionMaterials: materials, materialIssues: issues }) as "complete",
      ctx: { revisionMaterials: materials, materialIssues: issues },
    });
    expect(composed.review_outcome).toBe("complete");
    expect(composed.conclusion_md).toContain("【材料处理说明】");
    expect(composed.conclusion_md).toContain("附件-报价单.pdf");
    expect(composed.conclusion_md).toContain("不影响本次已完成核查的范围");
  });

  it("task_gaps 校验：非法 category / 缺 statement / 引用修订外版本均被拒", () => {
    const base = (gaps: unknown[]) => ({
      scope: { rule_cards: ["C1"], expected_item_ids: ["a"] },
      conclusion_hint: null,
      task_gaps: gaps,
      items: [item()],
    });
    expect(validatePapers(base([{ gap_id: "g1", category: "whatever", statement: "x", impact: "y" }]), materials, null).ok).toBe(false);
    expect(validatePapers(base([{ gap_id: "g1", category: "missing_fact", impact: "y" }]), materials, null).ok).toBe(false);
    expect(
      validatePapers(base([{ gap_id: "g1", category: "file_issue", statement: "x", impact: "y", doc_id: "d_99", version: 9 }]), materials, null).ok,
    ).toBe(false);
  });
});

describe("B2 全部不适用", () => {
  it("全部不适用 → complete，结论写“本次规则均不适用”，逐项理由列出；hint 不覆盖", () => {
    const papers = {
      scope: { rule_cards: ["C1", "C2"], expected_item_ids: ["a", "b"] },
      conclusion_hint: "拟同意" as const,
      task_gaps: [],
      items: [
        item({ item_id: "a", status: "not_applicable", not_applicable_reason: "本合同不涉及保密条款" }),
        item({ item_id: "b", status: "not_applicable", not_applicable_reason: "不涉及知识产权归属" }),
      ],
    };
    const outcome = determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] });
    expect(outcome).toBe("complete");
    const composed = composeConclusion({
      papers,
      outcome,
      ctx: { revisionMaterials: materials, materialIssues: [] },
    });
    expect(composed.conclusion_md).toContain("本次规则均不适用");
    expect(composed.conclusion_md).toContain("逐项不适用理由");
    expect(composed.conclusion_md).toContain("不涉及保密条款");
    // 模型的“拟同意”提示不能作为结论行出现（运行时口径优先）
    expect(composed.conclusion_md.split("\n")[0]).not.toContain("拟同意");
  });

  it("适用项全核无发现 → “本次审核未发现问题”分支不受影响", () => {
    const papers = {
      scope: { rule_cards: ["C1"], expected_item_ids: ["a"] },
      conclusion_hint: null,
      task_gaps: [],
      items: [item()],
    };
    const composed = composeConclusion({
      papers,
      outcome: determineOutcome(papers, { revisionMaterials: materials, materialIssues: [] }),
      ctx: { revisionMaterials: materials, materialIssues: [] },
    });
    expect(composed.conclusion_md).toContain("本次审核未发现问题");
  });
});
