/** 共享类型：任务状态机、执行输入、working papers、结果对象。 */

// ===== 任务状态（v0.6 §3：单次提交，无待补态）=====
export type TaskStatus =
  | "queued"
  | "waiting_index"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "waiting_index",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const isTerminal = (status: TaskStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

// ===== 执行输入 =====
export interface MaterialInput {
  doc_id: string;
  version: number;
  role: string; // 主合同 / 附件 / 范本 / 制度 / 纪要 …
  label: string; // 展示文件名
  /** 输入修订内的来源：initial | supplement（含 request_id） */
  origin: { kind: "initial" } | { kind: "supplement"; request_id: string };
}

export interface SupplementText {
  request_id: string;
  text: string;
  revision: number;
}

// ===== 待补请求（设计 §4.2 / §4.6）=====
export type AcceptedInputKind = "text" | "file";

export interface InputRequest {
  request_id: string;
  task_id: string;
  tool_call_id: string;
  seq: number; // 任务内序号，用于上限计数
  question: string;
  impact: string;
  accepted_inputs: AcceptedInputKind[];
  status: "open" | "answered" | "closed";
  /** 接纳回执（幂等重发返回同一份） */
  answer: InputAnswerReceipt | null;
  answer_identity: string | null; // 规范化内容的 sha256
  created_at: number;
  answered_at: number | null;
}

export interface InputAnswerReceipt {
  action: "supplement" | "finish_with_available";
  text: string | null;
  add_docs: Array<{ doc_id: string; version: number; role?: string; label?: string }>;
  replace_docs: Array<{
    old: { doc_id: string; version: number };
    new: { doc_id: string; version: number };
    role?: string;
    label?: string;
  }>;
  accepted_revision: number;
  accepted_at: number;
}

// ===== working papers（设计 §4.3）=====
export type PaperItemStatus = "checked" | "pending" | "not_applicable";

export interface PaperFinding {
  problem: string;
  suggestion: string;
  /** 可选增强：位置与依据（skill 输出模板四要素） */
  location?: string;
  basis?: string;
}

export interface PaperMaterialRef {
  doc_id: string;
  version: number;
}

export interface PaperItem {
  item_id: string;
  rule_card: string;
  status: PaperItemStatus;
  finding: PaperFinding | null;
  used_materials: PaperMaterialRef[];
  pending_reason: string | null;
  missing_role: string | null;
  not_applicable_reason: string | null;
}

export interface PapersScope {
  /** 确定审核路径后登记：当前规则卡与预期 item_id 清单（覆盖统计的分母） */
  rule_cards: string[];
  expected_item_ids: string[];
}

/** 任务级缺口（v0.6 §4）：可落在整个任务（如专项路径待确定），随底稿持久化恢复。 */
export interface TaskGap {
  gap_id: string;
  category: "missing_material" | "missing_fact" | "file_issue" | "route_undetermined" | "budget";
  /** 陈述句：现有材料支持哪些判断、缺什么 */
  statement: string;
  /** 对覆盖的影响 */
  impact: string;
  /** 已提交文件出现问题时记录；从未提交的材料只写 missing_role，不虚构文件标识 */
  doc_id?: string;
  version?: number;
  label?: string;
  missing_role?: string;
}

export interface PapersDoc {
  scope: PapersScope | null;
  items: PaperItem[];
  /** 任务级缺口；专项路由未确定等全局缺口登记于此 */
  task_gaps: TaskGap[];
  /** 模型给出的总体结论口径（拟同意/请修改后再提交/…），缺省由运行时推导 */
  conclusion_hint: string | null;
}

// ===== 结果（设计 §5）=====
export type ReviewOutcome = "complete" | "partial" | "insufficient_materials";

export interface UsedMaterial {
  doc_id: string;
  version: number;
  label: string;
}

export interface MaterialIssue {
  doc_id: string;
  version: number;
  label: string;
  issue: string;
  impact: string;
}

export interface TaskUsage {
  steps: number;
  input_tokens: number;
  output_tokens: number;
  wall_seconds: number;
}

// ===== 模型消息（AI SDK ModelMessage 的持久化形态）=====
export interface StoredMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolCallId?: string;
  toolName?: string;
}
