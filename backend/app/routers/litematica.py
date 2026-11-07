"""Litematica 投影:上传库与材料清单。"""
from __future__ import annotations

import asyncio
import io
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image

from .. import litematica as lm
from ..deps import require_helper
from ..net import client

router = APIRouter(prefix="/litematica", tags=["litematica"])

_PARSE_TASKS: set = set()


@router.get('/skins/{texture_hash}')
async def skin(texture_hash: str, _: str = Depends(require_helper)) -> Response:
    """Only official content-addressed skins; no user-controlled host/redirect."""
    if not re.fullmatch(r'[0-9a-f]{32,64}', texture_hash):
        raise HTTPException(400, '无效的皮肤纹理')
    path = lm.DATA_DIR / 'download_cache' / 'preview_skins' / f'{texture_hash}.png'
    if path.exists():
        return FileResponse(path, media_type='image/png')
    try:
        async with client(timeout=10, follow_redirects=False) as http:
            async with http.stream('GET', f'https://textures.minecraft.net/texture/{texture_hash}') as response:
                response.raise_for_status()
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 1024 * 1024:
                        raise ValueError('Skin too large')
        def normalize():
            image = Image.open(io.BytesIO(content))
            if image.width > 1024 or image.height > 1024 or image.width < 16:
                raise ValueError('Invalid skin dimensions')
            image = image.convert('RGBA')
            output = io.BytesIO()
            image.save(output, format='PNG')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(output.getvalue())
            return output.getvalue()
        return Response(await asyncio.to_thread(normalize), media_type='image/png')
    except Exception as exc:
        raise HTTPException(502, '皮肤暂时无法加载') from exc


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


@router.get("/{name}/preview")
async def preview(name: str, layer: int | None = None, region: str | None = None,
                  _: str = Depends(require_helper)) -> dict:
    path = _path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        return await asyncio.to_thread(lm.preview, path, layer, region)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"预览失败：{exc}") from exc
