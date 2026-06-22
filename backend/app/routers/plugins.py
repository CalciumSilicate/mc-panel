"""MCDR 插件管理接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_settings_row, require_auth
from ..mcdr import manager as mcdr_manager
from ..models import Server
from ..plugin_manager import manager as plugins

router = APIRouter(prefix="/plugins", tags=["plugins"])


def _instance_dir(db: Session, server_id: int):
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return mcdr_manager.instance_dir(server)


class InstallPluginBody(BaseModel):
    plugin_id: str
    version: str | None = None


@router.get("/catalogue")
async def get_catalogue(
    refresh: bool = Query(default=False), _: str = Depends(require_auth)
) -> list[dict]:
    try:
        return await plugins.list_catalogue(force=refresh)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"获取插件库失败: {exc}")


@router.get("/server/{server_id}")
def list_installed(
    server_id: int, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> list[dict]:
    return plugins.list_plugins(_instance_dir(db, server_id))


@router.post("/server/{server_id}/switch/{file_name}")
def switch_plugin(
    server_id: int,
    file_name: str,
    enable: bool = Query(...),
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    inst = _instance_dir(db, server_id)
    try:
        new_name = plugins.switch_plugin(inst, file_name, enable)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"file_name": new_name, "enabled": enable}


@router.delete("/server/{server_id}/{file_name}")
def delete_plugin(
    server_id: int, file_name: str, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    plugins.delete_plugin(_instance_dir(db, server_id), file_name)
    return {"ok": True}


@router.post("/server/{server_id}/upload")
async def upload_plugin(
    server_id: int,
    file: UploadFile = File(...),
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    inst = _instance_dir(db, server_id)
    content = await file.read()
    try:
        name = plugins.save_upload(inst, file.filename or "plugin", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"file_name": name}


@router.post("/server/{server_id}/install")
async def install_plugin(
    server_id: int,
    body: InstallPluginBody,
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    inst = _instance_dir(db, server_id)
    settings = get_settings_row(db)
    try:
        return await plugins.install_from_catalogue(
            inst, body.plugin_id, body.version, settings.python_executable
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"安装失败: {exc}")
