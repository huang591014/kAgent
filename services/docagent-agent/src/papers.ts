/** working-papers.json：校验、覆盖统计与依赖失效（设计 §4.3）。

工具提交底稿前检查：完整 JSON、预期项 ID 的唯一性与完整性、
字段与状态匹配、材料版本属于当前任务修订。校验失败保留上一份有效快照。
*/

import type { PaperItem, PapersDoc, PaperItemStatus } from "./types.js";

export interface RevisionMaterialRef {
  doc_id: string;
  version: number;
}

export type PapersValidation =
  | { ok: true; papers: PapersDoc }
  | { ok: false; errors: string[] };

const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONCLUSION_HINTS = [
  "拟同意",
  "请修改后再提交",
  "请补充材料后再提交",
  "建议退回补正",
];

export function validatePapers(input: unknown, revisionMaterials: readonly RevisionMaterialRef[]): PapersValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["底稿必须是 JSON 对象"] };
  }
  const raw = input as Record<string, unknown>;

  const items = raw.items;
  if (!Array.isArray(items)) return { ok: false, errors: ["缺少 items 数组"] };

  // scope（确定路径后登记）
  let scope: PapersDoc["scope"] = null;
  if (raw.scope !== null && raw.scope !== undefined) {
    const s = raw.scope as Record<string, unknown>;
    const ruleCards = s.rule_cards;
    const expected = s.expected_item_ids;
    if (!Array.isArray(ruleCards) || ruleCards.length === 0 || ruleCards.some((c) => typeof c !== "string" || !c)) {
      errors.push("scope.rule_cards 必须是非空字符串数组");
    }
    if (!Array.isArray(expected) || expected.some((id) => typeof id !== "string")) {
      errors.push("scope.expected_item_ids 必须是字符串数组");
    } else {
      const seen = new Set<string>();
      for (const id of expected as string[]) {
        if (seen.has(id)) errors.push(`expected_item_ids 重复：${id}`);
        seen.add(id);
      }
      scope = { rule_cards: (ruleCards as string[]) ?? [], expected_item_ids: expected as string[] };
    }
  }

  const knownMaterialKeys = new Set(revisionMaterials.map((m) => `${m.doc_id}@${m.version}`));

  const parsedItems: PaperItem[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of (items as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`items[${index}] 不是对象`);
      continue;
    }
    const it = entry as Record<string, unknown>;
    const itemId = it.item_id;
    if (typeof itemId !== "string" || !ITEM_ID_RE.test(itemId)) {
      errors.push(`items[${index}].item_id 不合法：${String(itemId)}`);
      continue;
    }
    if (seenIds.has(itemId)) errors.push(`item_id 重复：${itemId}`);
    seenIds.add(itemId);

    const status = it.status as PaperItemStatus;
    if (status !== "checked" && status !== "pending" && status !== "not_applicable") {
      errors.push(`${itemId}.status 必须是 checked / pending / not_applicable`);
      continue;
    }
    if (typeof it.rule_card !== "string" || !it.rule_card) {
      errors.push(`${itemId}.rule_card 缺失`);
    }

    // finding 校验（按状态）
    let finding: PaperItem["finding"] = null;
    const f = it.finding;
    if (f !== null && f !== undefined) {
      if (typeof f !== "object") {
        errors.push(`${itemId}.finding 必须是对象或 null`);
      } else {
        const problem = (f as Record<string, unknown>).problem;
        const suggestion = (f as Record<string, unknown>).suggestion;
        if (typeof problem !== "string" || !problem.trim()) errors.push(`${itemId}.finding.problem 缺失`);
        if (typeof suggestion !== "string" || !suggestion.trim()) errors.push(`${itemId}.finding.suggestion 缺失`);
        finding = {
          problem: String(problem ?? ""),
          suggestion: String(suggestion ?? ""),
          location: optionalString((f as Record<string, unknown>).location) ?? undefined,
          basis: optionalString((f as Record<string, unknown>).basis) ?? undefined,
        };
      }
    }

    const pendingReason = optionalString(it.pending_reason);
    const missingRole = optionalString(it.missing_role);
    const naReason = optionalString(it.not_applicable_reason);

    if (status === "checked") {
      if (pendingReason) errors.push(`${itemId} 为 checked，不能填 pending_reason`);
      if (missingRole) errors.push(`${itemId} 为 checked，不能填 missing_role`);
      if (naReason) errors.push(`${itemId} 为 checked，不能填 not_applicable_reason`);
    } else if (status === "pending") {
      if (finding) errors.push(`${itemId} 为 pending，不能填 finding`);
      if (naReason) errors.push(`${itemId} 为 pending，不能填 not_applicable_reason`);
      if (!pendingReason) errors.push(`${itemId} 为 pending，必须填写 pending_reason`);
    } else {
      if (finding) errors.push(`${itemId} 为 not_applicable，不能填 finding`);
      if (pendingReason) errors.push(`${itemId} 为 not_applicable，不能填 pending_reason`);
      if (missingRole) errors.push(`${itemId} 为 not_applicable，不能填 missing_role`);
      if (!naReason) errors.push(`${itemId} 为 not_applicable，必须填写 not_applicable_reason`);
    }

    // used_materials 校验：属于当前修订
    const used: PaperItem["used_materials"] = [];
    const um = it.used_materials;
    if (um !== null && um !== undefined) {
      if (!Array.isArray(um)) {
        errors.push(`${itemId}.used_materials 必须是数组`);
      } else {
        for (const ref of um) {
          const r = ref as Record<string, unknown>;
          if (typeof r.doc_id !== "string" || typeof r.version !== "number") {
            errors.push(`${itemId}.used_materials 条目格式不合法`);
            continue;
          }
          if (!knownMaterialKeys.has(`${r.doc_id}@${r.version}`)) {
            errors.push(`${itemId}.used_materials 引用了当前修订之外的材料版本：${r.doc_id}@${r.version}`);
            continue;
          }
          used.push({ doc_id: r.doc_id, version: r.version });
        }
      }
    }
    if (status === "checked" && used.length === 0 && revisionMaterials.length > 0) {
      // 允许仅基于补充文字的检查（无文件依赖），不视为错误
    }

    parsedItems.push({
      item_id: itemId,
      rule_card: String(it.rule_card ?? ""),
      status,
      finding,
      used_materials: used,
      pending_reason: pendingReason,
      missing_role: missingRole,
      not_applicable_reason: naReason,
    });
  }

  // 预期项完整性：scope 登记后，每个 expected id 必须有对应 item，不允许意外项
  if (scope) {
    for (const id of scope.expected_item_ids) {
      if (!seenIds.has(id)) errors.push(`预期检查项缺失：${id}`);
    }
    for (const id of seenIds) {
      if (!scope.expected_item_ids.includes(id)) errors.push(`存在预期清单之外的检查项：${id}`);
    }
  }

  let conclusionHint: string | null = null;
  if (raw.conclusion_hint !== null && raw.conclusion_hint !== undefined) {
    if (typeof raw.conclusion_hint !== "string" || !CONCLUSION_HINTS.includes(raw.conclusion_hint)) {
      errors.push(`conclusion_hint 必须是 ${CONCLUSION_HINTS.join(" / ")} 之一`);
    } else {
      conclusionHint = raw.conclusion_hint;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    papers: { scope, items: parsedItems, conclusion_hint: conclusionHint },
  };
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CoverageStats {
  scopeDetermined: boolean;
  ruleCards: string[];
  expected: number;
  total: number;
  checked: number;
  pending: number;
  notApplicable: number;
  findings: number;
  applicable: number; // expected - notApplicable
}

export function coverageStats(papers: PapersDoc): CoverageStats {
  const checked = papers.items.filter((i) => i.status === "checked");
  const na = papers.items.filter((i) => i.status === "not_applicable");
  const pending = papers.items.filter((i) => i.status === "pending");
  const expected = papers.scope?.expected_item_ids.length ?? papers.items.length;
  return {
    scopeDetermined: papers.scope !== null && papers.scope.expected_item_ids.length > 0,
    ruleCards: papers.scope?.rule_cards ?? [],
    expected,
    total: papers.items.length,
    checked: checked.length,
    pending: pending.length,
    notApplicable: na.length,
    findings: checked.filter((i) => i.finding !== null).length,
    applicable: Math.max(0, expected - na.length),
  };
}

/** 替换材料：把引用旧版本的意见标为待复核（设计 §4.2 替换文件）。 */
export function invalidateForReplace(
  papers: PapersDoc,
  oldDoc: { doc_id: string; version: number },
  reason: string,
): PapersDoc {
  return {
    ...papers,
    items: papers.items.map((item) => {
      const used = item.used_materials.some((m) => m.doc_id === oldDoc.doc_id && m.version === oldDoc.version);
      if (!used) return item;
      return {
        ...item,
        status: "pending",
        finding: null,
        pending_reason: reason,
        used_materials: item.used_materials.filter(
          (m) => !(m.doc_id === oldDoc.doc_id && m.version === oldDoc.version),
        ),
      };
    }),
  };
}

/** 汇总实际使用的材料（设计 §5：按 doc+version 去重、仅计当前修订仍存在的）。 */
export function collectUsedMaterials(
  papers: PapersDoc,
  revisionMaterials: ReadonlyArray<RevisionMaterialRef & { label: string }>,
): Array<{ doc_id: string; version: number; label: string }> {
  const used = new Map<string, { doc_id: string; version: number; label: string }>();
  const byKey = new Map(revisionMaterials.map((m) => [`${m.doc_id}@${m.version}`, m]));
  for (const item of papers.items) {
    if (item.status !== "checked") continue;
    for (const ref of item.used_materials) {
      const key = `${ref.doc_id}@${ref.version}`;
      if (!byKey.has(key) || used.has(key)) continue;
      used.set(key, { doc_id: ref.doc_id, version: ref.version, label: byKey.get(key)!.label });
    }
  }
  return [...used.values()];
}
