"""Mod management routes: local files and Modrinth installs."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from .. import mod_presets
from ..config import MOD_LIBRARY
from ..database import get_db
from ..deps import ensure_not_protected, require_helper
from ..mcdr import manager as mcdr_manager
from ..mod_manager import manager as mods
from ..models import Server

router = APIRouter(prefix="/mods", tags=["mods"])


class InstallFromLibraryBody(BaseModel):
    file_name: str


class InstallModBody(BaseModel):
    version_id: str


class CopyToBody(BaseModel):
    targets: list[int]


def _get_server(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    return server


def _refresh_preset_status(server: Server) -> None:
    mod_presets.scan_status(server)


def _copy_all(src_dir, dst_dir) -> int:
    import shutil

    if not src_dir.exists():
        return 0
    dst_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for entry in src_dir.iterdir():
        target = dst_dir / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)
        n += 1
    return n


@router.get("/server/{server_id}")
def list_installed(
    server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)
) -> list[dict]:
    server = _get_server(db, server_id)
    return mods.list_mods(mcdr_manager.instance_dir(server), server.server_type)


@router.post("/server/{server_id}/copy-to")
def copy_to(server_id: int, body: CopyToBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """Copy all managed jars from this server to selected servers."""
    src = _get_server(db, server_id)
    src_dir = mods.managed_dir(mcdr_manager.instance_dir(src), src.server_type)
    results = []
    for tid in body.targets:
        t = db.get(Server, tid)
        if t is None or tid == server_id:
            continue
        if t.protected:
            results.append({"name": t.name, "status": "error", "detail": "server protected"})
            continue
        try:
            n = _copy_all(src_dir, mods.managed_dir(mcdr_manager.instance_dir(t), t.server_type))
            _refresh_preset_status(t)
            mcdr_manager.mark_needs_restart(t.id)
            results.append({"name": t.name, "status": "ok", "detail": f"copied {n} files"})
        except Exception as exc:  # noqa: BLE001
            results.append({"name": t.name, "status": "error", "detail": str(exc)})
    return {"results": results}


@router.post("/server/{server_id}/switch/{file_name}")
def switch_mod(
    server_id: int,
    file_name: str,
    enable: bool = Query(...),
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    try:
        new_name = mods.switch_mod(mcdr_manager.instance_dir(server), file_name, enable, server.server_type)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _refresh_preset_status(server)
    mcdr_manager.mark_needs_restart(server.id)
    return {"file_name": new_name, "enabled": enable}


@router.delete("/server/{server_id}/{file_name}")
def delete_mod(
    server_id: int, file_name: str, _: str = Depends(require_helper), db: Session = Depends(get_db)
) -> dict:
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    mods.delete_mod(mcdr_manager.instance_dir(server), file_name, server.server_type)
    _refresh_preset_status(server)
    mcdr_manager.mark_needs_restart(server.id)
    return {"ok": True}


@router.post("/server/{server_id}/upload")
async def upload_mod(
    server_id: int,
    file: UploadFile = File(...),
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    content = await file.read()
    try:
        name = mods.save_upload(mcdr_manager.instance_dir(server), file.filename or "mod.jar", content, server.server_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _refresh_preset_status(server)
    mcdr_manager.mark_needs_restart(server.id)
    return {"file_name": name}


@router.get("/library")
def list_library(_: str = Depends(require_helper)) -> list[dict]:
    return mods.scan_dir(MOD_LIBRARY)


@router.post("/library/upload")
async def upload_library(file: UploadFile = File(...), _: str = Depends(require_helper)) -> dict:
    content = await file.read()
    try:
        name = mods.save_file(MOD_LIBRARY, file.filename or "mod.jar", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"file_name": name}


@router.delete("/library/{file_name}")
def delete_library(file_name: str, _: str = Depends(require_helper)) -> dict:
    mods.delete_file(MOD_LIBRARY, file_name)
    return {"ok": True}


@router.post("/server/{server_id}/install-from-library")
def install_from_library(
    server_id: int,
    body: InstallFromLibraryBody,
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    try:
        name = mods.install_from_library(MOD_LIBRARY, mcdr_manager.instance_dir(server), body.file_name, server.server_type)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _refresh_preset_status(server)
    mcdr_manager.mark_needs_restart(server.id)
    return {"file_name": name}


def _strip_disabled(n: str) -> str:
    return n[: -len(".disabled")] if n.endswith(".disabled") else n


@router.post("/library/{file_name}/replace")
async def replace_library(
    file_name: str,
    file: UploadFile = File(...),
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    """Replace a library jar and replace installed copies across servers."""
    old = next((i for i in mods.scan_dir(MOD_LIBRARY) if i["file_name"] == file_name), None)
    if old is None:
        raise HTTPException(status_code=404, detail="library file not found")
    content = await file.read()
    try:
        new_name = mods.save_file(MOD_LIBRARY, file.filename or "mod.jar", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_name != file_name:
        mods.delete_file(MOD_LIBRARY, file_name)

    old_id = old["id"]
    old_stripped = _strip_disabled(file_name)
    for server in db.scalars(select(Server)).all():
        if server.protected:
            continue
        inst = mcdr_manager.instance_dir(server)
        replaced = False
        for item in mods.list_mods(inst, server.server_type):
            if (old_id and item["id"] == old_id) or _strip_disabled(item["file_name"]) == old_stripped:
                mods.delete_mod(inst, item["file_name"], server.server_type)
                replaced = True
        if replaced:
            mods.install_from_library(MOD_LIBRARY, inst, new_name, server.server_type)
            _refresh_preset_status(server)
    return {"file_name": new_name}


@router.get("/search")
async def search_mods(
    q: str = Query(default=""),
    mc_version: str | None = Query(default=None),
    loader: str | None = Query(default=None),
    limit: int = Query(default=20),
    offset: int = Query(default=0),
    _: str = Depends(require_helper),
) -> list[dict]:
    try:
        return await mods.search_modrinth(q, mc_version, loader, limit, offset)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"search failed: {exc}") from exc


@router.get("/versions")
async def mod_versions(
    project_id: str = Query(...),
    mc_version: str | None = Query(default=None),
    loader: str | None = Query(default=None),
    _: str = Depends(require_helper),
) -> list[dict]:
    try:
        return await mods.list_versions(project_id, mc_version, loader)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"fetch versions failed: {exc}") from exc


@router.post("/server/{server_id}/install")
async def install_mod(
    server_id: int,
    body: InstallModBody,
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    inst = mcdr_manager.instance_dir(server)
    job_id = jobstore.create()

    async def task() -> None:
        try:
            name = await mods.install_from_modrinth(
                inst,
                body.version_id,
                progress=lambda d, t: jobstore.update(job_id, d, t),
                mc_version=server.mc_version,
                server_type=server.server_type,
            )
            jobstore.finish(job_id, name)
            _refresh_preset_status(server)
            mcdr_manager.mark_needs_restart(server.id)
        except Exception as exc:  # noqa: BLE001
            jobstore.fail(job_id, str(exc))

    asyncio.create_task(task())
    return {"job_id": job_id}
