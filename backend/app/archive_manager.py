"""世界存档:把实例的世界目录打包成 zip,以及从压缩包恢复。

导出始终用 zip;上传/恢复支持 zip 与 tar 系列(tar/tar.gz/tgz/tar.bz2/tar.xz),
读 DataVersion 与解压都做到格式无关。打包/恢复是阻塞 IO,放线程里跑。
"""
from __future__ import annotations

import gzip
import io
import shutil
import tarfile
import uuid
import zipfile
from pathlib import Path

import nbtlib

from .config import ARCHIVES_DIR
from .models import Server

# 支持的上传/恢复压缩扩展名(顺序:长扩展在前,便于精确匹配 .tar.gz 这类双扩展)
ARCHIVE_EXTS = (".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".tar", ".zip")


def archive_ext(name: str) -> str:
    """从文件名提取压缩扩展名(含 .tar.gz 这类双扩展);识别不出兜底 .zip。"""
    low = name.lower()
    for e in ARCHIVE_EXTS:
        if low.endswith(e):
            return e
    return ".zip"


def archive_kind(path: Path) -> str | None:
    """按内容探测压缩格式:'zip' | 'tar'(含 gz/bz2/xz);都不是返回 None。"""
    try:
        if zipfile.is_zipfile(path):
            return "zip"
        if tarfile.is_tarfile(path):  # 自动识别 gz/bz2/xz
            return "tar"
    except OSError:
        return None
    return None


def _safe_extract_tar(tf: tarfile.TarFile, dest: Path) -> None:
    """解压 tar,防路径穿越。Python 3.12+ 用 data 过滤器,旧版手工校验成员路径。"""
    try:
        tf.extractall(dest, filter="data")  # type: ignore[call-arg]
    except TypeError:
        root = dest.resolve()
        for m in tf.getmembers():
            if (dest / m.name).resolve().relative_to(root) is None:  # pragma: no cover
                raise ValueError("压缩包包含非法路径")
        tf.extractall(dest)


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


def _first_level_dat_name(names: list[str]) -> str | None:
    """从压缩包条目名里挑最靠近根的 level.dat(排除 level.dat_old)。"""
    cand = [n for n in names if n.endswith("level.dat") and not n.endswith("level.dat_old")]
    if not cand:
        return None
    return min(cand, key=lambda n: n.count("/"))


def data_version_from_archive(path: Path) -> int | None:
    """从 zip / tar 系列压缩包里读 level.dat 的 DataVersion。"""
    kind = archive_kind(path)
    try:
        if kind == "zip":
            with zipfile.ZipFile(path) as zf:
                name = _first_level_dat_name(zf.namelist())
                return read_data_version(zf.read(name)) if name else None
        if kind == "tar":
            with tarfile.open(path) as tf:
                name = _first_level_dat_name([m.name for m in tf.getmembers()])
                if not name:
                    return None
                f = tf.extractfile(name)
                return read_data_version(f.read()) if f is not None else None
    except (zipfile.BadZipFile, tarfile.TarError, OSError):
        return None
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
    """在解压目录里定位含 level.dat 的目录(包根或某子目录)。"""
    if (extract_dir / "level.dat").exists():
        return extract_dir
    for p in extract_dir.rglob("level.dat"):
        return p.parent
    return None


def restore_archive(archive_path: Path, instance_dir: Path, progress=None) -> None:
    """从压缩包(zip / tar 系列)恢复世界:解压后定位 level.dat,备份现有世界再覆盖。"""
    kind = archive_kind(archive_path)
    if kind is None:
        raise ValueError("不支持的压缩格式(支持 zip / tar / tar.gz / tar.bz2 / tar.xz)")
    target = world_dir(instance_dir)
    tmp = instance_dir / f".restore_{uuid.uuid4().hex}"
    try:
        if progress:
            progress(0, 100)
        if kind == "zip":
            with zipfile.ZipFile(archive_path) as zf:
                zf.extractall(tmp)
        else:
            with tarfile.open(archive_path) as tf:
                _safe_extract_tar(tf, tmp)
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


def new_archive_filename(orig_name: str = ".zip") -> str:
    """生成磁盘存储用文件名,保留原始压缩扩展名(供下载时还原)。"""
    return f"{uuid.uuid4().hex}{archive_ext(orig_name)}"


def archive_path(filename: str) -> Path:
    return ARCHIVES_DIR / Path(filename).name


def default_archive_name(server: Server, instance_dir: Path) -> str:
    return f"{server.name}-{world_name(instance_dir)}"
