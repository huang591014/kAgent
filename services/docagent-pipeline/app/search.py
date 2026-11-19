"""OpenSearch 文本块索引：写入与生命周期（检索由 agent 进程内执行，见设计 §2）。"""

from __future__ import annotations

import logging

from opensearchpy import OpenSearch, helpers

from .config import settings
from .metastore import os_client

logger = logging.getLogger(__name__)


class BlocksIndex:
    def __init__(self, client: OpenSearch | None = None) -> None:
        self.client = client or os_client()
        self.index = settings.blocks_index

    def ensure_index(self) -> None:
        if not self.client.indices.exists(index=self.index):
            self.client.indices.create(
                index=self.index,
                body={
                    "settings": {"number_of_shards": 1, "number_of_replicas": 0},
                    "mappings": {
                        "properties": {
                            "doc_id": {"type": "keyword"},
                            "version": {"type": "integer"},
                            "block_id": {"type": "keyword"},
                            "ordinal": {"type": "integer"},
                            "kind": {"type": "keyword"},
                            "heading_path": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
                            "locator": {"type": "object", "enabled": False},
                            "text": {"type": "text", "analyzer": "cjk"},
                            "table_html": {"type": "text", "index": False},
                            "text_quality": {"type": "keyword"},
                            "tenant_id": {"type": "keyword"},
                            "uploaded_by": {"type": "keyword"},
                        }
                    },
                },
            )

    def index_blocks(
        self,
        *,
        doc: dict,
        version: int,
        blocks: list[dict],
    ) -> int:
        """按版本整批写入块；同版本重建时先删旧块。"""
        self.delete_version(doc["doc_id"], version)
        if not blocks:
            return 0
        actions = [
            {
                "_index": self.index,
                "_id": f"{doc['doc_id']}_{version}_{b['block_id']}",
                "_source": {
                    **b,
                    "doc_id": doc["doc_id"],
                    "version": version,
                    "tenant_id": doc["tenant_id"],
                    "uploaded_by": doc["uploaded_by"],
                },
            }
            for b in blocks
        ]
        ok, _ = helpers.bulk(self.client, actions, refresh="wait_for")
        return int(ok)

    def delete_version(self, doc_id: str, version: int) -> None:
        self.client.delete_by_query(
            index=self.index,
            body={"query": {"bool": {"filter": [{"term": {"doc_id": doc_id}}, {"term": {"version": version}}]}}},
            refresh=True,
        )

    def count_blocks(self, doc_id: str, version: int) -> int:
        resp = self.client.count(
            index=self.index,
            body={"query": {"bool": {"filter": [{"term": {"doc_id": doc_id}}, {"term": {"version": version}}]}}},
        )
        return int(resp["count"])

    def get_block(self, doc_id: str, version: int, block_id: str) -> dict | None:
        try:
            resp = self.client.get(index=self.index, id=f"{doc_id}_{version}_{block_id}")
        except Exception:
            return None
        src = dict(resp["_source"])
        src.pop("tenant_id", None)
        src.pop("uploaded_by", None)
        return src

    def list_blocks(self, doc_id: str, version: int, after_ordinal: int = 0, limit: int = 5) -> list[dict]:
        resp = self.client.search(
            index=self.index,
            body={
                "size": max(1, min(limit, 20)),
                "query": {
                    "bool": {
                        "filter": [
                            {"term": {"doc_id": doc_id}},
                            {"term": {"version": version}},
                            {"range": {"ordinal": {"gt": after_ordinal}}},
                        ]
                    }
                },
                "sort": [{"ordinal": "asc"}],
                "_source": {"excludes": ["tenant_id", "uploaded_by"]},
            },
        )
        return [hit["_source"] for hit in resp["hits"]["hits"]]

    def outline(self, doc_id: str, version: int, limit: int = 500) -> list[dict]:
        """目录与通读起点：全部块的简明投影。"""
        resp = self.client.search(
            index=self.index,
            body={
                "size": max(1, min(limit, 2000)),
                "query": {"bool": {"filter": [{"term": {"doc_id": doc_id}}, {"term": {"version": version}}]}},
                "sort": [{"ordinal": "asc"}],
                "_source": {"includes": ["block_id", "ordinal", "kind", "heading_path", "text", "text_quality"]},
            },
        )
        out = []
        for hit in resp["hits"]["hits"]:
            src = hit["_source"]
            out.append(
                {
                    "block_id": src["block_id"],
                    "ordinal": src["ordinal"],
                    "kind": src["kind"],
                    "heading_path": src.get("heading_path", ""),
                    "chars": len(src.get("text", "")),
                    "preview": (src.get("text") or "")[:60],
                }
            )
        return out
