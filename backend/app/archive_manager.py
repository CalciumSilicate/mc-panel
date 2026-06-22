"""世界存档:把实例的世界目录打包成 zip,以及从 zip 恢复。

打包/恢复是阻塞 IO,放到线程里跑(asyncio.to_thread),通过回调上报字节进度。
"""
from __future__ import annotations

import gzip
import io
import shutil
import uuid
import zipfile
from pathlib import Path

import nbtlib

from .config import ARCHIVES_DIR
from .models import Server


def read_data_version(level_dat_bytes: bytes) -> int | None:
    """从 level.dat 字节(可能 gzip)解析 Data.DataVersion。"""
    for raw in (level_dat_bytes,):
        try:
            data = gzip.decompress(raw)
        except (OSError, EOFError):
            data = raw
        try:
            nbt = nbtlib.File.parse(io.BytesIO(data))
            section = nbt.get("Data") or nbt.get("")
            if section is not None and "DataVersion" in section:
                return int(section["DataVersion"])
        except Exception:  # noqa: BLE001
            return None
    return None


def data_version_from_world(instance_dir: Path) -> int | None:
    level = world_dir(instance_dir) / "level.dat"
    if not level.exists():
        return None
    return read_data_version(level.read_bytes())


def data_version_from_zip(zip_path: Path) -> int | None:
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = [
                n for n in zf.namelist()
                if n.endswith("level.dat") and not n.endswith("level.dat_old")
            ]
            if not names:
                return None
            name = min(names, key=lambda n: n.count("/"))
            return read_data_version(zf.read(name))
    except (zipfile.BadZipFile, OSError):
        return None


def world_name(instance_dir: Path) -> str:
    props = instance_dir / "server" / "server.properties"
    if props.exists():
        for line in props.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("level-name="):
                value = line.split("=", 1)[1].strip()
                if value:
                    return value
    return "world"


def world_dir(instance_dir: Path) -> Path:
    return instance_dir / "server" / world_name(instance_dir)


def _iter_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


def create_zip(instance_dir: Path, dest: Path, progress=None) -> int:
    """把世界目录打包到 dest(zip),返回字节数。zip 内路径以世界目录名为根。"""
    wdir = world_dir(instance_dir)
    if not wdir.exists():
        raise FileNotFoundError("世界目录不存在")
    files = _iter_files(wdir)
    total = sum(p.stat().st_size for p in files) or 1
    done = 0
    base = wdir.parent  # server/
    ARCHIVES_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        if progress:
            progress(0, total)
        for p in files:
            zf.write(p, arcname=str(p.relative_to(base)))
            done += p.stat().st_size
            if progress:
                progress(min(done, total), total)
    return dest.stat().st_size


def _find_world_root(extract_dir: Path) -> Path | None:
    """在解压目录里定位含 level.dat 的目录(zip 根或某子目录)。"""
    if (extract_dir / "level.dat").exists():
        return extract_dir
    for p in extract_dir.rglob("level.dat"):
        return p.parent
    return None


def restore_zip(archive_path: Path, instance_dir: Path, progress=None) -> None:
    """从 zip 恢复世界:备份现有世界,再把存档中的世界覆盖进去。"""
    target = world_dir(instance_dir)
    tmp = instance_dir / f".restore_{uuid.uuid4().hex}"
    try:
        if progress:
            progress(0, 100)
        with zipfile.ZipFile(archive_path) as zf:
            zf.extractall(tmp)
        if progress:
            progress(50, 100)
        src = _find_world_root(tmp)
        if src is None:
            raise ValueError("存档中未找到 level.dat")
        # 备份现有世界
        if target.exists():
            backup = target.with_name(target.name + "_backup")
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            target.rename(backup)
        shutil.copytree(src, target)
        if progress:
            progress(100, 100)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def new_archive_filename() -> str:
    return f"{uuid.uuid4().hex}.zip"


def archive_path(filename: str) -> Path:
    return ARCHIVES_DIR / Path(filename).name


def default_archive_name(server: Server, instance_dir: Path) -> str:
    return f"{server.name}-{world_name(instance_dir)}"
