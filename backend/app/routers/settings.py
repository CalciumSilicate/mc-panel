"""系统设置:MCDR 运行参数 + Java 安装池 + 下载代理 + 注册开关(admin+)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_settings_row, require_admin
from ..java import detect_installs, get_java_paths, set_java_paths
from ..schemas import JavaInstall, SettingsResponse, SettingsUpdate

router = APIRouter(prefix="/settings", tags=["settings"])


def _to_response(row) -> SettingsResponse:
    installs = [JavaInstall(**i) for i in detect_installs(get_java_paths(row))]
    return SettingsResponse(
        python_executable=row.python_executable,
        java_command=row.java_command,
        default_min_memory=row.default_min_memory,
        default_max_memory=row.default_max_memory,
        token_expire_minutes=row.token_expire_minutes,
        download_proxy=row.download_proxy,
        allow_register=row.allow_register,
        java_installs=installs,
    )


@router.get("", response_model=SettingsResponse)
def get_settings(_: object = Depends(require_admin), db: Session = Depends(get_db)) -> SettingsResponse:
    return _to_response(get_settings_row(db))


@router.patch("", response_model=SettingsResponse)
def update_settings(
    payload: SettingsUpdate,
    _: object = Depends(require_admin),
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
    if payload.download_proxy is not None:
        row.download_proxy = payload.download_proxy.strip()
    if payload.allow_register is not None:
        row.allow_register = payload.allow_register
    if payload.java_paths is not None:
        set_java_paths(row, payload.java_paths)
    db.commit()
    db.refresh(row)
    return _to_response(row)
