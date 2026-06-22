"""系统设置:MCDR 运行参数 + 修改管理员密码。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_settings_row, require_auth
from ..schemas import SettingsResponse, SettingsUpdate
from ..security import hash_password

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=SettingsResponse)
def get_settings(
    _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> SettingsResponse:
    row = get_settings_row(db)
    return SettingsResponse(
        python_executable=row.python_executable,
        java_command=row.java_command,
        default_min_memory=row.default_min_memory,
        default_max_memory=row.default_max_memory,
        token_expire_minutes=row.token_expire_minutes,
    )


@router.patch("", response_model=SettingsResponse)
def update_settings(
    payload: SettingsUpdate,
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> SettingsResponse:
    row = get_settings_row(db)
    if payload.python_executable is not None:
        row.python_executable = payload.python_executable
    if payload.java_command is not None:
        row.java_command = payload.java_command
    if payload.default_min_memory is not None:
        row.default_min_memory = payload.default_min_memory
    if payload.default_max_memory is not None:
        row.default_max_memory = payload.default_max_memory
    if payload.token_expire_minutes is not None:
        row.token_expire_minutes = payload.token_expire_minutes
    if payload.new_password:
        row.admin_password_hash = hash_password(payload.new_password)
    db.commit()
    db.refresh(row)
    return SettingsResponse(
        python_executable=row.python_executable,
        java_command=row.java_command,
        default_min_memory=row.default_min_memory,
        default_max_memory=row.default_max_memory,
        token_expire_minutes=row.token_expire_minutes,
    )
