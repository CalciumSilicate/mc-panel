"""MCDR plugin management routes."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from .. import plugin_scan
from ..config import PLUGIN_LIBRARY
from ..database import SessionLocal, get_db
from ..deps import ensure_not_protected, get_settings_row, require_helper
from ..mcdr import manager as mcdr_manager
from ..models import Server
from ..plugin_manager import manager as plugins

router = APIRouter(prefix="/plugins", tags=["plugins"])


class InstallFromLibraryBody(BaseModel):
    file_name: str


class InstallPluginBody(BaseModel):
    plugin_id: str
    version: str | None = None


class CopyToBody(BaseModel):
    targets: list[int]


def _instance_dir(db: Session, server_id: int):
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    return mcdr_manager.instance_dir(server)


def _writable_instance_dir(db: Session, server_id: int):
    """Return writable instance dir and reject protected servers."""
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="server not found")
    ensure_not_protected(server)
    return mcdr_manager.instance_dir(server)


def _refresh_scan(db: Session, server_id: int) -> None:
    server = db.get(Server, server_id)
    if server is not None:
        plugin_scan.scan_server(db, server)


@router.get("/catalogue")
async def get_catalogue(
    refresh: bool = Query(default=False), _: str = Depends(require_helper)
) -> list[dict]:
    try:
        return await plugins.list_catalogue(force=refresh)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"fetch plugin catalogue failed: {exc}") from exc


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
    return plugins.list_plugins(_instance_dir(db, server_id))


@router.post("/server/{server_id}/copy-to")
def copy_to(server_id: int, body: CopyToBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """Copy all MCDR plugins from this server to selected servers."""
    src_dir = plugins.plugins_dir(_instance_dir(db, server_id))
    results = []
    for tid in body.targets:
        t = db.get(Server, tid)
        if t is None or tid == server_id:
            continue
        if t.protected:
            results.append({"name": t.name, "status": "error", "detail": "server protected"})
            continue
        try:
            n = _copy_all(src_dir, plugins.plugins_dir(mcdr_manager.instance_dir(t)))
            plugin_scan.scan_server(db, t)
            results.append({"name": t.name, "status": "ok", "detail": f"copied {n} plugins"})
        except Exception as exc:  # noqa: BLE001
            results.append({"name": t.name, "status": "error", "detail": str(exc)})
    return {"results": results}


@router.post("/server/{server_id}/switch/{file_name}")
def switch_plugin(
    server_id: int,
    file_name: str,
    enable: bool = Query(...),
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    inst = _writable_instance_dir(db, server_id)
    try:
        new_name = plugins.switch_plugin(inst, file_name, enable)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _refresh_scan(db, server_id)
    return {"file_name": new_name, "enabled": enable}


@router.delete("/server/{server_id}/{file_name}")
def delete_plugin(
    server_id: int, file_name: str, _: str = Depends(require_helper), db: Session = Depends(get_db)
) -> dict:
    plugins.delete_plugin(_writable_instance_dir(db, server_id), file_name)
    _refresh_scan(db, server_id)
    return {"ok": True}


@router.post("/server/{server_id}/upload")
async def upload_plugin(
    server_id: int,
    file: UploadFile = File(...),
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    inst = _writable_instance_dir(db, server_id)
    content = await file.read()
    try:
        name = plugins.save_upload(inst, file.filename or "plugin", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _refresh_scan(db, server_id)
    return {"file_name": name}


@router.get("/library")
def list_library(_: str = Depends(require_helper)) -> list[dict]:
    return plugins.scan_dir(PLUGIN_LIBRARY)


@router.post("/library/upload")
async def upload_library(
    file: UploadFile = File(...), _: str = Depends(require_helper)
) -> dict:
    content = await file.read()
    try:
        name = plugins.save_file(PLUGIN_LIBRARY, file.filename or "plugin", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"file_name": name}


@router.delete("/library/{file_name}")
def delete_library(file_name: str, _: str = Depends(require_helper)) -> dict:
    plugins.delete_file(PLUGIN_LIBRARY, file_name)
    return {"ok": True}


@router.post("/server/{server_id}/install-from-library")
def install_from_library(
    server_id: int,
    body: InstallFromLibraryBody,
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    inst = _writable_instance_dir(db, server_id)
    try:
        name = plugins.install_from_library(PLUGIN_LIBRARY, inst, body.file_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _refresh_scan(db, server_id)
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
    """Replace a library plugin file and replace installed copies across servers."""
    old = next((i for i in plugins.scan_dir(PLUGIN_LIBRARY) if i["file_name"] == file_name), None)
    if old is None:
        raise HTTPException(status_code=404, detail="library file not found")
    content = await file.read()
    try:
        new_name = plugins.save_file(PLUGIN_LIBRARY, file.filename or "plugin", content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if new_name != file_name:
        plugins.delete_file(PLUGIN_LIBRARY, file_name)

    old_id = old["id"]
    old_stripped = _strip_disabled(file_name)
    for server in db.scalars(select(Server)).all():
        if server.protected:
            continue
        inst = mcdr_manager.instance_dir(server)
        replaced = False
        for item in plugins.list_plugins(inst):
            if (old_id and item["id"] == old_id) or _strip_disabled(item["file_name"]) == old_stripped:
                plugins.delete_plugin(inst, item["file_name"])
                replaced = True
        if replaced:
            plugins.install_from_library(PLUGIN_LIBRARY, inst, new_name)
            plugin_scan.scan_server(db, server)
    return {"file_name": new_name}


@router.post("/server/{server_id}/install")
async def install_plugin(
    server_id: int,
    body: InstallPluginBody,
    _: str = Depends(require_helper),
    db: Session = Depends(get_db),
) -> dict:
    inst = _writable_instance_dir(db, server_id)
    settings = get_settings_row(db)
    job_id = jobstore.create()

    async def task() -> None:
        try:
            result = await plugins.install_from_catalogue(
                inst,
                body.plugin_id,
                body.version,
                settings.python_executable,
                progress=lambda d, t: jobstore.update(job_id, d, t),
            )
            jobstore.finish(job_id, result["file_name"])
            db2 = SessionLocal()
            try:
                _refresh_scan(db2, server_id)
            finally:
                db2.close()
        except Exception as exc:  # noqa: BLE001
            jobstore.fail(job_id, str(exc))

    asyncio.create_task(task())
    return {"job_id": job_id}
