/** 任务 API 与前端静态服务（设计 §4.6）。 */

import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { AcceptConflictError, taskService } from "./taskService.js";
import { coverageStats } from "./papers.js";
import type { PapersDoc } from "./types.js";
import { pipeline } from "./pipelineClient.js";

export interface ApiDeps {
  db: Db;
  scheduler: { kick(): void };
  skills: { manifestListing(): string; install(source: string): { ref: string } };
  activeRuns: Map<string, AbortController>;
}

interface Identity {
  tenant_id: string;
  user_id: string;
  admin: boolean;
}

/** agent 服务自身的 node_modules 目录（静态页依赖的浏览器构建从这里分发）。 */
function agentNodeModulesDir(): string {
  return path.resolve(config.webDir, "..", "node_modules");
}

const identityHeaders = (request: { headers: Record<string, unknown> }): Identity => {
  const tenant = String(request.headers["x-tenant-id"] ?? "");
  const user = String(request.headers["x-user-id"] ?? "");
  if (!tenant || !user) throw new AcceptConflictError(401, "missing x-tenant-id / x-user-id headers", null);
  return { tenant_id: tenant, user_id: user, admin: request.headers["x-admin"] === "1" };
};

const ensureTaskAccess = (deps: ApiDeps, identity: Identity, taskId: string) => {
  const task = deps.db.getTask(taskId);
  if (!task || task.tenant_id !== identity.tenant_id) throw new AcceptConflictError(404, "任务不存在", null);
  if (task.submitted_by !== identity.user_id && !identity.admin) {
    throw new AcceptConflictError(403, "无权访问该任务", { status: task.status });
  }
  return task;
};

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AcceptConflictError) {
      void reply.status(error.statusCode).send({ error: error.message, state: error.currentState ?? null });
      return;
    }
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    void reply.status(status).send({ error: err.message ?? "internal error" });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "docagent-agent" }));

  app.get("/api/skills", async () => ({
    skills: deps.db.listSkills().map((row) => ({
      ref: row.ref,
      name: row.name,
      version: row.version,
      manifest: JSON.parse(row.manifest),
    })),
  }));

  app.post("/api/skills/install", async (request, reply) => {
    // D2：在线安装仅平台管理员可用（M1 用 x-admin 头；生产接真实身份体系）
    if (request.headers["x-admin"] !== "1") {
      throw new AcceptConflictError(403, "仅管理员可安装 skill 包", null);
    }
    const body = request.body as { source?: string } | null;
    if (!body?.source) throw new AcceptConflictError(400, "缺少 source（目录或 ZIP 路径）", null);
    const pkg = deps.skills.install(body.source);
    return { ref: pkg.ref, installed: true };
  });

  // ===== 任务（设计 §4.6 API 表）=====

  app.post("/api/tasks", async (request, reply) => {
    const identity = identityHeaders(request);
    const body = request.body as {
      scenario?: string;
      skill?: string;
      docs?: Array<{ doc_id: string; version?: number; role?: string; label?: string }>;
      idempotency_key?: string;
    } | null;
    if (!body || !Array.isArray(body.docs)) {
      throw new AcceptConflictError(400, "docs 必须是数组（可为空）", null);
    }
    const created = await taskService.createTask(
      { db: deps.db, skills: deps.skills as never },
      identity,
      {
        scenario: body.scenario ?? "",
        skill: body.skill ?? "",
        docs: body.docs,
        idempotency_key: body.idempotency_key,
      },
    );
    deps.scheduler.kick();
    void reply.status(201);
    return created;
  });

  app.get("/api/tasks/:id", async (request) => {
    const identity = identityHeaders(request as never);
    const { id } = request.params as { id: string };
    const task = ensureTaskAccess(deps, identity, id);

    const materials = deps.db.latestMaterials(id);
    const materialViews = await Promise.all(
      materials.map(async (m) => {
        try {
          const status = await pipeline.docStatus(identity, m.doc_id, m.version);
          return {
            doc_id: m.doc_id,
            version: m.version,
            role: m.role,
            label: m.label,
            pipeline_status: status.status,
            ready: status.ready,
            error: status.error,
          };
        } catch {
          return {
            doc_id: m.doc_id,
            version: m.version,
            role: m.role,
            label: m.label,
            pipeline_status: "unknown",
            ready: false,
            error: null,
          };
        }
      }),
    );

    const checkpoint = deps.db.latestCheckpoint(id);
    let progress: Record<string, unknown> | null = null;
    if (checkpoint) {
      try {
        const papers = JSON.parse(checkpoint.papers) as PapersDoc;
        progress = { ...coverageStats(papers), step: checkpoint.step_no };
      } catch {
        progress = null;
      }
    }

    return {
      task_id: id,
      status: task.status,
      status_reason: task.status_reason,
      scenario: task.scenario,
      skill_ref: task.skill_ref,
      input_revision: task.input_revision,
      input_closed: task.input_closed === 1,
      materials: materialViews,
      progress,
      // v0.6：单次提交流程，无待补卡；旧客户端过渡读取固定为 null
      pending_input: null,
      usage: JSON.parse(task.usage || "{}"),
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  });

  // v0.6 §5：补件接口下线——鉴权后返回 410 与刷新提示，不产生任何写操作
  app.post("/api/tasks/:id/input", async (request, reply) => {
    const identity = identityHeaders(request as never);
    const { id } = request.params as { id: string };
    ensureTaskAccess(deps, identity, id);
    void reply.status(410);
    return {
      error: "补件接口已下线：任务为单次提交流程，不能追加输入。请刷新页面查看任务状态；需要补材料时请提交新任务。",
      task_id: id,
    };
  });

  app.get("/api/tasks/:id/result", async (request, reply) => {
    const identity = identityHeaders(request as never);
    const { id } = request.params as { id: string };
    const task = ensureTaskAccess(deps, identity, id);
    if (task.status === "completed") {
      const row = deps.db.db
        .prepare("SELECT * FROM results WHERE task_id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!row) throw new AcceptConflictError(500, "结果缺失", null);
      return {
        task_id: id,
        status: task.status,
        conclusion_md: row.conclusion_md,
        review_outcome: row.review_outcome,
        used_materials: JSON.parse(row.used_materials as string),
        material_issues: JSON.parse(row.material_issues as string),
        skill_ref: row.skill_ref,
        input_revision: row.input_revision,
        usage: JSON.parse(row.usage as string),
      };
    }
    if (task.status === "failed" || task.status === "cancelled") {
      void reply.status(200);
      return {
        task_id: id,
        status: task.status,
        reason: task.status_reason,
        progress: progressOf(deps, id),
      };
    }
    void reply.status(202);
    return { task_id: id, status: task.status, progress: progressOf(deps, id) };
  });

  app.post("/api/tasks/:id/cancel", async (request) => {
    const identity = identityHeaders(request as never);
    const { id } = request.params as { id: string };
    ensureTaskAccess(deps, identity, id);
    const result = taskService.cancelTask({ db: deps.db, activeRuns: deps.activeRuns }, identity, id);
    deps.scheduler.kick();
    return result;
  });

  // ===== SSE（可选进度增强；前端也可仅轮询任务详情）=====
  app.get("/api/tasks/:id/events", async (request, reply) => {
    const identity = identityHeaders(request as never);
    const { id } = request.params as { id: string };
    ensureTaskAccess(deps, identity, id);
    const query = request.query as { after?: string };
    let lastSeq = Number(query.after ?? 0) || 0;

    void reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const timer = setInterval(() => {
      const events = deps.db.eventsAfter(id, lastSeq);
      for (const event of events) {
        lastSeq = event.seq;
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ task_id: id, seq: event.seq, ts: event.ts, type: event.type, data: JSON.parse(event.data) })}\n\n`);
      }
      if (events.length > 0 || Math.random() < 0.2) {
        reply.raw.write(`: keepalive\n\n`);
      }
      const task = deps.db.getTask(id);
      if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
        reply.raw.write(`event: end\ndata: {"status":"${task.status}"}\n\n`);
        reply.raw.end();
        clearInterval(timer);
      }
    }, 2_000);
    request.raw.on("close", () => clearInterval(timer));
    await new Promise(() => {
      /* 挂起直到连接关闭 */
    });
  });

  // ===== 前端静态资源 =====
  const webDir = config.webDir;
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    // marked 浏览器构建：新版包在 lib/marked.umd.js，旧版在 marked.min.js；
    // 从 node_modules 实际存在的候选提供，与自定义 Web 目录互相独立。
    const markedCandidates = [
      path.join(agentNodeModulesDir(), "marked", "lib", "marked.umd.js"),
      path.join(agentNodeModulesDir(), "marked", "marked.min.js"),
      path.join(agentNodeModulesDir(), "marked", "lib", "marked.cjs"),
    ];
    const markedPath = markedCandidates.find((candidate) => fs.existsSync(candidate));
    if (markedPath) {
      app.get("/vendor/marked.js", async (_request, reply) => {
        void reply.type("application/javascript").send(fs.readFileSync(markedPath));
      });
      // 兼容旧引用路径
      app.get("/vendor/marked.min.js", async (_request, reply) => {
        void reply.type("application/javascript").send(fs.readFileSync(markedPath));
      });
    }
  }

  return app;

  function progressOf(deps: ApiDeps, id: string): Record<string, unknown> | null {
    const checkpoint = deps.db.latestCheckpoint(id);
    if (!checkpoint) return null;
    try {
      const papers = JSON.parse(checkpoint.papers) as PapersDoc;
      return { ...coverageStats(papers), step: checkpoint.step_no };
    } catch {
      return null;
    }
  }
}
