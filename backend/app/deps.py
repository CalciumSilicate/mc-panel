"""请求级依赖:获取系统设置、校验 Bearer token。"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .config import DEFAULT_ADMIN_PASSWORD
from .database import get_db
from .models import SystemSettings
from .security import decode_token, hash_password


def get_settings_row(db: Session) -> SystemSettings:
    """读取单行系统设置;首次访问时用默认值初始化(含默认管理员密码)。"""
    row = db.get(SystemSettings, 1)
    if row is None:
        row = SystemSettings(
            id=1,
            admin_password_hash=hash_password(DEFAULT_ADMIN_PASSWORD),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def require_auth(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> str:
    """校验 ``Authorization: Bearer <token>``;返回 subject。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="未提供有效的鉴权令牌")
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    return payload["sub"]
