import { describe, expect, it } from "vitest";
import { estimateTokens, fitMessagesToBudget, messageTokens } from "../src/runner/context.js";
import { isFollowUpOnly } from "../src/runner/run.js";
import type { StoredMessage } from "../src/types.js";

describe("estimateTokens", () => {
  it("CJK 约 1 字 1 token，ASCII 约 4 字符 1 token", () => {
    expect(estimateTokens("合同审查")).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("fitMessagesToBudget", () => {
  it("较早的超长工具结果被压缩，最近一条保留较多", () => {
    const big = "条".repeat(30_000);
    const messages: StoredMessage[] = [
      { role: "user", content: "任务说明" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "mcp__doc_retrieval__doc_read", input: {} }] },
      { role: "tool", content: [{ toolCallId: "c1", toolName: "doc_read", output: big }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "doc_read", input: {} }] },
      { role: "tool", content: [{ toolCallId: "c2", toolName: "doc_read", output: "短结果" }] },
    ];
    const fitted = fitMessagesToBudget(messages);
    expect(fitted.truncatedToolResults).toBe(1);
    const firstTool = fitted.messages.find((m) => m.role === "tool")!;
    const block = (firstTool.content as Array<Record<string, unknown>>)[0]!;
    expect(String(block.output)).toContain("已截断");
    const lastTool = [...fitted.messages].reverse().find((m) => m.role === "tool")!;
    const lastBlock = (lastTool.content as Array<Record<string, unknown>>)[0]!;
    expect(lastBlock.output).toBe("短结果");
  });

  it("超出历史预算时按 user 边界丢头并插入省略标记", () => {
    const messages: StoredMessage[] = [
      { role: "user", content: "首个任务说明" },
      { role: "assistant", content: "好" },
      { role: "user", content: "继续1" },
      { role: "assistant", content: "长".repeat(20_000) },
      { role: "user", content: "继续2" },
      { role: "assistant", content: "结束" },
    ];
    const fitted = fitMessagesToBudget(messages, { budget: 1_000 });
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.messages[0]!.content).toContain("已省略");
    expect(fitted.messages[fitted.messages.length - 1]!.content).toBe("结束");
  });

  it("messageTokens 对工具调用消息可估算", () => {
    const message: StoredMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "doc_search", input: { query: "付款" } }],
    };
    expect(messageTokens(message)).toBeGreaterThan(10);
  });
});

describe("isFollowUpOnly（纯追问进入修正路径）", () => {
  it("普通追问文本 → true", () => {
    expect(isFollowUpOnly("请确认合同类型？是运维服务还是人员外包？")).toBe(true);
  });

  it("含章标题的纯追问 → true（设计 §8）", () => {
    expect(isFollowUpOnly("【审核意见】\n\n请确认本合同是否属于采购类合同？")).toBe(true);
  });

  it("实质意见 → false", () => {
    expect(
      isFollowUpOnly(
        "合同第5条付款条件约定不明确，未约定验收通过的标准和确认人。依据《合同管理办法》第三十条，建议补充验收标准与确认流程。",
      ),
    ).toBe(false);
  });

  it("空文本 → false", () => {
    expect(isFollowUpOnly("")).toBe(false);
  });
});
