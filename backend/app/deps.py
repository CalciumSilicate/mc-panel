"""请求级依赖:系统设置、当前用户、角色门禁。"""
from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from . import net
from .config import DEFAULT_PYTHON_EXECUTABLE
from .database import get_db
from .models import SystemSettings, User
from .security import decode_token

# 角色等级:数值越大权限越高
ROLE_ORDER = {"user": 1, "helper": 2, "admin": 3, "owner": 4}

# 旧的裸默认值:遇到这些一律改用后端解释器(它装了 mcdreforged)。
_BARE_PYTHON_DEFAULTS = {"", "python", "python3"}


def get_settings_row(db: Session) -> SystemSettings:
    """读取单行系统设置;首次访问时用默认值初始化。"""
    row = db.get(SystemSettings, 1)
    if row is None:
        row = SystemSettings(id=1, python_executable=DEFAULT_PYTHON_EXECUTABLE)
        db.add(row)
        db.commit()
        db.refresh(row)
    elif row.python_executable in _BARE_PYTHON_DEFAULTS:
        row.python_executable = DEFAULT_PYTHON_EXECUTABLE
        db.commit()
        db.refresh(row)
    net.set_proxy(row.download_proxy)
    return row


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """校验 Bearer token 并返回当前用户(以数据库中的角色为准)。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_token(authorization.split(" ", 1)[1].strip())
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="令牌无效")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


# 任意已登录用户
require_auth = get_current_user


def require_role(min_role: str) -> Callable[..., User]:
    threshold = ROLE_ORDER[min_role]

    def dependency(user: User = Depends(get_current_user)) -> User:
        if ROLE_ORDER.get(user.role, 0) < threshold:
            raise HTTPException(status_code=403, detail="权限不足")
        return user

    return dependency


require_helper = require_role("helper")
require_admin = require_role("admin")
require_owner = require_role("owner")


def role_at_least(user: User, min_role: str) -> bool:
    return ROLE_ORDER.get(user.role, 0) >= ROLE_ORDER[min_role]
