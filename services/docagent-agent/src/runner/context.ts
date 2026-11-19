/** 上下文预算：128k 窗口的 token 估算与消息装配（设计 §4.4）。

分配：系统与清单约 6k、历史最多 90k、本步工具结果最多 20k、预留 8k 输出。
每步按完整请求校验预算；较早的长文本工具结果替换为存根，
更早的整段对话按用户消息边界丢弃并插入省略标记。
*/

import { config } from "../config.js";
import type { StoredMessage } from "../types.js";

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor(other / 4);
}

export function messageTokens(message: StoredMessage): number {
  let total = 8;
  if (typeof message.content === "string") {
    total += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    total += estimateTokens(JSON.stringify(message.content));
  }
  if (message.toolCalls) {
    total += estimateTokens(JSON.stringify(message.toolCalls));
  }
  return total;
}

export interface BudgetResult {
  messages: StoredMessage[];
  dropped: number;
  truncatedToolResults: number;
}

/** 装配发送给模型的历史：旧工具结果压缩 + 头部丢弃，控制在预算内。 */
export function fitMessagesToBudget(
  history: readonly StoredMessage[],
  opts: { budget?: number } = {},
): BudgetResult {
  const messages = history.map(cloneMessage);
  let truncated = 0;

  // 1) 压缩较早的工具结果（最近一条 tool 消息保留 20k，其余压到 2k）
  const lastToolIndex = findLastIndex(messages, (m) => m.role === "tool");
  messages.forEach((message, index) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    const cap = index === lastToolIndex ? config.budgetToolResult : Math.floor(config.budgetToolResult / 10);
    const blocks = message.content as Array<Record<string, unknown>>;
    let changed = false;
    const next = blocks.map((block) => {
      const serialized = JSON.stringify(block.output ?? "");
      if (estimateTokens(serialized) <= cap) return block;
      changed = true;
      truncated += 1;
      const asString = typeof block.output === "string" ? block.output : serialized;
      let text = asString;
      while (estimateTokens(text) > cap && text.length > 100) {
        text = text.slice(0, Math.floor(text.length * 0.85));
      }
      return { ...block, output: `${text}\n[工具结果过长，已截断；需要时请用相应工具重新读取]` };
    });
    if (changed) message.content = next;
  });

  // 2) 头部丢弃：超出预算时，从最早的可丢弃 user 边界开始逐段丢弃
  let dropped = 0;
  const budget = opts.budget ?? config.budgetHistory;
  const total = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  if (total > budget) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    const safeStart = firstUser === -1 ? 0 : firstUser + 1;
    // 候选切点：safeStart 之后的每条 user 消息（切点保留其后全部）
    const boundaries: number[] = [];
    for (let i = safeStart; i < messages.length; i++) {
      if (messages[i]!.role === "user") boundaries.push(i);
    }
    let cut = -1;
    let acc = total;
    for (const boundary of boundaries) {
      const saved = messages.slice(safeStart, boundary).reduce((sum, m) => sum + messageTokens(m), 0);
      acc -= saved;
      cut = boundary;
      if (acc <= budget) break;
    }
    if (cut > safeStart) {
      dropped = cut - safeStart;
      const kept = messages.slice(cut);
      kept.unshift({ role: "user", content: "[更早的对话因长度策略已省略；关键事实请以 working-papers.json 为准]" });
      return { messages: kept, dropped, truncatedToolResults: truncated };
    }
  }

  return { messages, dropped, truncatedToolResults: truncated };
}

function cloneMessage(message: StoredMessage): StoredMessage {
  return {
    role: message.role,
    content: typeof message.content === "string" ? message.content : structuredClone(message.content),
    ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

/** 系统提示预算校验：超出时告警（系统提示由我们控制，一般不会超）。 */
export function systemFitsBudget(system: string): boolean {
  return estimateTokens(system) <= config.budgetSystem * 1.5;
}
