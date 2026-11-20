"""S3 / MinIO 原件存储：按租户、文档、版本保存（设计 §3.2）。

EMC ECS 网关（S3_NAMESPACE 非空时）：所有请求注入 x-emc-namespace 头路由到账户
namespace；网关偶发 502，标准重试模式对 5xx 自动重试。
"""

from __future__ import annotations

import hashlib
from functools import lru_cache

import boto3
from botocore.client import Config

from .config import settings


def _inject_namespace(client: boto3.client) -> None:
    if not settings.s3_namespace:
        return
    namespace = settings.s3_namespace

    def add_ns(request, **kwargs):
        request.headers["x-emc-namespace"] = namespace

    client.meta.events.register("before-sign.s3.*", add_ns)


class S3Store:
    def __init__(self) -> None:
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path" if settings.s3_force_path_style else "virtual"},
                retries={"max_attempts": 4, "mode": "standard"},
            ),
            region_name=settings.s3_region,
        )
        _inject_namespace(self._client)
        self._bucket = settings.s3_bucket

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except Exception:
            self._client.create_bucket(Bucket=self._bucket)

    def object_key(self, tenant_id: str, doc_id: str, version: int, filename: str) -> str:
        safe_name = filename.replace("\\", "_").replace("/", "_")
        return f"tenants/{tenant_id}/docs/{doc_id}/v{version}/{safe_name}"

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)
        return key

    def get(self, key: str) -> bytes:
        resp = self._client.get_object(Bucket=self._bucket, Key=key)
        return resp["Body"].read()


def checksum_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@lru_cache(maxsize=1)
def s3_store() -> S3Store:
    store = S3Store()
    return store
