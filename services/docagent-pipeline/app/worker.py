"""处理 worker：uploaded → parsing → structuring → indexing → ready（设计 §3.1）。

M1 为进程内 asyncio 队列；作业进度与状态持久化在元数据索引，
重启时扫描未完成版本重新入队。每份材料独立推进，失败记录阶段与原因。
"""

from __future__ import annotations

import asyncio
import logging

from .config import settings
from .metastore import MetaStore
from .parsers import parse_bytes
from .s3store import s3_store
from .search import BlocksIndex

logger = logging.getLogger(__name__)


class PipelineWorker:
    def __init__(self, meta: MetaStore, blocks: BlocksIndex) -> None:
        self.meta = meta
        self.blocks = blocks
        self.queue: asyncio.Queue[tuple[str, int]] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._in_flight: set[tuple[str, int]] = set()
        self._retry_counts: dict[tuple[str, int], int] = {}

    async def submit(self, doc_id: str, version: int) -> None:
        key = (doc_id, version)
        if key in self._in_flight:
            return
        await self.queue.put(key)

    def recover(self) -> int:
        """重启扫描：把仍在处理中的版本重新入队。"""
        count = 0
        for doc, version in self.meta.scan_active_jobs():
            self.queue.put_nowait((doc["doc_id"], version))
            count += 1
        if count:
            logger.info("recovered %d in-flight pipeline jobs", count)
        return count

    def start(self, concurrency: int = 2) -> None:
        for i in range(concurrency):
            self._tasks.append(asyncio.create_task(self._run_loop(i)))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    async def _run_loop(self, slot: int) -> None:
        while True:
            key = await self.queue.get()
            self._in_flight.add(key)
            try:
                await self._process(key[0], key[1])
            except Exception:
                logger.exception("pipeline job %s v%s crashed", key[0], key[1])
                try:
                    await self._fail(key[0], key[1], "worker", "处理作业异常中断", retryable=True)
                except Exception:
                    logger.exception("failed to record crash for %s v%s", key[0], key[1])
            finally:
                self._in_flight.discard(key)
                self.queue.task_done()

    async def _fail(self, doc_id: str, version: int, stage: str, reason: str, *, retryable: bool) -> None:
        await asyncio.to_thread(
            self.meta.update_version,
            doc_id,
            version,
            {"status": "failed", "error": {"stage": stage, "reason": reason, "retryable": retryable}},
        )

    async def _set_status(self, doc_id: str, version: int, status: str, **extra: object) -> None:
        await asyncio.to_thread(self.meta.update_version, doc_id, version, {"status": status, **extra})

    async def _process(self, doc_id: str, version: int) -> None:
        got = await asyncio.to_thread(self.meta.get_doc, doc_id)
        if not got:
            logger.warning("job for missing doc %s skipped", doc_id)
            return
        doc = got[0]
        ver = doc.get("versions", {}).get(str(version))
        if not ver:
            return
        if ver.get("status") in ("ready", "needs_ocr"):
            return

        await self._set_status(doc_id, version, "parsing")
        try:
            data = await asyncio.to_thread(s3_store().get, ver["object_key"])
        except Exception as exc:
            await self._fail(doc_id, version, "parsing", f"原件读取失败：{exc}", retryable=True)
            return

        try:
            parsed = await asyncio.to_thread(
                parse_bytes,
                data,
                doc.get("mime", ""),
                doc.get("filename", ""),
                target_tokens=settings.chunk_target_tokens,
                max_tokens=settings.chunk_max_tokens,
            )
        except ValueError as exc:
            await self._fail(doc_id, version, "parsing", str(exc), retryable=False)
            return
        except Exception as exc:
            await self._fail(doc_id, version, "parsing", f"解析异常：{exc}", retryable=True)
            return

        if parsed.needs_ocr:
            await self._set_status(
                doc_id,
                version,
                "needs_ocr",
                error={"stage": "parsing", "reason": "疑似扫描件，M1 暂不支持 OCR", "retryable": False},
                parse_gaps=parsed.parse_gaps,
            )
            return

        await self._set_status(doc_id, version, "structuring")
        index_docs = [b.to_index_doc() for b in parsed.blocks]

        await self._set_status(doc_id, version, "indexing")
        try:
            written = await asyncio.to_thread(
                self.blocks.index_blocks, doc=doc, version=version, blocks=index_docs
            )
        except Exception as exc:
            await self._fail(doc_id, version, "indexing", f"索引写入失败：{exc}", retryable=True)
            return

        await asyncio.to_thread(
            self.meta.update_version,
            doc_id,
            version,
            {
                "status": "ready",
                "error": None,
                "parse_gaps": parsed.parse_gaps,
                "block_count": written,
                "char_count": parsed.char_count,
            },
        )
        # 新版本完整发布后条件更新 current_version（迟到作业不覆盖新版本）
        await asyncio.to_thread(self.meta.publish_current_version, doc_id, version)

    async def retry(self, doc_id: str, version: int) -> bool:
        doc = await asyncio.to_thread(self.meta.get_doc_simple, doc_id)
        if not doc:
            return False
        ver = doc.get("versions", {}).get(str(version))
        if not ver or ver.get("status") not in ("failed",):
            return False
        self._retry_counts[(doc_id, version)] = self._retry_counts.get((doc_id, version), 0) + 1
        await self._set_status(doc_id, version, "uploaded", error=None)
        await self.submit(doc_id, version)
        return True
