"""服务端 jar 的本地缓存:按官方 sha1 存一份,相同 sha1 直接复用,跳过下载。

缓存目录 DATA_DIR/jar_cache/:
  - <sha1>.jar      缓存的 jar 文件(文件名即索引)
  - index.json      缓存表,记录 sha1 -> {version, size, file}(便于查看/管理)
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from .config import DATA_DIR

CACHE_DIR = DATA_DIR / "jar_cache"
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


def compute_sha1(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def lookup(sha1: str) -> Path | None:
    """按 sha1 命中缓存文件(存在则返回路径)。"""
    if not sha1:
        return None
    path = CACHE_DIR / f"{sha1}.jar"
    return path if path.exists() else None


def store(sha1: str, src: Path, version: str, size: int) -> None:
    """把下载好的 jar 存入缓存并登记到 index.json。"""
    if not sha1:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / f"{sha1}.jar"
    if not dest.exists():
        shutil.copyfile(src, dest)
    index = _load_index()
    index[sha1] = {"version": version, "size": size, "file": dest.name}
    _save_index(index)
