"""世界存档管理接口。"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import archive_manager as am
from .. import jobs as jobstore
from .. import superflat
from ..database import SessionLocal, get_db
from ..deps import ensure_not_protected, require_auth, require_helper, require_operate, role_at_least
from ..mcdr import manager as mcdr_manager
from ..models import Archive, Server, User
from ..schemas import ArchiveOut

router = APIRouter(prefix="/archives", tags=["archives"])


class ArchiveUpdate(BaseModel):
    name: str | None = None
    mc_version: str | None = None


def _get_server(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


def _get_archive(db: Session, archive_id: int) -> Archive:
    arc = db.get(Archive, archive_id)
    if arc is None:
        raise HTTPException(status_code=404, detail="存档不存在")
    return arc


def _ensure_own_or_helper(user: User, arc: Archive) -> None:
    """user 角色只能操作自己上传的存档;helper 及以上不限。"""
    if not role_at_least(user, "helper") and arc.owner_user_id != user.id:
        raise HTTPException(status_code=403, detail="只能操作自己上传的存档")


@router.get("", response_model=list[ArchiveOut])
def list_archives(_: str = Depends(require_auth), db: Session = Depends(get_db)) -> list[Archive]:
    return list(db.scalars(select(Archive).order_by(Archive.id.desc())).all())


async def _do_create(server_id: int, filename: str, job_id: str, owner_user_id: int) -> None:
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
        if server is None:
            jobstore.fail(job_id, "服务器不存在")
            return
        inst = mcdr_manager.instance_dir(server)
        try:
            size = await asyncio.to_thread(
                am.create_zip, inst, am.archive_path(filename),
                lambda d, t: jobstore.update(job_id, d, t),
            )
        except Exception as exc:  # noqa: BLE001
            am.archive_path(filename).unlink(missing_ok=True)
            jobstore.fail(job_id, str(exc))
            return
        # 优先用世界 level.dat 的 DataVersion 反推版本,失败再用服务器版本
        dv = am.data_version_from_world(inst)
        mc_version = superflat.version_for_data_version(dv) if dv else server.mc_version
        db.add(Archive(
            name=am.default_archive_name(server, inst),
            filename=filename,
            size=size,
            source="server",
            source_server_id=server_id,
            mc_version=mc_version or server.mc_version,
            owner_user_id=owner_user_id,
        ))
        db.commit()
        jobstore.finish(job_id, filename)
    finally:
        db.close()


@router.post("/from-server/{server_id}")
async def create_from_server(
    server_id: int, user: User = Depends(require_helper), db: Session = Depends(get_db)
) -> dict:
    server = _get_server(db, server_id)
    if mcdr_manager.get_status(server) in ("running", "starting", "installing"):
        raise HTTPException(status_code=400, detail="请先停止实例再创建存档")
    job_id = jobstore.create()
    asyncio.create_task(_do_create(server_id, am.new_archive_filename(), job_id, user.id))
    return {"job_id": job_id}


@router.post("/upload", response_model=ArchiveOut)
async def upload_archive(
    file: UploadFile = File(...),
    mc_version: str = Form(default=""),
    user: User = Depends(require_operate),
    db: Session = Depends(get_db),
) -> Archive:
    name = file.filename or "archive.zip"
    if not name.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持 .zip 存档")
    filename = am.new_archive_filename()
    dest = am.archive_path(filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    dest.write_bytes(content)
    # 优先从上传的 level.dat 读 DataVersion 反推版本
    dv = am.data_version_from_zip(dest)
    detected = superflat.version_for_data_version(dv) if dv else ""
    rec = Archive(
        name=name[:-4], filename=filename, size=len(content),
        source="uploaded", mc_version=detected or mc_version.strip(),
        owner_user_id=user.id,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return rec


@router.patch("/{archive_id}", response_model=ArchiveOut)
def update_archive(
    archive_id: int,
    body: ArchiveUpdate,
    user: User = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Archive:
    arc = _get_archive(db, archive_id)
    _ensure_own_or_helper(user, arc)
    if body.name is not None and body.name.strip():
        arc.name = body.name.strip()
    if body.mc_version is not None:
        arc.mc_version = body.mc_version.strip()
    db.commit()
    db.refresh(arc)
    return arc


@router.get("/{archive_id}/download")
def download_archive(
    archive_id: int, user: User = Depends(require_auth), db: Session = Depends(get_db)
) -> FileResponse:
    arc = _get_archive(db, archive_id)
    _ensure_own_or_helper(user, arc)
    path = am.archive_path(arc.filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail="存档文件丢失")
    return FileResponse(path, media_type="application/zip", filename=f"{arc.name}.zip")


@router.delete("/{archive_id}")
def delete_archive(
    archive_id: int, user: User = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    arc = _get_archive(db, archive_id)
    _ensure_own_or_helper(user, arc)
    am.archive_path(arc.filename).unlink(missing_ok=True)
    db.delete(arc)
    db.commit()
    return {"ok": True}


async def _do_restore(archive_id: int, server_id: int, job_id: str) -> None:
    db = SessionLocal()
    try:
        arc = db.get(Archive, archive_id)
        server = db.get(Server, server_id)
        if arc is None or server is None:
            jobstore.fail(job_id, "存档或服务器不存在")
            return
        inst = mcdr_manager.instance_dir(server)
        try:
            await asyncio.to_thread(
                am.restore_zip, am.archive_path(arc.filename), inst,
                lambda d, t: jobstore.update(job_id, d, t),
            )
        except Exception as exc:  # noqa: BLE001
            jobstore.fail(job_id, str(exc))
            return
        jobstore.finish(job_id)
    finally:
        db.close()


@router.post("/{archive_id}/restore/{server_id}")
async def restore_archive(
    archive_id: int, server_id: int, _: object = Depends(require_operate), db: Session = Depends(get_db)
) -> dict:
    _get_archive(db, archive_id)
    server = _get_server(db, server_id)
    ensure_not_protected(server)
    if mcdr_manager.get_status(server) in ("running", "starting", "installing"):
        raise HTTPException(status_code=400, detail="请先停止目标实例再恢复存档")
    job_id = jobstore.create()
    asyncio.create_task(_do_restore(archive_id, server_id, job_id))
    return {"job_id": job_id}
