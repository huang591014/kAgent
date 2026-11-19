"""doc-pipeline REST API（设计 §3.2 内部 API 表）。

- POST /api/v1/docs                     上传新文档（multipart）
- POST /api/v1/docs/{id}/versions       上传新版本（补件替换沿用此接口）
- GET  /api/v1/docs/{id}?version=       版本就绪状态、原因、缺口
- GET  /api/v1/docs/{id}/outline        授权后读取目录（doc_outline 底座）
- GET  /api/v1/docs/{id}/versions/{v}/blocks/{block_id}   单块回读
- GET  /api/v1/docs/{id}/versions/{v}/blocks?after=&limit= 游标批量（doc_read 底座）
- POST /api/v1/tasks/{job_id}/retry     重试失败作业（job_id 属于本服务）
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .auth import Identity, ensure_doc_access, resolve_identity
from .config import settings
from .ids import new_doc_id, new_job_id
from .metastore import MetaStore
from .s3store import checksum_of, s3_store
from .search import BlocksIndex
from .worker import PipelineWorker

logger = logging.getLogger("docagent-pipeline")
logging.basicConfig(level=logging.INFO)

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    meta = app.state.meta = MetaStore()
    blocks = app.state.blocks = BlocksIndex()
    meta.ensure_index()
    blocks.ensure_index()
    await asyncio_to_thread_safe(s3_store().ensure_bucket)
    worker = app.state.worker = PipelineWorker(meta, blocks)
    worker.recover()
    worker.start()
    yield
    await worker.stop()


def asyncio_to_thread_safe(fn, *args):
    import asyncio

    return asyncio.to_thread(fn, *args)


app = FastAPI(title="docagent-pipeline", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


def worker_of(request: Request) -> PipelineWorker:
    return request.app.state.worker


def meta_of(request: Request) -> MetaStore:
    return request.app.state.meta


def blocks_of(request: Request) -> BlocksIndex:
    return request.app.state.blocks


def _require_doc(request: Request, identity: Identity, doc_id: str) -> dict:
    doc = meta_of(request).get_doc_simple(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="doc not found")
    ensure_doc_access(identity, doc)
    return doc


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "service": "docagent-pipeline", "version": __version__}


async def _register_upload(
    request: Request,
    identity: Identity,
    file_bytes: bytes,
    filename: str,
    content_type: str,
    doc: dict | None,
) -> dict:
    meta = meta_of(request)
    worker = worker_of(request)
    mime = content_type or "application/octet-stream"

    if doc is None:
        doc_id = new_doc_id()
        version = 1
        job_id = new_job_id()
        object_key = s3_store().object_key(identity.tenant_id, doc_id, version, filename)
        meta.create_doc(
            doc_id=doc_id,
            tenant_id=identity.tenant_id,
            uploaded_by=identity.user_id,
            filename=filename,
            mime=mime,
            size=len(file_bytes),
            checksum=checksum_of(file_bytes),
            version=version,
            object_key=object_key,
            job_id=job_id,
        )
    else:
        doc_id = doc["doc_id"]
        version = max(int(v) for v in doc["versions"].keys()) + 1
        job_id = new_job_id()
        object_key = s3_store().object_key(identity.tenant_id, doc_id, version, filename)
        meta.add_version(doc=doc, version=version, object_key=object_key, job_id=job_id)

    await asyncio_to_thread_safe(s3_store().put, object_key, file_bytes, mime)
    await worker.submit(doc_id, version)
    return {"doc_id": doc_id, "version": version, "job_id": job_id, "status": "uploaded"}


@app.post("/api/v1/docs")
async def create_doc(
    request: Request,
    file: UploadFile = File(...),
    identity: Identity = Depends(resolve_identity),
) -> dict:
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="文件超出 50MB 上限")
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    return await _register_upload(request, identity, data, file.filename or "untitled", file.content_type or "")


@app.post("/api/v1/docs/{doc_id}/versions")
async def create_version(
    request: Request,
    doc_id: str,
    file: UploadFile = File(...),
    identity: Identity = Depends(resolve_identity),
) -> dict:
    doc = _require_doc(request, identity, doc_id)
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="文件超出 50MB 上限")
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    return await _register_upload(request, identity, data, file.filename or doc.get("filename", "untitled"), file.content_type or "")


@app.get("/api/v1/docs/{doc_id}")
async def get_doc_status(
    request: Request,
    doc_id: str,
    identity: Identity = Depends(resolve_identity),
    version: int | None = Query(default=None),
) -> dict:
    doc = _require_doc(request, identity, doc_id)
    resolved = version if version is not None else doc.get("current_version") or 0
    ver = doc.get("versions", {}).get(str(resolved))
    if resolved and not ver:
        raise HTTPException(status_code=404, detail=f"version {resolved} not found")
    return {
        "doc_id": doc_id,
        "filename": doc.get("filename"),
        "mime": doc.get("mime"),
        "uploaded_by": doc.get("uploaded_by"),
        "current_version": doc.get("current_version", 0),
        "version": resolved,
        "status": ver["status"] if ver else "not_uploaded",
        "ready": bool(ver and ver["status"] == "ready"),
        "needs_ocr": bool(ver and ver["status"] == "needs_ocr"),
        "error": ver.get("error") if ver else None,
        "parse_gaps": ver.get("parse_gaps", []) if ver else [],
        "vector_status": ver.get("vector_status", "disabled") if ver else "disabled",
        "block_count": ver.get("block_count", 0) if ver else 0,
        "char_count": ver.get("char_count", 0) if ver else 0,
        "job_id": ver.get("job_id") if ver else None,
    }


@app.get("/api/v1/docs/{doc_id}/outline")
async def get_outline(
    request: Request,
    doc_id: str,
    identity: Identity = Depends(resolve_identity),
    version: int = Query(...),
) -> dict:
    doc = _require_doc(request, identity, doc_id)
    ver = doc.get("versions", {}).get(str(version))
    if not ver or ver.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"version {version} not ready")
    items = blocks_of(request).outline(doc_id, version)
    return {
        "doc_id": doc_id,
        "version": version,
        "filename": doc.get("filename"),
        "block_count": len(items),
        "first_block_id": items[0]["block_id"] if items else None,
        "items": items,
    }


@app.get("/api/v1/docs/{doc_id}/versions/{version}/blocks")
async def list_blocks(
    request: Request,
    doc_id: str,
    version: int,
    identity: Identity = Depends(resolve_identity),
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=5, ge=1, le=20),
) -> dict:
    doc = _require_doc(request, identity, doc_id)
    ver = doc.get("versions", {}).get(str(version))
    if not ver or ver.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"version {version} not ready")
    items = blocks_of(request).list_blocks(doc_id, version, after, limit)
    last_ordinal = items[-1]["ordinal"] if items else after
    total = ver.get("block_count", 0)
    return {
        "blocks": items,
        "next_cursor": str(last_ordinal) if last_ordinal < total else None,
        "eof": last_ordinal >= total,
        "coverage_gaps": [g for g in ver.get("parse_gaps", [])],
    }


@app.get("/api/v1/docs/{doc_id}/versions/{version}/blocks/{block_id}")
async def get_block(
    request: Request,
    doc_id: str,
    version: int,
    block_id: str,
    identity: Identity = Depends(resolve_identity),
) -> dict:
    doc = _require_doc(request, identity, doc_id)
    ver = doc.get("versions", {}).get(str(version))
    if not ver or ver.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"version {version} not ready")
    block = blocks_of(request).get_block(doc_id, version, block_id)
    if not block:
        raise HTTPException(status_code=404, detail="block not found")
    return block


@app.post("/api/v1/tasks/{job_id}/retry")
async def retry_job(
    request: Request,
    job_id: str,
    identity: Identity = Depends(resolve_identity),
) -> dict:
    """重试指定 pipeline 作业的失败阶段（job_id 属于文档处理服务）。"""
    meta = meta_of(request)
    found: tuple[str, int] | None = None
    resp = meta.client.search(
        index=meta.index,
        body={"size": 20, "query": {"match_all": {}}},
    )
    for hit in resp["hits"]["hits"]:
        doc = hit["_source"]
        for key, ver in doc.get("versions", {}).items():
            if ver.get("job_id") == job_id:
                candidate = (doc["doc_id"], int(key))
                if identity.is_internal or (
                    doc.get("tenant_id") == identity.tenant_id
                    and (doc.get("uploaded_by") == identity.user_id or identity.is_admin)
                ):
                    found = candidate
                break
        if found:
            break
    if not found:
        raise HTTPException(status_code=404, detail="job not found")
    ok = await worker_of(request).retry(found[0], found[1])
    if not ok:
        raise HTTPException(status_code=409, detail="job is not in failed state")
    return {"doc_id": found[0], "version": found[1], "job_id": job_id, "status": "uploaded"}
