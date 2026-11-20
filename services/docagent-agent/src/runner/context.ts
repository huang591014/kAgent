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

  // 2) 头部裁剪（P1-9）：单次提交通常只有首条 user，之后全是 assistant/tool 往返。
  //    按「工具组」成组丢弃：assistant(带 toolCalls) + 其后连续的 tool 消息为一组，
  //    整组删除不破坏调用-回执配对；保留首条 user（任务输入）与最新进度，
  //    丢弃点插入一条省略标记。早期底稿写入等长往返被替换为该引用。
  let dropped = 0;
  const budget = opts.budget ?? config.budgetHistory;
  const total = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  if (total > budget) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    const safeStart = firstUser === -1 ? 0 : firstUser + 1;
    // 分组：从 safeStart 起把消息切成 [组...]；组 = 一条 assistant + 紧随的 tool（若有），
    // 或单条无工具 assistant / user
    const groups: Array<{ start: number; end: number }> = [];
    let i = safeStart;
    while (i < messages.length) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        let end = i + 1;
        while (end < messages.length && messages[end]!.role === "tool") end += 1;
        groups.push({ start: i, end });
        i = end;
      } else {
        groups.push({ start: i, end: i + 1 });
        i += 1;
      }
    }
    // 从最旧的组开始丢，直到满足预算或只剩最后一组；省略标记本身计入预算（P1-9 复核）
    const omissionMarker = {
      role: "user" as const,
      content:
        "[更早的工具往返因长度策略已省略（底稿写入等）；关键事实与进度以 working-papers.json 为准，需要原文请用检索工具重新读取]",
    };
    const markerTokens = messageTokens(omissionMarker);
    let acc = total;
    let dropUpto = safeStart; // 丢弃 [safeStart, dropUpto)
    for (const group of groups) {
      if (group.end >= messages.length) break; // 至少保留最后一组
      acc -= messages.slice(group.start, group.end).reduce((sum, m) => sum + messageTokens(m), 0);
      dropUpto = group.end;
      if (acc + markerTokens <= budget) break;
    }
    if (dropUpto > safeStart) {
      dropped = dropUpto - safeStart;
      const kept = messages.slice(0, safeStart).concat(messages.slice(dropUpto));
      kept.splice(safeStart, 0, omissionMarker);
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
