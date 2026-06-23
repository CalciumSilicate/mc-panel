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

# 持有后台建造任务的强引用,避免被 GC 回收(asyncio 已知坑)
_BUILD_TASKS: set = set()


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
        out.append({"name": p.name, "size_bytes": p.stat().st_size, "info": lm.cached_info(p)})
    return out


@router.post("/upload")
async def upload(file: UploadFile = File(...), _: str = Depends(require_helper)) -> dict:
    name = _safe_name(file.filename or "")
    lm.LIBRARY.mkdir(parents=True, exist_ok=True)
    dest = lm.LIBRARY / name
    dest.write_bytes(await file.read())
    # 大投影解析很慢(litemapy 解码),后台预热缓存,上传立即返回
    task = asyncio.create_task(asyncio.to_thread(lm.parse_and_cache, dest))
    _BUILD_TASKS.add(task)
    task.add_done_callback(_BUILD_TASKS.discard)
    return {"name": name}


@router.get("/{name}/info")
async def info(name: str, _: str = Depends(require_helper)) -> dict:
    p = _path(name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    cached = lm.cached_info(p)
    if cached is not None:
        return cached
    try:
        return await asyncio.to_thread(lm.parse_and_cache, p)
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
    p = _path(name)
    p.unlink(missing_ok=True)
    lm._cache_file(p).unlink(missing_ok=True)
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
        print(f"[litematica] build 开始: name={body.name} server={sid} offset=({body.x},{body.y},{body.z})", flush=True)
        try:
            cmds = await asyncio.to_thread(lm.generate_commands, str(p), (body.x, body.y, body.z), body.place_air)
        except Exception:  # noqa: BLE001
            import traceback
            print("[litematica] 生成指令失败:\n" + traceback.format_exc(), flush=True)
            return
        print(f"[litematica] 生成 {len(cmds)} 条指令,开始下发", flush=True)
        sent = 0
        for i, cmd in enumerate(cmds):
            if not manager.is_running(sid):
                print(f"[litematica] 服务器已停止,已发 {sent} 条后中止", flush=True)
                return
            try:
                await manager.send_raw(sid, cmd)
                sent += 1
            except Exception:  # noqa: BLE001
                import traceback
                print("[litematica] 下发失败:\n" + traceback.format_exc(), flush=True)
                return
            if i % 50 == 49:
                await asyncio.sleep(0.05)
        print(f"[litematica] 下发完成,共 {sent} 条", flush=True)

    task = asyncio.create_task(run())
    _BUILD_TASKS.add(task)
    task.add_done_callback(_BUILD_TASKS.discard)
    return {"ok": True, "started": True}
