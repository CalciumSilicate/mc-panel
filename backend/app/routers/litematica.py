"""Litematica 投影:上传库 + 解析材料 + 生成指令并节流下发到服务器控制台。"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import litematica as lm
from ..database import get_db
from ..deps import ensure_not_protected, require_helper
from ..mcdr import manager
from ..models import Server

router = APIRouter(prefix="/litematica", tags=["litematica"])


def _safe_name(name: str) -> str:
    base = Path(name).name
    if not base.endswith(".litematic"):
        raise HTTPException(status_code=400, detail="仅支持 .litematic 文件")
    base = re.sub(r"[^\w.\-]+", "_", base)
    return base


def _path(name: str) -> Path:
    p = (lm.LIBRARY / _safe_name(name)).resolve()
    if lm.LIBRARY.resolve() not in p.parents:
        raise HTTPException(status_code=400, detail="非法路径")
    return p


@router.get("")
def list_files(_: str = Depends(require_helper)) -> list[dict]:
    lm.LIBRARY.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(lm.LIBRARY.glob("*.litematic")):
        out.append({"name": p.name, "size_bytes": p.stat().st_size})
    return out


@router.post("/upload")
async def upload(file: UploadFile = File(...), _: str = Depends(require_helper)) -> dict:
    name = _safe_name(file.filename or "")
    lm.LIBRARY.mkdir(parents=True, exist_ok=True)
    dest = lm.LIBRARY / name
    dest.write_bytes(await file.read())
    try:
        info = lm.parse_info(dest)
    except Exception as exc:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"解析失败:{exc}")
    return {"name": name, "info": info}


@router.get("/{name}/info")
def info(name: str, _: str = Depends(require_helper)) -> dict:
    p = _path(name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        return lm.parse_info(p)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"解析失败:{exc}")


@router.get("/{name}/download")
def download(name: str, _: str = Depends(require_helper)) -> FileResponse:
    p = _path(name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path=str(p), filename=name, media_type="application/octet-stream")


@router.delete("/{name}")
def delete(name: str, _: str = Depends(require_helper)) -> dict:
    _path(name).unlink(missing_ok=True)
    return {"ok": True}


class BuildBody(BaseModel):
    name: str
    server_id: int
    x: int = 0
    y: int = 0
    z: int = 0
    place_air: bool = False


@router.post("/build")
async def build(body: BuildBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    server = db.get(Server, body.server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    ensure_not_protected(server)
    if not manager.is_running(server.id):
        raise HTTPException(status_code=400, detail="目标服务器未运行")
    p = _path(body.name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="投影文件不存在")
    sid = server.id

    async def run() -> None:
        # 解析(CPU 密集)放线程池,避免阻塞事件循环导致全站卡顿
        try:
            cmds = await asyncio.to_thread(lm.generate_commands, str(p), (body.x, body.y, body.z), body.place_air)
        except Exception:  # noqa: BLE001
            logging.getLogger("mcpanel.litematica").exception("生成投影指令失败: %s", body.name)
            return
        # 节流逐条下发,避免刷屏卡服
        for i, cmd in enumerate(cmds):
            if not manager.is_running(sid):
                break
            try:
                await manager.send_raw(sid, cmd)
            except Exception:  # noqa: BLE001
                logging.getLogger("mcpanel.litematica").exception("下发指令失败")
                break
            if i % 10 == 9:
                await asyncio.sleep(0.2)
        logging.getLogger("mcpanel.litematica").info("投影 %s 下发完成,共 %d 条", body.name, len(cmds))

    asyncio.create_task(run())
    return {"ok": True, "started": True}
