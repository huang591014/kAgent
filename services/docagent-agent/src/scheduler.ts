/** 任务调度器（设计 §4.1）。

- 初始同时运行上限 4；两种等待态均释放执行槽；
- 执行领取在 runTask 内以 claimTask 原子完成（status=queued 条件更新），
  定时 tick 与 kick() 重叠时同一任务只会启动一个 runner；
- waiting_index：等待起点与截止持久化（任务 × 输入修订 × 文档版本），
  超时把该版本在本修订记为不可用并交还审核逻辑（带原因），服务重启沿用截止时间。
*/

import { config } from "./config.js";
import type { Db } from "./db.js";
import { pipeline } from "./pipelineClient.js";
import type { RunnerDeps } from "./runner/run.js";
import { runTask } from "./runner/run.js";

const PROCESSING_STATUSES = ["uploaded", "parsing", "structuring", "indexing"];

interface MaterialStatusSnapshot {
  ready: boolean;
  status: string;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatched = new Set<string>();
  private ticking = false;
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

  /** 重启恢复：running 残留（无活动句柄）回 queued，从最近检查点重做。 */
  private recover(): void {
    for (const task of this.db.listTasksByStatus(["running"])) {
      this.db.updateTask(task.task_id, { status: "queued", current_batch: null });
    }
  }

  /** 外部触发立即调度（新任务 / 补件接纳后）。tick 重入保护防重叠。 */
  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickWaitingIndex();
      await this.tickDispatch();
    } finally {
      this.ticking = false;
    }
  }

  /** waiting_index：轮询绑定版本；就绪/全部终态/超时 → 回 queued。 */
  private async tickWaitingIndex(): Promise<void> {
    for (const task of this.db.listTasksByStatus(["waiting_index"])) {
      const materials = this.db.latestMaterials(task.task_id);
      const timeoutMs = config.waitingIndexTimeoutSeconds * 1000;
      let anyReady = false;
      let anyProcessing = false;
      let anyTimedOut = false;
      for (const material of materials) {
        const snapshot = await this.statusOf(task, material.doc_id, material.version);
        if (snapshot.ready) {
          anyReady = true;
          continue;
        }
        if (PROCESSING_STATUSES.includes(snapshot.status)) {
          anyProcessing = true;
          const wait = this.db.getOrCreateWait(task.task_id, task.input_revision, material.doc_id, material.version, timeoutMs);
          if (!wait.decided && Date.now() >= wait.deadline) {
            // 超时：该版本在本修订记为不可用，交还审核逻辑（带原因）
            this.db.decideWait(task.task_id, task.input_revision, material.doc_id, material.version, "timeout");
            anyTimedOut = true;
          } else if (wait.decided === "timeout") {
            anyTimedOut = true;
          }
        }
      }
      if (anyReady || !anyProcessing || anyTimedOut) {
        this.db.updateTask(task.task_id, { status: "queued" });
        this.db.appendEvent(task.task_id, "progress", {
          note: anyTimedOut && !anyReady ? "waiting_index 超时，按单份材料不可用交还审核" : "waiting_index 解除",
        });
      }
    }
  }

  /** queued → 派发；全部所需文件仍在处理且未超时 → waiting_index。 */
  private async tickDispatch(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    for (const task of this.db.listTasksByStatus(["queued"])) {
      if (this.dispatched.size >= config.maxRunningTasks) break;
      if (this.dispatched.has(task.task_id)) continue;

      const materials = this.db.latestMaterials(task.task_id);
      let anyReady = false;
      let anyProcessing = false;
      const timeoutMs = config.waitingIndexTimeoutSeconds * 1000;
      for (const material of materials) {
        const snapshot = await this.statusOf(task, material.doc_id, material.version);
        if (snapshot.ready) anyReady = true;
        else if (PROCESSING_STATUSES.includes(snapshot.status)) anyProcessing = true;
      }

      if (materials.length > 0 && !anyReady && anyProcessing) {
        // 仍在本修订的等待截止内 → 等待索引；已超时的版本不再等待（交还审核）
        const timedOut = this.db.timedOutDocs(task.task_id, task.input_revision);
        const stillWaiting = materials.some((m) => !timedOut.has(`${m.doc_id}@${m.version}`));
        for (const material of materials) {
          if (timedOut.has(`${material.doc_id}@${material.version}`)) continue;
          this.db.getOrCreateWait(task.task_id, task.input_revision, material.doc_id, material.version, timeoutMs);
        }
        if (stillWaiting) {
          this.db.updateTask(task.task_id, { status: "waiting_index" });
          this.db.appendEvent(task.task_id, "progress", { note: "waiting_index" });
          continue;
        }
      }

      // 派发：runTask 内 claimTask 原子领取（queued→running 条件更新），并发 tick 只有一个成功
      this.dispatched.add(task.task_id);
      const taskId = task.task_id;
      void runTask(deps, taskId)
        .catch((error) => console.error(`[scheduler] runTask ${taskId} crashed:`, error))
        .finally(() => {
          this.dispatched.delete(taskId);
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
