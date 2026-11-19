"""S3 / MinIO 原件存储：按租户、文档、版本保存（设计 §3.2）。"""

from __future__ import annotations

import hashlib
from functools import lru_cache

import boto3
from botocore.client import Config

from .config import settings


class S3Store:
    def __init__(self) -> None:
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path" if settings.s3_force_path_style else "virtual"}),
            region_name="us-east-1",
        )
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
