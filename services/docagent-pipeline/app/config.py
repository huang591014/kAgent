"""运行配置：环境变量优先，仓库根 .env 兜底（dev）。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    # 从服务目录向上找仓库根的 .env，不覆盖已有环境变量。
    here = Path(__file__).resolve()
    for parent in here.parents:
        env_file = parent / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip()
                if key and key not in os.environ:
                    os.environ[key] = value
            return


_load_dotenv()


def _get(key: str, default: str) -> str:
    value = os.environ.get(key, default)
    return value


def _get_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


@dataclass(kw_only=True)
class Settings:
    host: str = field(default_factory=lambda: _get("PIPELINE_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _get_int("PIPELINE_PORT", 8000))

    s3_endpoint: str = field(default_factory=lambda: _get("S3_ENDPOINT", "http://localhost:9000"))
    s3_access_key: str = field(default_factory=lambda: _get("S3_ACCESS_KEY", "docagent"))
    s3_secret_key: str = field(default_factory=lambda: _get("S3_SECRET_KEY", "docagent-secret"))
    s3_bucket: str = field(default_factory=lambda: _get("S3_BUCKET", "docagent"))
    s3_force_path_style: bool = field(
        default_factory=lambda: _get("S3_FORCE_PATH_STYLE", "true").lower() in ("1", "true", "yes")
    )
    # ECS 按签名 scope 的 region 路由，必须与网关配置一致（如 bsc）
    s3_region: str = field(default_factory=lambda: _get("S3_REGION", "us-east-1"))
    # 可选：部分 ECS 部署需要 x-emc-namespace 头路由到账户 namespace；留空则不注入
    s3_namespace: str = field(default_factory=lambda: _get("S3_NAMESPACE", ""))

    opensearch_url: str = field(default_factory=lambda: _get("OPENSEARCH_URL", "http://localhost:9200"))
    opensearch_user: str = field(default_factory=lambda: _get("OPENSEARCH_USER", ""))
    opensearch_password: str = field(default_factory=lambda: _get("OPENSEARCH_PASSWORD", ""))
    meta_index: str = field(default_factory=lambda: _get("OPENSEARCH_META_INDEX", "docagent-meta"))
    blocks_index: str = field(default_factory=lambda: _get("OPENSEARCH_BLOCKS_INDEX", "docagent-blocks"))

    internal_service_key: str = field(
        default_factory=lambda: _get("INTERNAL_SERVICE_KEY", "dev-internal-key")
    )

    # 解析切块目标（token 估算），见 parsers/common.py。
    chunk_target_tokens: int = field(default_factory=lambda: _get_int("CHUNK_TARGET_TOKENS", 800))
    chunk_max_tokens: int = field(default_factory=lambda: _get_int("CHUNK_MAX_TOKENS", 1200))


settings = Settings()
