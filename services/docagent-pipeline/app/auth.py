"""认证上下文（M1）：请求头携带租户与用户身份；内部服务密钥可代查。

真实身份体系接入后替换 resolve_identity 即可，其余代码只依赖 Identity。
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, Request

from .config import settings


@dataclass(kw_only=True)
class Identity:
    tenant_id: str
    user_id: str
    is_admin: bool = False
    is_internal: bool = False


def resolve_identity(
    request: Request,
    x_tenant_id: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
    x_admin: str | None = Header(default=None),
    x_internal_key: str | None = Header(default=None),
) -> Identity:
    if x_internal_key and x_internal_key == settings.internal_service_key:
        # agent 服务内部调用：服务密钥只证明调用方是 agent；
        # 被代理身份（x-user-id，即任务属主）仍按普通用户口径做材料属主校验（D1）。
        if not x_tenant_id or not x_user_id:
            raise HTTPException(status_code=401, detail="internal call missing proxied tenant/user headers")
        return Identity(
            tenant_id=x_tenant_id,
            user_id=x_user_id,
            is_admin=False,
            is_internal=True,
        )
    if not x_tenant_id or not x_user_id:
        raise HTTPException(status_code=401, detail="missing x-tenant-id / x-user-id headers")
    return Identity(
        tenant_id=x_tenant_id,
        user_id=x_user_id,
        is_admin=x_admin in ("1", "true", "yes"),
    )


def ensure_doc_access(identity: Identity, doc: dict) -> None:
    """普通用户（含 agent 代查的被代理身份）只访问自己上传的材料；
    管理员按管理范围（M1：租户内全部）可见。internal 身份不再获得管理范围。"""
    if doc.get("tenant_id") != identity.tenant_id:
        raise HTTPException(status_code=404, detail="doc not found")
    if doc.get("uploaded_by") == identity.user_id:
        return
    if not identity.is_internal and identity.is_admin:
        return
    raise HTTPException(status_code=403, detail="doc not accessible")
