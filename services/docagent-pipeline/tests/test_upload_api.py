"""A1 验收：真实 FastAPI 路由的上传与新版本（S3/元数据/队列用替身）。"""

from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from app import main as app_main


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self) -> None:
        pass

    def object_key(self, tenant_id: str, doc_id: str, version: int, filename: str) -> str:
        return f"tenants/{tenant_id}/docs/{doc_id}/v{version}/{filename}"

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self.objects[key] = data
        return key

    def get(self, key: str) -> bytes:
        return self.objects[key]


class FakeMeta:
    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}

    def ensure_index(self) -> None:
        pass

    def get_doc_simple(self, doc_id: str) -> dict | None:
        return self.docs.get(doc_id)

    def create_doc(self, *, doc_id, tenant_id, uploaded_by, filename, mime, size, checksum, version, object_key, job_id) -> dict:
        doc = {
            "doc_id": doc_id,
            "tenant_id": tenant_id,
            "uploaded_by": uploaded_by,
            "filename": filename,
            "mime": mime,
            "size": size,
            "checksum": checksum,
            "current_version": 0,
            "versions": {str(version): {"version": version, "object_key": object_key, "job_id": job_id, "status": "uploaded"}},
        }
        self.docs[doc_id] = doc
        return doc

    def add_version(self, *, doc: dict, version: int, object_key: str, job_id: str) -> dict:
        doc.setdefault("versions", {})[str(version)] = {
            "version": version,
            "object_key": object_key,
            "job_id": job_id,
            "status": "uploaded",
        }
        self.docs[doc["doc_id"]] = doc
        return doc


class FakeBlocks:
    def ensure_index(self) -> None:
        pass


class FakeWorker:
    def __init__(self, meta, blocks) -> None:
        self.submitted: list[tuple[str, int]] = []

    def recover(self) -> int:
        return 0

    def start(self, concurrency: int = 2) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def submit(self, doc_id: str, version: int) -> None:
        self.submitted.append((doc_id, version))


def _sync_to_awaitable(fn, *args):
    """替身 for asyncio.to_thread：同步函数也包装成可 await 的结果。"""
    import asyncio

    if asyncio.iscoroutinefunction(fn):
        return fn(*args)

    async def _done():
        return fn(*args)

    return _done()


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    fake_s3 = FakeS3()
    fake_meta = FakeMeta()
    workers: list[FakeWorker] = []

    monkeypatch.setattr(app_main, "s3_store", lambda: fake_s3)
    monkeypatch.setattr(app_main, "MetaStore", lambda: fake_meta)
    monkeypatch.setattr(app_main, "BlocksIndex", lambda: FakeBlocks())
    monkeypatch.setattr(app_main, "PipelineWorker", lambda meta, blocks: _capture(FakeWorker(meta, blocks), workers))
    monkeypatch.setattr(app_main, "asyncio_to_thread_safe", _sync_to_awaitable)

    with TestClient(app_main.app) as test_client:
        yield test_client, fake_s3, (workers[0] if workers else FakeWorker(None, None))


def _capture(worker: FakeWorker, sink: list[FakeWorker]) -> FakeWorker:
    sink.append(worker)
    return worker


HEADERS = {"x-tenant-id": "t1", "x-user-id": "u1"}


def _upload(test_client, name: str, data: bytes):
    return test_client.post(
        "/api/v1/docs",
        files={"file": (name, BytesIO(data), "application/octet-stream")},
        headers=HEADERS,
    )


def test_create_doc_returns_v1_and_enqueues(client):
    test_client, fake_s3, worker = client
    resp = _upload(test_client, "合同.docx", b"PK\x03\x04 fake docx")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == 1
    assert body["doc_id"].startswith("d_")
    assert body["job_id"].startswith("job_")
    # 原件已入 S3 且按版本寻址，作业入队
    assert len(fake_s3.objects) == 1
    key = next(iter(fake_s3.objects))
    assert f"/docs/{body['doc_id']}/v1/" in key
    assert (body["doc_id"], 1) in worker.submitted


def test_create_version_bumps_and_enqueues(client):
    test_client, fake_s3, _ = client
    first = _upload(test_client, "合同.docx", b"v1-bytes").json()
    second = test_client.post(
        f"/api/v1/docs/{first['doc_id']}/versions",
        files={"file": ("合同-v2.docx", BytesIO(b"v2-bytes-different"), "application/octet-stream")},
        headers=HEADERS,
    )
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["doc_id"] == first["doc_id"]
    assert body["version"] == 2
    # 两版原件可区分
    keys = list(fake_s3.objects.keys())
    assert any("/v1/" in k for k in keys) and any("/v2/" in k for k in keys)
    v2_key = next(k for k in keys if "/v2/" in k)
    assert fake_s3.objects[v2_key] == b"v2-bytes-different"


def test_version_upload_rejects_other_users_doc(client):
    test_client, _, _ = client
    first = _upload(test_client, "合同.docx", b"v1").json()
    other = test_client.post(
        f"/api/v1/docs/{first['doc_id']}/versions",
        files={"file": ("x.docx", BytesIO(b"x"), "application/octet-stream")},
        headers={"x-tenant-id": "t1", "x-user-id": "someone-else"},
    )
    assert other.status_code == 403


def test_upload_requires_identity(client):
    test_client, _, _ = client
    resp = test_client.post(
        "/api/v1/docs",
        files={"file": ("a.docx", BytesIO(b"x"), "application/octet-stream")},
    )
    assert resp.status_code == 401
