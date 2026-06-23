"""PCRC 录像机接口:实例 CRUD + 安装 + 启停/控制台 + 录像文件。"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import pcrc
from ..database import get_db
from ..deps import require_admin, require_helper
from ..models import PcrcInstance

router = APIRouter(prefix="/pcrc", tags=["pcrc"])


def _inst(db: Session, inst_id: int) -> PcrcInstance:
    o = db.get(PcrcInstance, inst_id)
    if o is None:
        raise HTTPException(status_code=404, detail="PCRC 实例不存在")
    return o


def _to_dict(o: PcrcInstance) -> dict:
    return {
        "id": o.id, "name": o.name, "address": o.address, "port": o.port,
        "authenticate_type": o.authenticate_type, "username": o.username,
        "running": pcrc.manager.is_running(o.id),
    }


@router.get("")
def list_instances(_: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    rows = db.scalars(select(PcrcInstance)).all()
    return {"available": pcrc.pcrc_available(), "instances": [_to_dict(o) for o in rows]}


@router.post("/install")
async def install(_: str = Depends(require_admin)) -> dict:
    """安装 PCRC:pip 装其依赖 + 下载 PCRC.pyz(PCRC 不在 PyPI)。"""
    # 1) 依赖
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "pip", "install", "-U", *pcrc.PCRC_DEPS,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail="依赖安装失败:" + (out or b"").decode("utf-8", "ignore")[-400:])
    # 2) 下载 PCRC.pyz
    from .. import net

    pcrc.PCRC_PYZ.parent.mkdir(parents=True, exist_ok=True)
    try:
        async with net.client(timeout=120, follow_redirects=True) as c:
            r = await c.get(pcrc.PCRC_PYZ_URL)
            r.raise_for_status()
        pcrc.PCRC_PYZ.write_bytes(r.content)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"下载 PCRC.pyz 失败:{exc}")
    return {"ok": True, "available": pcrc.pcrc_available()}


class CreateBody(BaseModel):
    name: str
    address: str = "127.0.0.1"
    port: int = 25565
    authenticate_type: str = "offline"
    username: str = "PCRC"


@router.post("")
def create(body: CreateBody, _: str = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    if db.scalar(select(PcrcInstance).where(PcrcInstance.name == name)):
        raise HTTPException(status_code=409, detail="同名实例已存在")
    dir_name = re.sub(r"[^\w.\-]+", "_", name).strip("_").lower() or "pcrc"
    o = PcrcInstance(
        name=name, dir_name=dir_name, address=body.address.strip(), port=body.port,
        authenticate_type=body.authenticate_type, username=body.username.strip() or "PCRC",
    )
    db.add(o); db.commit(); db.refresh(o)
    pcrc.write_config(o)
    return _to_dict(o)


class UpdateBody(BaseModel):
    address: str | None = None
    port: int | None = None
    authenticate_type: str | None = None
    username: str | None = None


@router.patch("/{inst_id}")
def update(inst_id: int, body: UpdateBody, _: str = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    o = _inst(db, inst_id)
    if pcrc.manager.is_running(o.id):
        raise HTTPException(status_code=409, detail="请先停止后再修改配置")
    if body.address is not None:
        o.address = body.address.strip()
    if body.port is not None:
        o.port = body.port
    if body.authenticate_type is not None:
        o.authenticate_type = body.authenticate_type
    if body.username is not None:
        o.username = body.username.strip() or "PCRC"
    db.commit(); db.refresh(o)
    pcrc.write_config(o)
    return _to_dict(o)


@router.delete("/{inst_id}")
def delete(inst_id: int, _: str = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    o = _inst(db, inst_id)
    if pcrc.manager.is_running(o.id):
        raise HTTPException(status_code=409, detail="请先停止")
    import shutil
    shutil.rmtree(pcrc.instance_dir(o), ignore_errors=True)
    db.delete(o); db.commit()
    return {"ok": True}


@router.post("/{inst_id}/start")
def start(inst_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    o = _inst(db, inst_id)
    if not pcrc.pcrc_available():
        raise HTTPException(status_code=400, detail="尚未安装 PCRC,请先在页面点「安装 PCRC」")
    pcrc.manager.start(o)
    return {"running": True}


@router.post("/{inst_id}/stop")
def stop(inst_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    _inst(db, inst_id)
    pcrc.manager.stop(inst_id)
    return {"running": False}


class CmdBody(BaseModel):
    command: str


@router.post("/{inst_id}/command")
def command(inst_id: int, body: CmdBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    _inst(db, inst_id)
    if not pcrc.manager.is_running(inst_id):
        raise HTTPException(status_code=400, detail="实例未运行")
    pcrc.manager.send(inst_id, body.command)
    return {"ok": True}


@router.get("/{inst_id}/console")
def console(inst_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    _inst(db, inst_id)
    return {"running": pcrc.manager.is_running(inst_id), "lines": pcrc.manager.console(inst_id)}


@router.get("/{inst_id}/replays")
def replays(inst_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> list[dict]:
    o = _inst(db, inst_id)
    rec = pcrc.recordings_dir(o)
    if not rec.exists():
        return []
    out = []
    for p in sorted(rec.glob("*.mcpr"), key=lambda x: x.stat().st_mtime, reverse=True):
        out.append({"name": p.name, "size_bytes": p.stat().st_size})
    return out


def _replay_path(o: PcrcInstance, name: str) -> Path:
    base = pcrc.recordings_dir(o).resolve()
    p = (base / Path(name).name).resolve()
    if base not in p.parents:
        raise HTTPException(status_code=400, detail="非法路径")
    return p


@router.get("/{inst_id}/replays/{name}/download")
def download_replay(inst_id: int, name: str, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> FileResponse:
    o = _inst(db, inst_id)
    p = _replay_path(o, name)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="录像不存在")
    return FileResponse(path=str(p), filename=p.name, media_type="application/octet-stream")


@router.delete("/{inst_id}/replays/{name}")
def delete_replay(inst_id: int, name: str, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    o = _inst(db, inst_id)
    _replay_path(o, name).unlink(missing_ok=True)
    return {"ok": True}
