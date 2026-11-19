"""OpenSearch 元数据存储：文档身份、版本、处理状态（设计 §3.2）。

状态与错误是低频小写入，使用 refresh="wait_for" 保证读侧立即可见；
current_version 条件更新用 seq_no/primary_term 乐观并发，迟到作业不能覆盖新版本。
"""

from __future__ import annotations

import time
from typing import Any

from opensearchpy import OpenSearch

from .config import settings

# 版本状态机（needs_ocr 归入"暂不可读"终态，可由补件替换解决）
ACTIVE_STATUSES = ("uploaded", "parsing", "structuring", "indexing")
TERMINAL_STATUSES = ("ready", "failed", "needs_ocr")


def os_client() -> OpenSearch:
    return OpenSearch(
        hosts=[settings.opensearch_url],
        http_auth=(settings.opensearch_user, settings.opensearch_password)
        if settings.opensearch_user
        else None,
        use_ssl=settings.opensearch_url.startswith("https"),
        verify_certs=False,
    )


class MetaStore:
    def __init__(self, client: OpenSearch | None = None) -> None:
        self.client = client or os_client()
        self.index = settings.meta_index

    def ensure_index(self) -> None:
        if not self.client.indices.exists(index=self.index):
            self.client.indices.create(
                index=self.index,
                body={
                    "mappings": {
                        "properties": {
                            "doc_id": {"type": "keyword"},
                            "tenant_id": {"type": "keyword"},
                            "uploaded_by": {"type": "keyword"},
                            "filename": {"type": "keyword"},
                            "mime": {"type": "keyword"},
                            "current_version": {"type": "integer"},
                            "created_at": {"type": "date", "format": "epoch_second"},
                        }
                    }
                },
            )

    def create_doc(
        self,
        *,
        doc_id: str,
        tenant_id: str,
        uploaded_by: str,
        filename: str,
        mime: str,
        size: int,
        checksum: str,
        version: int,
        object_key: str,
        job_id: str,
    ) -> dict:
        now = int(time.time())
        doc = {
            "doc_id": doc_id,
            "tenant_id": tenant_id,
            "uploaded_by": uploaded_by,
            "filename": filename,
            "mime": mime,
            "size": size,
            "checksum": checksum,
            "current_version": 0,
            "created_at": now,
            "versions": {
                str(version): _new_version(version, object_key, job_id, now),
            },
        }
        self.client.index(index=self.index, id=doc_id, body=doc, refresh="wait_for")
        return doc

    def add_version(
        self,
        *,
        doc: dict,
        version: int,
        object_key: str,
        job_id: str,
    ) -> dict:
        now = int(time.time())
        doc.setdefault("versions", {})[str(version)] = _new_version(version, object_key, job_id, now)
        self._save(doc)
        return doc

    def get_doc(self, doc_id: str, refresh: bool = True) -> dict | None:
        try:
            resp = self.client.get(index=self.index, id=doc_id, refresh=refresh or None)
        except Exception:
            return None
        return resp["_source"], resp.get("_seq_no"), resp.get("_primary_term")  # type: ignore[return-value]

    def get_doc_simple(self, doc_id: str) -> dict | None:
        result = self.get_doc(doc_id)
        return result[0] if result else None

    def update_version(self, doc_id: str, version: int, patch: dict[str, Any]) -> dict | None:
        """更新某版本的处理状态；带 seq_no 并发保护，冲突时报错由调用方重试。"""
        for _ in range(3):
            got = self.get_doc(doc_id)
            if not got:
                return None
            doc, seq_no, primary_term = got
            ver = doc.get("versions", {}).get(str(version))
            if not ver:
                return None
            ver.update(patch)
            ver["updated_at"] = int(time.time())
            try:
                self.client.index(
                    index=self.index,
                    id=doc_id,
                    body=doc,
                    if_seq_no=seq_no,
                    if_primary_term=primary_term,
                    refresh="wait_for",
                )
                return doc
            except Exception:
                continue
        raise RuntimeError(f"meta update conflict on doc {doc_id} v{version}")

    def publish_current_version(self, doc_id: str, version: int) -> dict | None:
        """新版本完整发布后条件更新 current_version；迟到作业不能覆盖更新的版本。"""
        for _ in range(3):
            got = self.get_doc(doc_id)
            if not got:
                return None
            doc, seq_no, primary_term = got
            if doc.get("current_version", 0) >= version:
                return doc
            doc["current_version"] = version
            try:
                self.client.index(
                    index=self.index,
                    id=doc_id,
                    body=doc,
                    if_seq_no=seq_no,
                    if_primary_term=primary_term,
                    refresh="wait_for",
                )
                return doc
            except Exception:
                continue
        raise RuntimeError(f"current_version publish conflict on doc {doc_id} v{version}")

    def scan_active_jobs(self) -> list[tuple[dict, int]]:
        """重启恢复：找出仍在处理中的 (doc, version)。versions 是动态对象，
        直接拉全量文档后在应用侧过滤（M1 规模下足够小）。"""
        resp = self.client.search(
            index=self.index,
            body={"size": 500, "query": {"match_all": {}}, "track_total_hits": True},
        )
        out: list[tuple[dict, int]] = []
        for hit in resp["hits"]["hits"]:
            doc = hit["_source"]
            for key, ver in doc.get("versions", {}).items():
                if ver.get("status") in ACTIVE_STATUSES:
                    out.append((doc, int(key)))
        return out

    def _save(self, doc: dict) -> None:
        self.client.index(index=self.index, id=doc["doc_id"], body=doc, refresh="wait_for")


def _new_version(version: int, object_key: str, job_id: str, now: int) -> dict:
    return {
        "version": version,
        "object_key": object_key,
        "job_id": job_id,
        "status": "uploaded",
        "error": None,
        "parse_gaps": [],
        "vector_status": "disabled",
        "block_count": 0,
        "char_count": 0,
        "created_at": now,
        "updated_at": now,
    }
