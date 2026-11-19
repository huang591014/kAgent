"""ID 生成：doc/job/版本块 ID 的稳定形态。"""

from __future__ import annotations

import secrets


def new_doc_id() -> str:
    return f"d_{secrets.token_hex(8)}"


def new_job_id() -> str:
    return f"job_{secrets.token_hex(8)}"


def block_id(ordinal: int) -> str:
    """块 ID 与序号一一对应（b0001…），同一文档版本内唯一且可排序。"""
    return f"b{ordinal:04d}"
