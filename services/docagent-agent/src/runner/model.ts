/** 内网文本模型接入：OpenAI 兼容适配器（设计 §4.4）。

审查温度初值 0.1，默认关闭 thinking 与并行工具调用；
暂停恢复不重置累计用量（usage 在任务行累计）。
*/

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../config.js";

export const provider = createOpenAICompatible({
  name: "intranet",
  baseURL: config.modelBaseUrl,
  apiKey: config.modelApiKey || "unset",
});

export const chatModel = () => provider.chatModel(config.modelName);

export const modelCallOptions = {
  temperature: config.modelTemperature,
  // 预留输出 8k（设计 §4.4）
  maxOutputTokens: config.budgetReservedOutput,
} as const;
