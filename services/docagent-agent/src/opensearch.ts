/** 进程内 doc-retrieval：直接查询 OpenSearch 文本块（设计 §2/§4.3）。

服务端构造查询：注入任务身份与当前修订授权文档集合，
检索范围 = 当前文档权限 ∩ 当前输入修订绑定版本 ∩ 工具请求子集。
工具名 mcp__doc_retrieval__<tool>。
*/

import { config } from "./config.js";

export interface AuthorizedDoc {
  doc_id: string;
  version: number;
  label: string;
  role: string;
}

export interface SearchHit {
  doc_id: string;
  version: number;
  block_id: string;
  ordinal: number;
  kind: string;
  heading_path: string;
  snippet: string;
}

export interface SearchOutcome {
  total: number;
  hits: SearchHit[];
}

export class OpenSearchRetrieval {
  private authHeader: string | null;

  constructor() {
    this.authHeader =
      config.opensearchUser && config.opensearchPassword
        ? `Basic ${Buffer.from(`${config.opensearchUser}:${config.opensearchPassword}`).toString("base64")}`
        : null;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${config.opensearchUrl}${path}`, {
      method,
      headers: {
        ...(this.authHeader ? { authorization: this.authHeader } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenSearch ${method} ${path} -> ${resp.status}: ${text.slice(0, 400)}`);
    }
    return (await resp.json()) as T;
  }

  /** 全文检索：授权材料版本内 top-k，片段约 200 字。 */
  async search(opts: {
    tenantId: string;
    authorized: readonly AuthorizedDoc[];
    query: string;
    docIds?: string[];
    topK?: number;
  }): Promise<SearchOutcome> {
    const topK = Math.min(Math.max(1, opts.topK ?? 10), 25);
    const scope = opts.authorized.filter(
      (d) => (opts.docIds ? opts.docIds.includes(d.doc_id) : true),
    );
    if (scope.length === 0) return { total: 0, hits: [] };

    const should = scope.map((d) => ({
      bool: {
        filter: [{ term: { doc_id: d.doc_id } }, { term: { version: d.version } }],
      },
    }));
    const body = {
      size: topK,
      query: {
        bool: {
          must: [
            {
              query_string: {
                query: opts.query,
                default_field: "text",
                default_operator: "AND",
                phrase_slop: 2,
              },
            },
          ],
          filter: [{ term: { tenant_id: opts.tenantId } }, { bool: { should, minimum_should_match: 1 } }],
        },
      },
      highlight: {
        fields: { text: { fragment_size: 200, number_of_fragments: 1, pre_tags: ["["], post_tags: ["]"] } },
        order: "score",
      },
      _source: ["doc_id", "version", "block_id", "ordinal", "kind", "heading_path"],
    };
    const resp = await this.request<{ hits: { total: { value: number }; hits: Array<Record<string, unknown>> } }>(
      "POST",
      `/${config.blocksIndex}/_search`,
      body,
    );
    const hits: SearchHit[] = resp.hits.hits.map((h) => {
      const src = h._source as Record<string, unknown>;
      const highlight = (h.highlight as Record<string, string[]> | undefined)?.text;
      return {
        doc_id: String(src.doc_id),
        version: Number(src.version),
        block_id: String(src.block_id),
        ordinal: Number(src.ordinal),
        kind: String(src.kind),
        heading_path: String(src.heading_path ?? ""),
        snippet: highlight?.[0] ?? "",
      };
    });
    return { total: resp.hits.total.value, hits };
  }

  /** 按块标识/游标回读（保留表头、行序），直查块索引。 */
  async read(opts: {
    tenantId: string;
    authorized: readonly AuthorizedDoc[];
    docId: string;
    version?: number;
    blockId?: string;
    cursor?: number;
    limit?: number;
  }): Promise<{
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
    next_cursor: number | null;
    eof: boolean;
  }> {
    const target = opts.authorized.find(
      (d) => d.doc_id === opts.docId && (opts.version === undefined || d.version === opts.version),
    );
    if (!target) throw new Error(`文档不在当前授权范围：${opts.docId}`);
    const limit = Math.min(Math.max(1, opts.limit ?? 3), 10);

    if (opts.blockId) {
      try {
        const doc = await this.request<Record<string, unknown>>(
          "GET",
          `/${config.blocksIndex}/_doc/${encodeURIComponent(`${target.doc_id}_${target.version}_${opts.blockId}`)}`,
        );
        const src = doc._source as Record<string, unknown>;
        const blocks = [projectBlock(src)];
        const ordinal = Number(src.ordinal);
        return { blocks, next_cursor: ordinal, eof: false };
      } catch {
        throw new Error(`块不存在：${opts.blockId}`);
      }
    }

    const after = opts.cursor ?? 0;
    const body = {
      size: limit,
      query: {
        bool: {
          filter: [
            { term: { doc_id: target.doc_id } },
            { term: { version: target.version } },
            { term: { tenant_id: opts.tenantId } },
            { range: { ordinal: { gt: after } } },
          ],
        },
      },
      sort: [{ ordinal: "asc" }],
      _source: { excludes: ["tenant_id", "uploaded_by"] },
    };
    const resp = await this.request<{ hits: { hits: Array<Record<string, unknown>> } }>(
      "POST",
      `/${config.blocksIndex}/_search`,
      body,
    );
    const blocks = resp.hits.hits.map((h) => projectBlock(h._source as Record<string, unknown>));
    const lastOrdinal = blocks.length > 0 ? blocks[blocks.length - 1]!.ordinal : after;
    return {
      blocks,
      next_cursor: lastOrdinal,
      eof: blocks.length < limit,
    };
  }
}

function projectBlock(src: Record<string, unknown>) {
  return {
    block_id: String(src.block_id),
    ordinal: Number(src.ordinal),
    kind: String(src.kind),
    heading_path: String(src.heading_path ?? ""),
    locator: (src.locator as Record<string, unknown>) ?? {},
    text: String(src.text ?? ""),
    table_html: src.table_html ? String(src.table_html) : undefined,
    text_quality: src.text_quality ? String(src.text_quality) : undefined,
  };
}
