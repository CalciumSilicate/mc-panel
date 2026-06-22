"""按内容哈希寻址的下载缓存,供服务端核心 / 插件 / 模组共用。

缓存目录 DATA_DIR/download_cache/:
  - <algo>_<hash>.bin   缓存文件(文件名即索引)
  - index.json          记录 hash -> {name, size}
命中相同哈希时直接复制、跳过下载;下载后校验哈希再入缓存。
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import httpx

from . import net
from .config import DATA_DIR

CACHE_DIR = DATA_DIR / "download_cache"
INDEX_PATH = CACHE_DIR / "index.json"


def _load_index() -> dict:
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def _save_index(index: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def _key(algo: str, hexhash: str) -> str:
    return f"{algo}_{hexhash}"


def compute(path: Path, algo: str = "sha1") -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def lookup(algo: str, hexhash: str) -> Path | None:
    if not hexhash:
        return None
    path = CACHE_DIR / f"{_key(algo, hexhash)}.bin"
    return path if path.exists() else None


def store(algo: str, hexhash: str, src: Path, name: str = "", size: int = 0) -> None:
    if not hexhash:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / f"{_key(algo, hexhash)}.bin"
    if not dest.exists():
        shutil.copyfile(src, dest)
    index = _load_index()
    index[_key(algo, hexhash)] = {"name": name, "size": size or dest.stat().st_size}
    _save_index(index)


async def cached_download(
    url: str,
    dest: Path,
    *,
    algo: str = "sha1",
    hexhash: str = "",
    size: int = 0,
    progress=None,
) -> None:
    """带缓存的下载:命中哈希则复制,否则下载→校验→入缓存。

    progress 回调签名 (downloaded:int, total:int)。size 优先作为总量(来自 meta)。
    """
    cached = lookup(algo, hexhash)
    if cached is not None and (size == 0 or cached.stat().st_size == size):
        shutil.copyfile(cached, dest)
        if progress:
            progress(size or cached.stat().st_size, size or cached.stat().st_size)
        return

    timeout = httpx.Timeout(30.0, read=120.0)
    async with net.client(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = size or int(resp.headers.get("content-length") or 0)
            downloaded = 0
            if progress:
                progress(0, total)
            with open(dest, "wb") as fp:
                async for chunk in resp.aiter_bytes(1 << 16):
                    fp.write(chunk)
                    downloaded += len(chunk)
                    if progress:
                        progress(downloaded, total)

    if hexhash and compute(dest, algo) != hexhash:
        raise RuntimeError("下载校验失败:哈希不匹配")
    store(algo, hexhash, dest, name=dest.name, size=size)
