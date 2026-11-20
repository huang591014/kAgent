/** P1-2 调度等待集合测试（可控状态替身）：
 * - 混合状态（超时 processing + failed）不再回到 waiting_index，任务收尾（回 queued）
 * - 全部 processing 且未超时 → waiting_index 并建立持久化等待
 * - 等待超时 → decideWait(timeout) + 回 queued 交还审核
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 状态替身：按 doc 返回预置 pipeline 状态
const statusMap = new Map<string, { ready: boolean; status: string }>();
vi.mock("../src/pipelineClient.js", () => ({
  pipeline: {
    docStatus: async (_identity: unknown, docId: string, version: number) => {
      const hit = statusMap.get(`${docId}@${version}`);
      if (!hit) throw new Error("not found");
      return { doc_id: docId, version, status: hit.status, ready: hit.ready };
    },
  },
}));
// runTask 替身为 no-op：本测试只验证调度决策，不执行模型
vi.mock("../src/runner/run.js", () => ({ runTask: vi.fn(async () => undefined) }));

import { Db } from "../src/db.js";
import { Scheduler } from "../src/scheduler.js";

let baseDir: string;
let db: Db;
let activeScheduler: Scheduler | null = null;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
  db = new Db(path.join(baseDir, "agent.db"));
  statusMap.clear();
  activeScheduler = null;
});

afterEach(async () => {
  // 复核要求：等在途派发收尾再关库，stop 阻止 finally 里的 kick 再触碰已关闭的 SQLite
  if (activeScheduler) {
    activeScheduler.stop();
    await activeScheduler.quiesce();
  }
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function seedTask(taskId: string, status: string): void {
  const now = Date.now();
  db.db
    .prepare(
      `INSERT INTO tasks (task_id, tenant_id, submitted_by, is_admin, scenario, skill_ref, config_snapshot, status, input_revision, current_batch, input_closed, usage, status_reason, created_at, updated_at)
       VALUES (?, 't1', 'u1', 0, '', 's@v', '{}', ?, 1, NULL, 1, '{}', NULL, ?, ?)`,
    )
    .run(taskId, status, now, now);
  let seq = 0;
  for (const doc of [["d_a", 1], ["d_b", 1]] as const) {
    seq += 1;
    db.db
      .prepare(
        `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
         VALUES (?, 1, ?, ?, ?, '材料', ?, 'initial', NULL)`,
      )
      .run(taskId, seq, doc[0], doc[1], doc[0]);
  }
}

async function tick(scheduler: Scheduler): Promise<void> {
  activeScheduler = scheduler;
  // 注入 deps（start 会起定时器，tick 前手动停掉；stopped 标志随后被 tick 使用前重置）
  scheduler.start(deps());
  scheduler.stop();
  (scheduler as unknown as { stopped: boolean }).stopped = false; // 手动 tick 需要调度生效
  await (scheduler as unknown as { tick(): Promise<void> }).tick();
  await scheduler.quiesce(); // 等 runTask 替身与后续 kick 收尾
}

function deps() {
  return {
    db,
    skills: {} as never,
    retrieval: {} as never,
    activeRuns: new Map<string, AbortController>(),
  };
}

describe("P1-2 调度等待集合", () => {
  it("混合状态（A 超时的 processing + B failed）→ 不再回 waiting_index，回 queued 收尾", async () => {
    seedTask("t_mixed", "waiting_index");
    statusMap.set("d_a@1", { ready: false, status: "indexing" });
    statusMap.set("d_b@1", { ready: false, status: "failed" });
    // A 已被判定超时（先建等待行再标记）
    const now = Date.now();
    db.db
      .prepare("INSERT INTO index_waits (task_id, input_revision, doc_id, version, since, deadline, decided) VALUES ('t_mixed', 1, 'd_a', 1, ?, ?, 'timeout')")
      .run(now - 20_000, now - 10_000);

    const scheduler = new Scheduler(db);
    await tick(scheduler);
    await tick(scheduler); // 第二轮验证不会弹回 waiting_index

    expect(db.getTask("t_mixed")!.status).toBe("queued");
  });

  it("全部 processing 且未超时 → waiting_index 并持久化等待记录", async () => {
    seedTask("t_wait", "queued");
    statusMap.set("d_a@1", { ready: false, status: "parsing" });
    statusMap.set("d_b@1", { ready: false, status: "indexing" });

    const scheduler = new Scheduler(db);
    await tick(scheduler);

    expect(db.getTask("t_wait")!.status).toBe("waiting_index");
    const waits = db.db.prepare("SELECT COUNT(*) AS n FROM index_waits WHERE task_id = 't_wait'").get() as { n: number };
    expect(waits.n).toBe(2);
  });

  it("等待截止已到 → 记 timeout 并回 queued 交还审核（其余材料已失败，无等待价值）", async () => {
    seedTask("t_deadline", "waiting_index");
    statusMap.set("d_a@1", { ready: false, status: "parsing" });
    statusMap.set("d_b@1", { ready: false, status: "failed" }); // d_b 退出等待集合
    // 预置一条已过截止的等待记录
    const now = Date.now();
    db.db
      .prepare("INSERT INTO index_waits (task_id, input_revision, doc_id, version, since, deadline, decided) VALUES ('t_deadline', 1, 'd_a', 1, ?, ?, NULL)")
      .run(now - 20_000, now - 10_000);

    const scheduler = new Scheduler(db);
    await tick(scheduler);

    expect(db.getTask("t_deadline")!.status).toBe("queued");
    expect(db.timedOutDocs("t_deadline", 1).has("d_a@1")).toBe(true);
  });

  it("条件转移：已取消的 waiting_index 任务不被覆写回 queued", async () => {
    seedTask("t_cancel", "cancelled");
    statusMap.set("d_a@1", { ready: true, status: "ready" });

    const scheduler = new Scheduler(db);
    await tick(scheduler);

    expect(db.getTask("t_cancel")!.status).toBe("cancelled");
  });

  it("P1-2 复核：主合同已就绪不唤醒等待纪要的任务（活跃等待只含纪要）", async () => {
    seedTask("t_focus", "waiting_index");
    statusMap.set("d_a@1", { ready: true, status: "ready" }); // 主合同：就绪，但不是等待对象
    statusMap.set("d_b@1", { ready: false, status: "indexing" }); // 纪要：仍在处理
    const now = Date.now();
    // 活跃等待记录只有纪要
    db.db
      .prepare("INSERT INTO index_waits (task_id, input_revision, doc_id, version, since, deadline, decided) VALUES ('t_focus', 1, 'd_b', 1, ?, ?, NULL)")
      .run(now - 1000, now + 600_000);

    const scheduler = new Scheduler(db);
    await tick(scheduler);
    await tick(scheduler); // 连续两轮

    // 任务保持 waiting_index：主合同状态无关唤醒；不派发即不消耗模型步数
    expect(db.getTask("t_focus")!.status).toBe("waiting_index");
  });

  it("P1-2 复核：等待的纪要就绪才唤醒（活跃等待记 ready）", async () => {
    seedTask("t_ready", "waiting_index");
    statusMap.set("d_a@1", { ready: true, status: "ready" });
    statusMap.set("d_b@1", { ready: true, status: "ready" });
    const now = Date.now();
    db.db
      .prepare("INSERT INTO index_waits (task_id, input_revision, doc_id, version, since, deadline, decided) VALUES ('t_ready', 1, 'd_b', 1, ?, ?, NULL)")
      .run(now - 1000, now + 600_000);

    const scheduler = new Scheduler(db);
    await tick(scheduler);

    expect(db.getTask("t_ready")!.status).toBe("queued");
    const decided = db.db
      .prepare("SELECT decided FROM index_waits WHERE task_id = 't_ready' AND doc_id = 'd_b'")
      .get() as { decided: string };
    expect(decided.decided).toBe("ready");
  });
});

void deps;
