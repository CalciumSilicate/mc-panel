"""Prime Backup 工具接口。"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import pb
from ..database import get_db
from ..deps import ensure_not_protected, require_helper
from ..mcdr import manager
from ..models import Server

router = APIRouter(prefix="/pb", tags=["prime-backup"])


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


@router.get("/{server_id}/overview")
async def overview(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    return await pb.overview(manager.instance_dir(_server(db, server_id)))


@router.get("/{server_id}/usage")
def usage(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    return {"bytes": pb.usage(manager.instance_dir(_server(db, server_id)))}


@router.get("/{server_id}/list")
async def backup_list(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> list[dict]:
    return await pb.backup_list(manager.instance_dir(_server(db, server_id)))


@router.get("/{server_id}/export")
async def export_backup(
    server_id: int, background_tasks: BackgroundTasks, id: int = Query(...),
    _: str = Depends(require_helper), db: Session = Depends(get_db),
) -> FileResponse:
    inst = manager.instance_dir(_server(db, server_id))
    try:
        path = await pb.export_backup(inst, id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    background_tasks.add_task(lambda p: p.unlink(missing_ok=True), path)
    return FileResponse(path=str(path), filename=f"pb_{server_id}_{id}.tar", media_type="application/x-tar")


@router.post("/{server_id}/import")
async def import_backup(
    server_id: int, file: UploadFile = File(...),
    _: str = Depends(require_helper), db: Session = Depends(get_db),
) -> dict:
    server = _server(db, server_id)
    ensure_not_protected(server)
    try:
        await pb.import_backup(manager.instance_dir(server), await file.read(), file.filename or "backup.tar")
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


class RestoreBody(BaseModel):
    backup_id: int
    target_server_id: int


@router.post("/{server_id}/restore")
async def restore(server_id: int, body: RestoreBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    source = _server(db, server_id)
    target = _server(db, body.target_server_id)
    ensure_not_protected(target)
    if manager.get_status(target) in ("running", "starting", "installing"):
        raise HTTPException(status_code=409, detail="目标服务器正在运行,请先停止")
    try:
        world = await pb.restore(manager.instance_dir(source), body.backup_id, manager.instance_dir(target))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "world_path": world}
