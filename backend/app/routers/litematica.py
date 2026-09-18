"""Litematica 投影:上传库与材料清单。"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import litematica as lm
from ..deps import require_helper

router = APIRouter(prefix="/litematica", tags=["litematica"])

_PARSE_TASKS: set = set()


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
    _PARSE_TASKS.add(task)
    task.add_done_callback(_PARSE_TASKS.discard)
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
