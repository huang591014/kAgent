/** docagent-agent 入口：装配 DB、skill 注册表、检索、调度器与 HTTP 服务。 */

import { config } from "./config.js";
import { Db } from "./db.js";
import { buildServer } from "./httpApi.js";
import { OpenSearchRetrieval } from "./opensearch.js";
import { runTask } from "./runner/run.js";
import { Scheduler } from "./scheduler.js";
import { SkillRegistry } from "./skills/registry.js";

async function main(): Promise<void> {
  const db = new Db();
  const skills = new SkillRegistry(db);
  const installed = skills.scanRoot();
  if (installed.length > 0) {
    console.log(`[skills] 已安装 ${installed.length} 个 skill：${installed.map((p) => p.ref).join("、")}`);
  } else {
    console.warn(`[skills] ${config.skillsDir} 下没有 skill 包；请安装后重启，或调用 POST /api/skills/install`);
  }

  const retrieval = new OpenSearchRetrieval();
  const activeRuns = new Map<string, AbortController>();
  const scheduler = new Scheduler(db);
  const runnerDeps = {
    db,
    skills,
    retrieval,
    activeRuns,
    onSettled: () => scheduler.kick(),
  };
  scheduler.start(runnerDeps);

  const app = await buildServer({
    db,
    scheduler,
    skills,
    activeRuns,
  });
  await app.listen({ port: config.port, host: config.host });
  console.log(`docagent-agent listening on http://${config.host}:${config.port}`);
  console.log(`  pipeline: ${config.pipelineBaseUrl}  model: ${config.modelBaseUrl}/${config.modelName}`);
  void runTask; // 保留引用便于测试装配
}

main().catch((error) => {
  console.error("docagent-agent 启动失败：", error);
  process.exit(1);
});
