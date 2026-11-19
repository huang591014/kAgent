/** 运行配置：环境变量优先，仓库根 .env 兜底（dev）。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.[ts|js] → 上一级 = docagent-agent，再上两级 = 仓库根（kAgent）；
// 相对数据路径锚定在仓库根，与 .env.example 的 ./var/... 约定一致（部署时用绝对路径 env 覆盖）。
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(agentDir, "../..");

function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) process.env[key] = value;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadDotenv();

function str(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function int(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 相对路径锚定仓库根（var 数据卷约定）；绝对路径原样使用。 */
function rooted(key: string, fallback: string): string {
  const value = process.env[key] || fallback;
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

export const config = {
  host: str("AGENT_HOST", "0.0.0.0"),
  port: int("AGENT_PORT", 8001),

  dataDir: rooted("AGENT_DATA_DIR", "./var/agent"),
  skillsDir: rooted("AGENT_SKILLS_DIR", "./var/skills"),
  /** web 目录随服务代码走（services/docagent-agent/web） */
  webDir: process.env.AGENT_WEB_DIR
    ? path.isAbsolute(process.env.AGENT_WEB_DIR)
      ? process.env.AGENT_WEB_DIR
      : path.join(repoRoot, process.env.AGENT_WEB_DIR)
    : path.join(agentDir, "web"),

  pipelineBaseUrl: str("PIPELINE_BASE_URL", "http://localhost:8000"),
  internalServiceKey: str("INTERNAL_SERVICE_KEY", "dev-internal-key"),

  modelBaseUrl: str("MODEL_BASE_URL", "http://localhost:8000"),
  modelApiKey: str("MODEL_API_KEY", "dev-api-key"),
  modelName: str("MODEL_NAME", "qwen3.8-27b"),
  modelContextWindow: int("MODEL_CONTEXT_WINDOW", 128_000),
  modelTemperature: 0.1,

  opensearchUrl: str("OPENSEARCH_URL", "http://localhost:9200"),
  opensearchUser: str("OPENSEARCH_USER", ""),
  opensearchPassword: str("OPENSEARCH_PASSWORD", ""),
  blocksIndex: str("OPENSEARCH_BLOCKS_INDEX", "docagent-blocks"),

  // 执行预算（设计 §4.4）
  maxRunningTasks: int("MAX_RUNNING_TASKS", 4),
  maxSteps: int("MAX_STEPS", 48),
  maxTaskWallMinutes: int("MAX_TASK_WALL_MINUTES", 40),
  maxTaskTokens: int("MAX_TASK_TOKENS", 2_000_000),
  requestInputLimit: int("REQUEST_INPUT_LIMIT", 3),
  waitingIndexTimeoutSeconds: int("WAITING_INDEX_TIMEOUT_SECONDS", 900),

  // 上下文分配（token）：系统与清单 6k、历史 90k、本步工具结果 20k、输出预留 8k
  budgetSystem: int("BUDGET_SYSTEM_TOKENS", 6_000),
  budgetHistory: int("BUDGET_HISTORY_TOKENS", 90_000),
  budgetToolResult: int("BUDGET_TOOL_RESULT_TOKENS", 20_000),
  budgetReservedOutput: int("BUDGET_RESERVED_OUTPUT_TOKENS", 8_000),

  // skill 正文加载上限（字节）与清单预算（字符），见设计 §4.3
  skillBodyMaxBytes: 100_000,
  skillManifestBudgetChars: 12_000,
} as const;
