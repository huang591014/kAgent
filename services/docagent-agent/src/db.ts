/** 持久化存储：node:sqlite 单文件库（设计 §4.4 单进程单任务写入者）。

所有多行状态变更走显式事务；answer 接纳（§4.6）在一个事务里完成
“保存答复 → 关请求 → 递增修订 → 登记待调度”。
*/

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { InputAnswerReceipt, InputRequest, StoredMessage } from "./types.js";

export interface TaskRow {
  task_id: string;
  tenant_id: string;
  submitted_by: string;
  scenario: string;
  skill_ref: string;
  config_snapshot: string; // JSON
  status: string;
  input_revision: number;
  current_batch: string | null;
  input_closed: number; // 0/1：提问入口是否已关闭（达上限或用户选择按现有材料）
  usage: string; // JSON TaskUsage
  status_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface MaterialRow {
  task_id: string;
  revision: number;
  seq: number;
  doc_id: string;
  version: number;
  role: string;
  label: string;
  origin_kind: string; // initial | supplement
  origin_request: string | null;
}

export interface CheckpointRow {
  task_id: string;
  batch: string;
  step_no: number;
  input_revision: number;
  messages: string; // JSON StoredMessage[]
  papers: string; // JSON PapersDoc
  created_at: number;
}

export interface ResultRow {
  task_id: string;
  conclusion_md: string;
  review_outcome: string;
  used_materials: string; // JSON
  material_issues: string; // JSON
  skill_ref: string;
  input_revision: number;
  usage: string; // JSON
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT '',
  skill_ref TEXT NOT NULL,
  config_snapshot TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  input_revision INTEGER NOT NULL DEFAULT 1,
  current_batch TEXT,
  input_closed INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '{"steps":0,"input_tokens":0,"output_tokens":0,"wall_seconds":0}',
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS task_inputs (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_request TEXT,
  PRIMARY KEY (task_id, revision, seq)
);
CREATE INDEX IF NOT EXISTS idx_inputs_doc ON task_inputs(task_id, doc_id);

CREATE TABLE IF NOT EXISTS supplement_texts (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, revision)
);

CREATE TABLE IF NOT EXISTS input_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  question TEXT NOT NULL,
  impact TEXT NOT NULL,
  accepted_inputs TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  answer_identity TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  UNIQUE (task_id, tool_call_id),
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  task_id TEXT NOT NULL,
  batch TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  input_revision INTEGER NOT NULL,
  messages TEXT NOT NULL,
  papers TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, batch, step_no)
);

CREATE TABLE IF NOT EXISTS results (
  task_id TEXT PRIMARY KEY,
  conclusion_md TEXT NOT NULL,
  review_outcome TEXT NOT NULL,
  used_materials TEXT NOT NULL,
  material_issues TEXT NOT NULL,
  skill_ref TEXT NOT NULL,
  input_revision INTEGER NOT NULL,
  usage TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_files (
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, path)
);

CREATE TABLE IF NOT EXISTS skills (
  ref TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  root_path TEXT NOT NULL,
  manifest TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
`;

export class Db {
  readonly db: DatabaseSync;

  constructor(file?: string) {
    const target = file ?? path.join(config.dataDir, "agent.db");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db = new DatabaseSync(target);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭时忽略 */
    }
  }

  /** 单任务写入串行化：排队执行事务，避免并发状态交错。 */
  runExclusive<T>(taskId: string, fn: () => T): T {
    // node:sqlite 同步单连接：同步调用天然串行；此方法保留语义锚点与未来扩展位。
    void taskId;
    return fn();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 连接已失效时忽略 */
      }
      throw error;
    }
  }

  // ===== tasks =====
  getTask(taskId: string): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;
  }

  updateTask(taskId: string, patch: Partial<TaskRow>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]) as never[];
    this.db
      .prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE task_id = ?`)
      .run(...values, Date.now(), taskId);
  }

  listTasksByStatus(statuses: string[], limit = 50): TaskRow[] {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`)
      .all(...statuses, limit) as unknown as TaskRow[];
  }

  // ===== inputs =====
  materialsAt(taskId: string, revision: number): MaterialRow[] {
    return this.db
      .prepare("SELECT * FROM task_inputs WHERE task_id = ? AND revision = ? ORDER BY seq ASC")
      .all(taskId, revision) as unknown as MaterialRow[];
  }

  latestMaterials(taskId: string): MaterialRow[] {
    const task = this.getTask(taskId);
    if (!task) return [];
    return this.materialsAt(taskId, task.input_revision);
  }

  /** 复制当前修订为下一修订（接纳补件的第一步，后续按 add/remove/replace 修改）。 */
  forkInputs(taskId: string, fromRevision: number, toRevision: number): void {
    this.db
      .prepare(
        `INSERT INTO task_inputs (task_id, revision, seq, doc_id, version, role, label, origin_kind, origin_request)
         SELECT task_id, ?, seq, doc_id, version, role, label, origin_kind, origin_request
         FROM task_inputs WHERE task_id = ? AND revision = ?`,
      )
      .run(toRevision, taskId, fromRevision);
  }

  // ===== input requests =====
  getRequest(requestId: string): InputRequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM input_requests WHERE request_id = ?")
      .get(requestId) as InputRequestRow | undefined;
  }

  getRequestByToolCall(taskId: string, toolCallId: string): InputRequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM input_requests WHERE task_id = ? AND tool_call_id = ?")
      .get(taskId, toolCallId) as InputRequestRow | undefined;
  }

  openRequest(taskId: string): InputRequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM input_requests WHERE task_id = ? AND status = 'open' ORDER BY seq DESC LIMIT 1")
      .get(taskId) as InputRequestRow | undefined;
  }

  countRequests(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM input_requests WHERE task_id = ?")
      .get(taskId) as { n: number };
    return row.n;
  }

  createRequest(req: InputRequest): void {
    this.db
      .prepare(
        `INSERT INTO input_requests (request_id, task_id, tool_call_id, seq, question, impact, accepted_inputs, status, answer, answer_identity, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        req.request_id,
        req.task_id,
        req.tool_call_id,
        req.seq,
        req.question,
        req.impact,
        JSON.stringify(req.accepted_inputs),
        req.status,
        req.created_at,
      );
  }

  settleRequest(requestId: string, status: "answered" | "closed", answer: InputAnswerReceipt | null, identity: string | null): void {
    this.db
      .prepare(
        `UPDATE input_requests SET status = ?, answer = ?, answer_identity = ?, answered_at = ? WHERE request_id = ?`,
      )
      .run(status, answer ? JSON.stringify(answer) : null, identity, Date.now(), requestId);
  }

  // ===== checkpoints =====
  saveCheckpoint(row: CheckpointRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (task_id, batch, step_no, input_revision, messages, papers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.task_id, row.batch, row.step_no, row.input_revision, row.messages, row.papers, row.created_at);
  }

  latestCheckpoint(taskId: string): CheckpointRow | undefined {
    return this.db
      .prepare("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, step_no DESC LIMIT 1")
      .get(taskId) as CheckpointRow | undefined;
  }

  // ===== events =====
  appendEvent(taskId: string, type: string, data: Record<string, unknown>): { seq: number; ts: number } {
    const row = this.db
      .prepare("SELECT MAX(seq) AS max_seq FROM events WHERE task_id = ?")
      .get(taskId) as { max_seq: number | null };
    const seq = (row.max_seq ?? 0) + 1;
    const ts = Date.now();
    this.db
      .prepare("INSERT INTO events (task_id, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, seq, ts, type, JSON.stringify(data));
    return { seq, ts };
  }

  eventsAfter(taskId: string, afterSeq: number): Array<{ seq: number; ts: number; type: string; data: string }> {
    return this.db
      .prepare("SELECT seq, ts, type, data FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC")
      .all(taskId, afterSeq) as Array<{ seq: number; ts: number; type: string; data: string }>;
  }

  // ===== task workspace files =====
  getFile(taskId: string, path: string): { content: string; updated_at: number } | undefined {
    return this.db
      .prepare("SELECT content, updated_at FROM task_files WHERE task_id = ? AND path = ?")
      .get(taskId, path) as { content: string; updated_at: number } | undefined;
  }

  putFile(taskId: string, path: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO task_files (task_id, path, content, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(taskId, path, content, Date.now());
  }

  listFiles(taskId: string): string[] {
    return (
      this.db
        .prepare("SELECT path FROM task_files WHERE task_id = ? ORDER BY path ASC")
        .all(taskId) as Array<{ path: string }>
    ).map((r) => r.path);
  }

  // ===== skills =====
  upsertSkill(row: { ref: string; name: string; version: string; root_path: string; manifest: string }): void {
    this.db
      .prepare(
        `INSERT INTO skills (ref, name, version, root_path, manifest, installed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET name = excluded.name, version = excluded.version, root_path = excluded.root_path, manifest = excluded.manifest`,
      )
      .run(row.ref, row.name, row.version, row.root_path, row.manifest, Date.now());
  }

  getSkill(ref: string): SkillRow | undefined {
    return this.db.prepare("SELECT * FROM skills WHERE ref = ?").get(ref) as SkillRow | undefined;
  }

  listSkills(): SkillRow[] {
    return this.db.prepare("SELECT * FROM skills ORDER BY name ASC").all() as unknown as SkillRow[];
  }
}

export interface InputRequestRow {
  request_id: string;
  task_id: string;
  tool_call_id: string;
  seq: number;
  question: string;
  impact: string;
  accepted_inputs: string;
  status: string;
  answer: string | null;
  answer_identity: string | null;
  created_at: number;
  answered_at: number | null;
}

export interface SkillRow {
  ref: string;
  name: string;
  version: string;
  root_path: string;
  manifest: string;
  installed_at: number;
}

export const parseMessages = (json: string): StoredMessage[] => JSON.parse(json) as StoredMessage[];
