"""模组管理接口(本地 + Modrinth)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import MOD_LIBRARY
from ..database import get_db
from ..deps import require_auth
from ..mcdr import manager as mcdr_manager
from ..mod_manager import manager as mods
from ..models import Server

router = APIRouter(prefix="/mods", tags=["mods"])


class InstallFromLibraryBody(BaseModel):
    file_name: str


def _get_server(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


class InstallModBody(BaseModel):
    version_id: str


@router.get("/server/{server_id}")
def list_installed(
    server_id: int, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> list[dict]:
    server = _get_server(db, server_id)
    return mods.list_mods(mcdr_manager.instance_dir(server))


@router.post("/server/{server_id}/switch/{file_name}")
def switch_mod(
    server_id: int,
    file_name: str,
    enable: bool = Query(...),
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    try:
        new_name = mods.switch_mod(mcdr_manager.instance_dir(server), file_name, enable)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"file_name": new_name, "enabled": enable}


@router.delete("/server/{server_id}/{file_name}")
def delete_mod(
    server_id: int, file_name: str, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = _get_server(db, server_id)
    mods.delete_mod(mcdr_manager.instance_dir(server), file_name)
    return {"ok": True}


@router.post("/server/{server_id}/upload")
async def upload_mod(
    server_id: int,
    file: UploadFile = File(...),
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    content = await file.read()
    try:
        name = mods.save_upload(mcdr_manager.instance_dir(server), file.filename or "mod.jar", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"file_name": name}


@router.get("/library")
def list_library(_: str = Depends(require_auth)) -> list[dict]:
    return mods.scan_dir(MOD_LIBRARY)


@router.post("/library/upload")
async def upload_library(file: UploadFile = File(...), _: str = Depends(require_auth)) -> dict:
    content = await file.read()
    try:
        name = mods.save_file(MOD_LIBRARY, file.filename or "mod.jar", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"file_name": name}


@router.delete("/library/{file_name}")
def delete_library(file_name: str, _: str = Depends(require_auth)) -> dict:
    mods.delete_file(MOD_LIBRARY, file_name)
    return {"ok": True}


@router.post("/server/{server_id}/install-from-library")
def install_from_library(
    server_id: int,
    body: InstallFromLibraryBody,
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    try:
        name = mods.install_from_library(MOD_LIBRARY, mcdr_manager.instance_dir(server), body.file_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"file_name": name}


@router.get("/search")
async def search_mods(
    q: str = Query(default=""),
    mc_version: str | None = Query(default=None),
    loader: str | None = Query(default=None),
    limit: int = Query(default=20),
    offset: int = Query(default=0),
    _: str = Depends(require_auth),
) -> list[dict]:
    try:
        return await mods.search_modrinth(q, mc_version, loader, limit, offset)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"搜索失败: {exc}")


@router.get("/versions")
async def mod_versions(
    project_id: str = Query(...),
    mc_version: str | None = Query(default=None),
    loader: str | None = Query(default=None),
    _: str = Depends(require_auth),
) -> list[dict]:
    try:
        return await mods.list_versions(project_id, mc_version, loader)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"获取版本失败: {exc}")


@router.post("/server/{server_id}/install")
async def install_mod(
    server_id: int,
    body: InstallModBody,
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    try:
        name = await mods.install_from_modrinth(mcdr_manager.instance_dir(server), body.version_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"安装失败: {exc}")
    return {"file_name": name}
