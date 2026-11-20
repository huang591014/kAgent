/** 任务调度器（设计 v0.6 §3）。

- 初始同时运行上限 4；等待态释放执行槽；
- 执行领取在 runTask 内以 claimTask 原子完成（status=queued 条件更新）；
- waiting_index 唤醒只看**活跃等待记录**（index_waits 中未决出的版本）：
  依赖版本就绪、失败或到期才唤醒——其他材料（如已就绪的主合同）的状态
  不再触发唤醒，避免反复空转消耗模型步数；
- 停止后阻止新调度（含在途 runTask 收尾时的 kick），避免触碰已关闭的存储。
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
  private stopped = false;
  private deps: RunnerDeps | null = null;

  constructor(private readonly db: Db) {}

  start(deps: RunnerDeps): void {
    this.deps = deps;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true; // 在途回调（runTask.finally 的 kick）不再发起新调度
  }

  /** 在途派发是否全部收尾（测试关闭存储前等待）。 */
  async quiesce(): Promise<void> {
    while (this.dispatched.size > 0 || this.ticking) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** 重启恢复：running 残留（无活动句柄）回 queued，从最近检查点重做。 */
  private recover(): void {
    for (const task of this.db.listTasksByStatus(["running"])) {
      this.db.updateTask(task.task_id, { status: "queued", current_batch: null });
    }
  }

  /** 外部触发立即调度（新任务 / 补件接纳后）。tick 重入保护防重叠。 */
  kick(): void {
    if (this.stopped) return;
    void this.tick();
  }

  private async tick(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.tickWaitingIndex();
      await this.tickDispatch();
    } finally {
      this.ticking = false;
    }
  }

  /** waiting_index：只按活跃等待记录唤醒（P1-2 复核）。
   * 依赖版本就绪 → 记 ready 并唤醒；失败/需OCR → 记 unavailable 并唤醒（收尾说明）；
   * 截止已到 → 记 timeout 并唤醒；全部活跃等待仍在处理且未到期 → 保持等待。
   * 无活跃记录时按全量兜底（正常路径下 dispatch/runner 进入等待前都会建记录）。 */
  private async tickWaitingIndex(): Promise<void> {
    for (const task of this.db.listTasksByStatus(["waiting_index"])) {
      const activeWaits = this.db.listActiveWaits(task.task_id, task.input_revision);
      if (activeWaits.length === 0) {
        await this.wakeOnAnyTerminal(task.task_id, task.input_revision, task.tenant_id, task.submitted_by, task.is_admin);
        continue;
      }
      let wake = false;
      let wakeReason = "";
      for (const wait of activeWaits) {
        const snapshot = await this.statusOf(task, wait.doc_id, wait.version);
        if (snapshot.ready) {
          this.db.decideWait(task.task_id, task.input_revision, wait.doc_id, wait.version, "ready");
          wake = true;
          wakeReason = "等待的材料版本已就绪";
          continue;
        }
        if (!PROCESSING_STATUSES.includes(snapshot.status)) {
          // failed / needs_ocr / unknown：依赖版本退出可等待集合，交还审核收尾
          this.db.decideWait(task.task_id, task.input_revision, wait.doc_id, wait.version, "unavailable");
          wake = true;
          wakeReason = `等待的材料版本处理结束（${snapshot.status}）`;
          continue;
        }
        if (Date.now() >= wait.deadline) {
          this.db.decideWait(task.task_id, task.input_revision, wait.doc_id, wait.version, "timeout");
          wake = true;
          wakeReason = "等待索引超时，按单份材料不可用交还审核";
        }
      }
      if (wake) {
        if (this.db.transitionTask(task.task_id, "waiting_index", "queued")) {
          this.db.appendEvent(task.task_id, "progress", { note: wakeReason });
        }
      }
    }
  }

  /** 兜底路径：无活跃等待记录时，任一版本就绪、或没有「仍在处理且未超时」的版本即唤醒。 */
  private async wakeOnAnyTerminal(taskId: string, revision: number, tenantId: string, submittedBy: string, isAdmin: number): Promise<void> {
    const materials = this.db.latestMaterials(taskId);
    const timedOut = this.db.timedOutDocs(taskId, revision);
    let anyReady = false;
    let anyWaitable = false;
    for (const material of materials) {
      const snapshot = await this.statusOf({ tenant_id: tenantId, submitted_by: submittedBy, is_admin: isAdmin }, material.doc_id, material.version);
      if (snapshot.ready) {
        anyReady = true;
        continue;
      }
      if (PROCESSING_STATUSES.includes(snapshot.status) && !timedOut.has(`${material.doc_id}@${material.version}`)) {
        anyWaitable = true;
      }
    }
    if (anyReady || !anyWaitable) {
      if (this.db.transitionTask(taskId, "waiting_index", "queued")) {
        this.db.appendEvent(taskId, "progress", { note: "waiting_index 解除（无活跃等待记录）" });
      }
    }
  }

  /** queued → 派发；全部所需文件仍在处理且未超时 → waiting_index（建活跃等待记录）。 */
  private async tickDispatch(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.stopped) return;
    for (const task of this.db.listTasksByStatus(["queued"])) {
      if (this.stopped) return;
      if (this.dispatched.size >= config.maxRunningTasks) break;
      if (this.dispatched.has(task.task_id)) continue;

      const materials = this.db.latestMaterials(task.task_id);
      let anyReady = false;
      const timeoutMs = config.waitingIndexTimeoutSeconds * 1000;
      const waitingCandidates: Array<{ doc_id: string; version: number }> = [];
      for (const material of materials) {
        const snapshot = await this.statusOf(task, material.doc_id, material.version);
        if (snapshot.ready) {
          anyReady = true;
          continue;
        }
        // 只有「仍在处理」的版本才是等待候选；failed/needs_ocr/unknown/已超时
        // 的版本一律退出等待集合，任务按可做内容收尾并说明原因
        if (!PROCESSING_STATUSES.includes(snapshot.status)) continue;
        if (this.db.timedOutDocs(task.task_id, task.input_revision).has(`${material.doc_id}@${material.version}`)) continue;
        waitingCandidates.push(material);
      }

      if (materials.length > 0 && !anyReady && waitingCandidates.length > 0) {
        for (const material of waitingCandidates) {
          this.db.getOrCreateWait(task.task_id, task.input_revision, material.doc_id, material.version, timeoutMs);
        }
        // 条件更新，避免覆写查询期间发生的取消/终态
        if (this.db.transitionTask(task.task_id, "queued", "waiting_index")) {
          this.db.appendEvent(task.task_id, "progress", { note: "waiting_index" });
        }
        continue;
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
    task: { tenant_id: string; submitted_by: string; is_admin?: number },
    docId: string,
    version: number,
  ): Promise<MaterialStatusSnapshot> {
    try {
      const status = await pipeline.docStatus(
        { tenant_id: task.tenant_id, user_id: task.submitted_by, admin: task.is_admin === 1 },
        docId,
        version,
      );
      return { ready: status.ready, status: status.status };
    } catch {
      return { ready: false, status: "unknown" };
    }
  }
}
