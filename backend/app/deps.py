"""请求级依赖:获取系统设置、校验 Bearer token。"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from . import net
from .config import DEFAULT_ADMIN_PASSWORD, DEFAULT_PYTHON_EXECUTABLE
from .database import get_db
from .models import SystemSettings
from .security import decode_token, hash_password

# 旧的裸默认值:遇到这些一律改用后端解释器(它装了 mcdreforged)。
_BARE_PYTHON_DEFAULTS = {"", "python", "python3"}


def get_settings_row(db: Session) -> SystemSettings:
    """读取单行系统设置;首次访问时用默认值初始化(含默认管理员密码)。"""
    row = db.get(SystemSettings, 1)
    if row is None:
        row = SystemSettings(
            id=1,
            admin_password_hash=hash_password(DEFAULT_ADMIN_PASSWORD),
            python_executable=DEFAULT_PYTHON_EXECUTABLE,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    elif row.python_executable in _BARE_PYTHON_DEFAULTS:
        # 历史数据(或裸 "python")归一化到后端解释器,避免误用没装 mcdreforged 的全局 python。
        row.python_executable = DEFAULT_PYTHON_EXECUTABLE
        db.commit()
        db.refresh(row)
    # 同步下载代理到出站客户端
    net.set_proxy(row.download_proxy)
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
