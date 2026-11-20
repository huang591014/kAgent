/** 工具集：schema 定义与执行分发（v0.6 §2：单次提交的工具表）。

- skill / list_dir / read_file：skill 包只读资源（路径约束在版本资源根内）
- write_file / edit_file：仅写任务工作区；working-papers.json 写前校验（含 task_gaps）
- doc_status / doc_outline：经 pipeline 查询（属主身份）
- mcp__doc_retrieval__doc_search / doc_read：进程内 OpenSearch 检索
工具结果与调用按原 ID 配对（参考 message-history.ts 的配对纪律）。
*/

import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { Db, TaskRow } from "../db.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OpenSearchRetrieval } from "../opensearch.js";
import { pipeline } from "../pipelineClient.js";
import { validatePapers, type ActiveScope } from "../papers.js";
import type { PapersDoc } from "../types.js";
import { listPackageFiles, loadSkillBody } from "../skills/loader.js";

export const WORKING_PAPERS_PATH = "working-papers.json";

// ===== 输入 schema =====

export const toolSchemas = {
  skill: tool({
    description:
      "加载当前任务绑定的 skill 正文（SKILL.md）。返回技能说明与资源根目录；包内 references/ 等资源用 list_dir / read_file 按相对路径读取。无需参数。",
    inputSchema: z.object({}),
  }),
  list_dir: tool({
    description:
      "列举 skill 包资源目录（如 references/、references/clauses/）或任务工作区。dir 为 skill 资源根的相对路径；workspace=true 时列任务工作区文件。",
    inputSchema: z.object({
      dir: z.string().default(".").describe("相对资源根的目录路径"),
      workspace: z.boolean().default(false).describe("true 时列举任务工作区"),
    }),
  }),
  read_file: tool({
    description:
      "分页读取 skill 包内文本资源（offset/limit 为字符数），或读取任务工作区文件（workspace=true）。",
    inputSchema: z.object({
      path: z.string().describe("相对路径；工作区文件用 workspace=true"),
      workspace: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100_000).default(20_000),
    }),
  }),
  write_file: tool({
    description:
      `写入任务工作区文件。写 ${WORKING_PAPERS_PATH} 时将执行底稿校验（预期项完整性、状态与字段匹配、材料版本归属），失败则拒绝并保留上一份有效快照。`,
    inputSchema: z.object({
      path: z.string().describe("工作区内相对路径"),
      content: z.string(),
    }),
  }),
  edit_file: tool({
    description:
      "对任务工作区文件做精确替换（old_text 必须唯一命中；replace_all 控制全部替换）。写底稿同样执行校验。",
    inputSchema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().default(false),
    }),
  }),
  doc_status: tool({
    description: "查询本任务绑定材料的状态：处理阶段、是否就绪、解析缺口、失败原因。",
    inputSchema: z.object({ doc_id: z.string().optional() }),
  }),
  doc_outline: tool({
    description: "获取指定材料的文档顺序（块目录）与通读起点 block_id。",
    inputSchema: z.object({
      doc_id: z.string(),
      version: z.number().int().min(1).optional(),
    }),
  }),
  "mcp__doc_retrieval__doc_search": tool({
    description:
      "在授权材料版本内全文检索。返回片段（约 200 字）与块标识。默认 top-k 10。doc_ids 可限定材料子集。",
    inputSchema: z.object({
      query: z.string().min(1),
      doc_ids: z.array(z.string()).optional(),
      top_k: z.number().int().min(1).max(25).default(10),
    }),
  }),
  "mcp__doc_retrieval__doc_read": tool({
    description:
      "按块标识回读，或沿游标顺序读取（保留表格表头与行序）。返回 blocks、next_cursor、eof、coverage_gaps。",
    inputSchema: z.object({
      doc_id: z.string(),
      version: z.number().int().min(1).optional(),
      block_id: z.string().optional(),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(10).default(3),
    }),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

// ===== 执行上下文 =====

export interface ToolContext {
  db: Db;
  task: TaskRow;
  materials: Array<{ doc_id: string; version: number; role: string; label: string }>;
  identity: { tenant_id: string; user_id: string; admin?: boolean };
  skills: SkillRegistry;
  retrieval: OpenSearchRetrieval;
  /** 每份材料的最新处理状态缓存（runner 在启动/恢复时刷新） */
  docStatusCache: Map<string, { status: string; ready: boolean; needs_ocr: boolean; error: unknown; parse_gaps: Array<{ page: number; reason: string }> }>;
  /** 当前底稿（从工作区读取的权威副本） */
  papers: PapersDoc;
  /** 运行时保存的活动范围（B1）；写底稿时核对，路由变化需 scope_change_reason */
  activeScope: ActiveScope | null;
  /** 运行时凭据（P1-1）：skill 成功加载过、实际成功读到过的材料版本。
   * 恢复执行时从检查点重建，发布前据此拒绝依据不足的实质意见。 */
  evidence: { skillLoaded: boolean; readDocs: Set<string> };
}

export interface ToolOutcome {
  output: unknown;
  isError: boolean;
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "skill":
        return ok(runSkill(ctx));
      case "list_dir":
        return ok(runListDir(String(args.dir ?? "."), args.workspace === true, ctx));
      case "read_file":
        return ok(
          await runReadFile(
            String(args.path ?? ""),
            args.workspace === true,
            Number(args.offset ?? 0),
            Number(args.limit ?? 20_000),
            ctx,
          ),
        );
      case "write_file":
        return runWriteFile(String(args.path ?? ""), String(args.content ?? ""), ctx);
      case "edit_file":
        return runEditFile(args, ctx);
      case "doc_status":
        return ok(runDocStatus(args.doc_id ? String(args.doc_id) : undefined, ctx));
      case "doc_outline":
        return ok(await runDocOutline(String(args.doc_id ?? ""), args.version ? Number(args.version) : undefined, ctx));
      case "mcp__doc_retrieval__doc_search":
        return ok(await runDocSearch(args, ctx));
      case "mcp__doc_retrieval__doc_read":
        return ok(await runDocRead(args, ctx));
      default:
        return err(`未知工具：${name}`);
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

// ===== 各工具实现 =====

function runSkill(ctx: ToolContext) {
  const body = ctx.skills.bodyFor(ctx.task.skill_ref);
  ctx.evidence.skillLoaded = true; // P1-1：成功加载计入运行时凭据
  return {
    skill_ref: ctx.task.skill_ref,
    base_directory: body.baseDirectory,
    note: `skill 正文已加载。包内相对路径资源用 list_dir / read_file 读取；正文超长时已截断。`,
    content: body.content,
    truncated: body.truncated,
  };
}

function runListDir(dir: string, workspace: boolean, ctx: ToolContext) {
  if (workspace) {
    return { workspace: true, files: ctx.db.listFiles(ctx.task.task_id) };
  }
  const root = ctx.skills.rootFor(ctx.task.skill_ref);
  return { base_directory: root, dir, entries: listPackageFiles(root, dir) };
}

async function runReadFile(filePath: string, workspace: boolean, offset: number, limit: number, ctx: ToolContext) {
  if (workspace) {
    const file = ctx.db.getFile(ctx.task.task_id, filePath);
    if (!file) return { error: `工作区文件不存在：${filePath}` };
    const total = file.content.length;
    const text = file.content.slice(offset, offset + limit);
    return { path: filePath, text, offset, total, truncated: offset + text.length < total };
  }
  if (filePath === "SKILL.md") {
    const body = ctx.skills.bodyFor(ctx.task.skill_ref);
    const text = body.content.slice(offset, offset + limit);
    return {
      path: filePath,
      text,
      offset,
      total: body.content.length,
      truncated: offset + text.length < body.content.length,
    };
  }
  return ctx.skills.textFor(ctx.task.skill_ref, filePath, { offset, limit });
}

function runWriteFile(filePath: string, content: string, ctx: ToolContext): ToolOutcome {
  const normalized = normalizeWorkspacePath(filePath);
  if (normalized === null) return err("工作区路径不合法（仅允许相对路径，禁止 ..）");
  if (normalized === WORKING_PAPERS_PATH) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      return err(`底稿不是合法 JSON：${(error as Error).message}。上一份有效快照已保留，请修正后重写。`);
    }
    const validation = validatePapers(parsed, ctx.materials, ctx.activeScope, ctx.papers.task_gaps ?? []);
    if (!validation.ok) {
      return err({
        message: "底稿校验失败，未写入；上一份有效快照已保留。",
        errors: validation.errors,
      });
    }
    // P1-1 复核：凭据校验覆盖每个依赖材料的实质核查项（含"未发现问题"）
    const evidenceErrors: string[] = [];
    for (const item of validation.papers.items) {
      if (item.status !== "checked") continue;
      if (ctx.materials.length === 0) {
        evidenceErrors.push(
          `${item.item_id}：本任务未绑定任何材料，不能登记已核项（checked）——没有可依据的合同内容。`,
        );
        continue;
      }
      for (const ref of item.used_materials) {
        if (!ctx.evidence.readDocs.has(`${ref.doc_id}@${ref.version}`)) {
          evidenceErrors.push(
            `${item.item_id} 引用了未实际读取的材料版本 ${ref.doc_id}@${ref.version}：先用 doc_search / doc_read / doc_outline 取得实际正文后再引用。`,
          );
        }
      }
      if (item.used_materials.length === 0) {
        evidenceErrors.push(
          `${item.item_id} 已核但未引用任何材料版本：每个依赖合同内容的核查项（无论是否发现问题）都必须把实际读过的文件记入 used_materials。`,
        );
      }
    }
    if (evidenceErrors.length > 0) {
      return err({
        message: "底稿凭据校验失败，未写入；上一份有效快照已保留。",
        errors: evidenceErrors,
      });
    }
    // 首次确定路径、路由变化或同卡扩展：把范围原子保存到运行时存储（分母不随底稿文件漂移）
    if (validation.papers.scope && (!ctx.activeScope || validation.scopeChanged || validation.scopeExtended)) {
      const reason = validation.scopeChanged
        ? String((parsed as Record<string, unknown>).scope_change_reason ?? "route-change")
        : validation.scopeExtended
          ? "same-card-extended"
          : "initial";
      ctx.db.saveActiveScope(ctx.task.task_id, ctx.task.input_revision, {
        rule_cards: validation.papers.scope.rule_cards,
        expected_item_ids: validation.papers.scope.expected_item_ids,
        reason,
      });
      ctx.activeScope = {
        rule_cards: validation.papers.scope.rule_cards,
        expected_item_ids: validation.papers.scope.expected_item_ids,
        reason,
      };
    }
    ctx.papers = validation.papers;
  }
  ctx.db.putFile(ctx.task.task_id, normalized, content);
  return ok({ written: normalized, bytes: Buffer.byteLength(content, "utf8") });
}

function runEditFile(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const filePath = normalizeWorkspacePath(String(args.path ?? ""));
  if (filePath === null) return err("工作区路径不合法（仅允许相对路径，禁止 ..）");
  const file = ctx.db.getFile(ctx.task.task_id, filePath);
  if (!file) return err(`工作区文件不存在：${filePath}`);
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  const replaceAll = args.replace_all === true;
  const occurrences = file.content.split(oldText).length - 1;
  if (occurrences === 0) return err(`old_text 未命中（${filePath}）。文件内容未修改。`);
  if (occurrences > 1 && !replaceAll) {
    return err(`old_text 命中 ${occurrences} 处；需唯一命中或设置 replace_all。文件内容未修改。`);
  }
  const next = replaceAll
    ? file.content.split(oldText).join(newText)
    : file.content.replace(oldText, newText);
  return runWriteFile(filePath, next, ctx);
}

function runDocStatus(docId: string | undefined, ctx: ToolContext) {
  const targets = docId ? ctx.materials.filter((m) => m.doc_id === docId) : ctx.materials;
  return {
    materials: targets.map((m) => {
      const cached = ctx.docStatusCache.get(`${m.doc_id}@${m.version}`);
      return {
        doc_id: m.doc_id,
        version: m.version,
        role: m.role,
        label: m.label,
        pipeline_status: cached?.status ?? "unknown",
        ready: cached?.ready ?? false,
        needs_ocr: cached?.needs_ocr ?? false,
        error: cached?.error ?? null,
        parse_gaps: cached?.parse_gaps ?? [],
      };
    }),
  };
}

async function runDocOutline(docId: string, version: number | undefined, ctx: ToolContext) {
  const target = ctx.materials.find(
    (m) => m.doc_id === docId && (version === undefined || m.version === version),
  );
  if (!target) throw new Error(`材料不在当前输入修订：${docId}`);
  const outline = await pipeline.outline(ctx.identity, docId, target.version);
  if (outline.items.length > 0) {
    ctx.evidence.readDocs.add(`${docId}@${target.version}`); // P1-1 复核：目录非空才算读取证据
  }
  // 目录项裁剪，避免过长
  return {
    doc_id: docId,
    version: target.version,
    filename: outline.filename,
    block_count: outline.block_count,
    first_block_id: outline.first_block_id,
    hint: "用 mcp__doc_retrieval__doc_read 从 first_block_id 或 cursor=0 顺序通读。",
    items: outline.items.slice(0, 120),
  };
}

async function runDocSearch(args: Record<string, unknown>, ctx: ToolContext) {
  const outcome = await ctx.retrieval.search({
    tenantId: ctx.identity.tenant_id,
    authorized: ctx.materials,
    query: String(args.query ?? ""),
    docIds: Array.isArray(args.doc_ids) ? (args.doc_ids as string[]) : undefined,
    topK: args.top_k ? Number(args.top_k) : 10,
  });
  for (const hit of outcome.hits) {
    ctx.evidence.readDocs.add(`${hit.doc_id}@${hit.version}`); // P1-1：检索命中即读取证据
  }
  return {
    total: outcome.total,
    hits: outcome.hits.map((h) => {
      const material = ctx.materials.find((m) => m.doc_id === h.doc_id);
      return {
        doc_id: h.doc_id,
        doc_label: material?.label ?? h.doc_id,
        version: h.version,
        block_id: h.block_id,
        heading_path: h.heading_path,
        snippet: h.snippet || "（无高亮片段，可 doc_read 该块）",
      };
    }),
  };
}

async function runDocRead(args: Record<string, unknown>, ctx: ToolContext) {
  const docId = String(args.doc_id ?? "");
  const version = args.version ? Number(args.version) : undefined;
  const result = await ctx.retrieval.read({
    tenantId: ctx.identity.tenant_id,
    authorized: ctx.materials,
    docId,
    version,
    blockId: args.block_id ? String(args.block_id) : undefined,
    cursor: args.cursor !== undefined ? Number(args.cursor) : undefined,
    limit: args.limit ? Number(args.limit) : 3,
  });
  const key = `${docId}@${version ?? ctx.materials.find((m) => m.doc_id === docId)?.version ?? 0}`;
  const cached = ctx.docStatusCache.get(key);
  if (result.blocks.length > 0) {
    ctx.evidence.readDocs.add(key); // P1-1 复核：只有实际返回可用正文的回读才算证据，空回读不算
  }
  return {
    blocks: result.blocks,
    next_cursor: result.next_cursor,
    eof: result.eof,
    coverage_gaps: cached?.parse_gaps ?? [],
  };
}

// ===== 辅助 =====

function normalizeWorkspacePath(p: string): string | null {
  const normalized = p.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const resolved = path.posix.normalize(normalized);
  if (resolved === ".." || resolved.startsWith("../") || resolved.includes("/../")) return null;
  return resolved;
}

const ok = (output: unknown): ToolOutcome => ({ output, isError: false });
const err = (output: unknown): ToolOutcome => ({ output, isError: true });
