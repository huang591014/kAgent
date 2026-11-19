/** 任务调度器（设计 §4.1）。

- 初始同时运行上限 4；两种等待态均释放执行槽；
- waiting_index：轮询本次审核会用到的指定文档版本，就绪后继续；
  等待超时按单份材料不可用处理，带原因回到审核逻辑；
- 重启扫描：已接纳但未开始的任务恢复调度；running 残留任务从最近检查点重做。
*/

import { config } from "./config.js";
import type { Db } from "./db.js";
import { pipeline } from "./pipelineClient.js";
import type { RunnerDeps } from "./runner/run.js";
import { runTask } from "./runner/run.js";

interface MaterialStatusSnapshot {
  ready: boolean;
  status: string;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly waitingSince = new Map<string, number>();
  private readonly dispatched = new Set<string>();
  private deps: RunnerDeps | null = null;

  constructor(private readonly db: Db) {}

  start(deps: RunnerDeps): void {
    this.deps = deps;
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 重启恢复：running 残留（无活动句柄）与已接纳未开始的任务。 */
  private recover(): void {
    for (const task of this.db.listTasksByStatus(["running"])) {
      this.db.updateTask(task.task_id, { status: "queued", current_batch: null });
    }
    for (const task of this.db.listTasksByStatus(["waiting_index"])) {
      this.waitingSince.set(task.task_id, Date.now() - 60_000); // 给一段重新观察窗口
    }
  }

  /** 外部触发立即调度（新任务 / 补件接纳后）。 */
  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    // 1) waiting_index：轮询绑定文档版本
    for (const task of this.db.listTasksByStatus(["waiting_index"])) {
      const materials = this.db.latestMaterials(task.task_id);
      let anyReady = false;
      let anyProcessing = false;
      for (const material of materials) {
        const snapshot = await this.statusOf(task, material.doc_id, material.version);
        if (snapshot.ready) anyReady = true;
        else if (["uploaded", "parsing", "structuring", "indexing"].includes(snapshot.status)) anyProcessing = true;
      }
      const since = this.waitingSince.get(task.task_id) ?? Date.now();
      const timedOut = Date.now() - since > config.waitingIndexTimeoutSeconds * 1000;
      if (anyReady || !anyProcessing || timedOut) {
        this.waitingSince.delete(task.task_id);
        this.db.updateTask(task.task_id, {
          status: "queued",
          ...(timedOut && !anyReady ? { status_reason: `等待索引超时（>${config.waitingIndexTimeoutSeconds}s），按单份材料不可用处理` } : {}),
        });
      }
    }

    // 2) queued → 派发（受并发上限）
    const queued = this.db.listTasksByStatus(["queued"]);
    for (const task of queued) {
      if (this.dispatched.size >= config.maxRunningTasks) break;
      if (this.dispatched.has(task.task_id)) continue;

      const materials = this.db.latestMaterials(task.task_id);
      let anyReady = false;
      let anyProcessing = false;
      for (const material of materials) {
        const snapshot = await this.statusOf(task, material.doc_id, material.version);
        if (snapshot.ready) anyReady = true;
        else if (["uploaded", "parsing", "structuring", "indexing"].includes(snapshot.status)) anyProcessing = true;
      }

      if (materials.length > 0 && !anyReady && anyProcessing) {
        // 所需文件仍在处理中且无其他可做工作 → 等待索引
        if (!this.waitingSince.has(task.task_id)) this.waitingSince.set(task.task_id, Date.now());
        this.db.updateTask(task.task_id, { status: "waiting_index" });
        this.db.appendEvent(task.task_id, "progress", { note: "waiting_index" });
        continue;
      }

      this.dispatched.add(task.task_id);
      const taskId = task.task_id;
      void runTask(deps, taskId)
        .catch((error) => console.error(`[scheduler] runTask ${taskId} crashed:`, error))
        .finally(() => {
          this.dispatched.delete(taskId);
          // 任务结束后尽快调度下一个
          setImmediate(() => this.kick());
        });
    }
  }

  private async statusOf(
    task: { tenant_id: string; submitted_by: string },
    docId: string,
    version: number,
  ): Promise<MaterialStatusSnapshot> {
    try {
      const status = await pipeline.docStatus(
        { tenant_id: task.tenant_id, user_id: task.submitted_by },
        docId,
        version,
      );
      return { ready: status.ready, status: status.status };
    } catch {
      return { ready: false, status: "unknown" };
    }
  }
}
