/** doc-pipeline REST 客户端：任务 API 代属主调用（设计 §3.2）。 */

import { config } from "./config.js";

export interface DocVersionStatus {
  doc_id: string;
  filename: string | null;
  mime: string | null;
  uploaded_by: string | null;
  current_version: number;
  version: number;
  status: string;
  ready: boolean;
  needs_ocr: boolean;
  error: { stage: string; reason: string; retryable: boolean } | null;
  parse_gaps: Array<{ page: number; reason: string }>;
  vector_status: string;
  block_count: number;
  char_count: number;
  job_id: string | null;
}

export interface OutlineItem {
  block_id: string;
  ordinal: number;
  kind: string;
  heading_path: string;
  chars: number;
  preview: string;
}

export interface PipelineError extends Error {
  status?: number;
  detail?: unknown;
}

async function call<T>(
  method: string,
  path: string,
  identity: { tenant_id: string; user_id: string },
  init?: { body?: unknown },
): Promise<T> {
  const url = `${config.pipelineBaseUrl}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        "x-internal-key": config.internalServiceKey,
        "x-tenant-id": identity.tenant_id,
        "x-user-id": identity.user_id,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const err = new Error(`pipeline 不可达：${(error as Error).message}`) as PipelineError;
    throw err;
  }
  if (!resp.ok) {
    let detail: unknown = null;
    try {
      detail = await resp.json();
    } catch {
      /* 非 JSON 错误体 */
    }
    const err = new Error(`pipeline ${method} ${path} -> ${resp.status}`) as PipelineError;
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  return (await resp.json()) as T;
}

export const pipeline = {
  docStatus(identity: { tenant_id: string; user_id: string }, docId: string, version?: number): Promise<DocVersionStatus> {
    const query = version !== undefined ? `?version=${version}` : "";
    return call<DocVersionStatus>("GET", `/api/v1/docs/${docId}${query}`, identity);
  },

  outline(
    identity: { tenant_id: string; user_id: string },
    docId: string,
    version: number,
  ): Promise<{ doc_id: string; version: number; filename: string | null; block_count: number; first_block_id: string | null; items: OutlineItem[] }> {
    return call("GET", `/api/v1/docs/${docId}/outline?version=${version}`, identity);
  },

  blocks(
    identity: { tenant_id: string; user_id: string },
    docId: string,
    version: number,
    after: number,
    limit: number,
  ): Promise<{
    blocks: Array<{
      block_id: string;
      ordinal: number;
      kind: string;
      heading_path: string;
      locator: Record<string, unknown>;
      text: string;
      table_html?: string;
      text_quality?: string;
    }>;
    next_cursor: string | null;
    eof: boolean;
    coverage_gaps: Array<{ page: number; reason: string }>;
  }> {
    return call("GET", `/api/v1/docs/${docId}/versions/${version}/blocks?after=${after}&limit=${limit}`, identity);
  },

  block(
    identity: { tenant_id: string; user_id: string },
    docId: string,
    version: number,
    blockId: string,
  ): Promise<{
    block_id: string;
    ordinal: number;
    kind: string;
    heading_path: string;
    locator: Record<string, unknown>;
    text: string;
    table_html?: string;
    text_quality?: string;
  }> {
    return call("GET", `/api/v1/docs/${docId}/versions/${version}/blocks/${blockId}`, identity);
  },
};
