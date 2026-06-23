"""Prime Backup 工具:把实例里的 PB 插件文件当 CLI 跑,做概览/列表/导出/导入/恢复。

PB 插件本体即一个可执行 CLI:``python prime_backup.pyz -d <pb_files> <子命令>``。
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from sqlalchemy import select

from .config import DATA_DIR
from .database import SessionLocal
from .mcdr import manager
from .models import Server
from .plugin_manager import manager as plugins

PB_PLUGIN_ID = "prime_backup"
_TEMP = DATA_DIR / "tmp"
SCAN_INTERVAL = 600  # 10 分钟

# server_id -> {overview, backups, usage, scanned_at}
_cache: dict[int, dict] = {}


def pb_dir(instance_dir: Path) -> Path:
    return instance_dir / "pb_files"


def cli_path(instance_dir: Path) -> Path | None:
    pdir = plugins.plugins_dir(instance_dir)
    for p in plugins.scan_dir(pdir):
        if p.get("id") == PB_PLUGIN_ID:
            return pdir / p["file_name"]
    return None


async def run_pb(cli: Path, storage: Path, args: list[str]) -> tuple[int, str, str]:
    from .deps import get_settings_row
    from .database import SessionLocal

    db = SessionLocal()
    try:
        python = get_settings_row(db).python_executable
    finally:
        db.close()
    proc = await asyncio.create_subprocess_exec(
        python, str(cli), "-d", str(storage), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(cli.parent),
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode("utf-8", "ignore"), err.decode("utf-8", "ignore")


def parse_overview(text: str) -> dict:
    o: dict = {}
    patterns = {
        "storage_root": r"Storage root set to '([^']+)'",
        "db_version": r"DB version: (\d+)",
        "backup_amount": r"Backup (?:count|amount): (\d+)",
        "db_path": r"DB path: (.+)$",
        "db_file_size": r"DB file size: (\d+)",
        "blob_stored_size": r"Blob stored size sum: (\d+)",
        "blob_raw_size": r"Blob raw size sum: (\d+)",
    }
    for line in text.splitlines():
        for key, pat in patterns.items():
            m = re.search(pat, line)
            if m:
                v = m.group(1).strip()
                o[key] = int(v) if v.isdigit() else v
    return o


def parse_list(text: str) -> list[dict]:
    items: list[dict] = []
    rx = re.compile(
        r"id=(\d+)\s+date='([^']+)'\s+stored_size=(\d+)\s+raw_size=(\d+)\s+creator='([^']*)'\s+comment='([^']*)'"
    )
    for line in text.splitlines():
        m = rx.search(line)
        if m:
            items.append({
                "id": int(m.group(1)), "date": m.group(2),
                "stored_size": int(m.group(3)), "raw_size": int(m.group(4)),
                "creator": m.group(5), "comment": m.group(6),
            })
    return items


def _dir_size(p: Path) -> int:
    total = 0
    for dp, _dn, fns in os.walk(p):
        for fn in fns:
            try:
                total += (Path(dp) / fn).stat().st_size
            except OSError:
                pass
    return total


def usage(instance_dir: Path) -> int:
    d = pb_dir(instance_dir)
    return _dir_size(d) if d.exists() else 0


async def overview(instance_dir: Path) -> dict:
    storage = pb_dir(instance_dir)
    cli = cli_path(instance_dir)
    base = {"storage_root": str(storage), "backup_amount": 0}
    if cli is None or not storage.exists():
        return base
    rc, out, err = await run_pb(cli, storage, ["overview"])
    if rc != 0:
        return base
    return parse_overview(out + "\n" + err) or base


async def backup_list(instance_dir: Path) -> list[dict]:
    storage = pb_dir(instance_dir)
    cli = cli_path(instance_dir)
    if cli is None or not storage.exists():
        return []
    rc, out, err = await run_pb(cli, storage, ["list"])
    return parse_list(out + "\n" + err) if rc == 0 else []


async def export_backup(instance_dir: Path, backup_id: int) -> Path:
    storage = pb_dir(instance_dir)
    cli = cli_path(instance_dir)
    if cli is None or not storage.exists():
        raise RuntimeError("该实例未安装 Prime Backup 或没有备份库")
    _TEMP.mkdir(parents=True, exist_ok=True)
    out_path = _TEMP / f"pb_{backup_id}_{uuid.uuid4().hex}.tar"
    rc, out, err = await run_pb(cli, storage, ["export", str(backup_id), str(out_path)])
    if rc != 0 or not out_path.exists():
        raise RuntimeError(f"导出失败:{err or out}")
    return out_path


async def import_backup(instance_dir: Path, content: bytes, filename: str, auto_meta: bool = True) -> None:
    storage = pb_dir(instance_dir)
    cli = cli_path(instance_dir)
    if cli is None:
        raise RuntimeError("该实例未安装 Prime Backup")
    storage.mkdir(parents=True, exist_ok=True)
    _TEMP.mkdir(parents=True, exist_ok=True)
    tmp = _TEMP / f"imp_{uuid.uuid4().hex}_{Path(filename).name}"
    tmp.write_bytes(content)
    try:
        args = ["import", str(tmp)] + (["--auto-meta"] if auto_meta else [])
        rc, out, err = await run_pb(cli, storage, args)
        if rc != 0:
            raise RuntimeError(f"导入失败:{err or out}")
    finally:
        tmp.unlink(missing_ok=True)


async def restore(source_inst: Path, backup_id: int, target_inst: Path) -> str:
    """提取备份并把世界替换到目标实例 server/world(目标须已停)。"""
    storage = pb_dir(source_inst)
    cli = cli_path(source_inst)
    if cli is None or not storage.exists():
        raise RuntimeError("源实例没有 Prime Backup 备份库")
    _TEMP.mkdir(parents=True, exist_ok=True)
    temp_out = _TEMP / f"pbrestore_{uuid.uuid4().hex}"
    temp_out.mkdir(parents=True, exist_ok=True)
    try:
        rc, out, err = await run_pb(cli, storage, ["extract", str(backup_id), ".", "-o", str(temp_out), "-r"])
        if rc != 0:
            raise RuntimeError(f"提取失败:{err or out}")
        world_dir: Path | None = None
        for dp, _dn, fns in os.walk(temp_out):
            if "level.dat" in fns:
                world_dir = Path(dp)
                break
        if world_dir is None:
            raise RuntimeError("备份中未找到 level.dat")
        server_folder = target_inst / "server"
        server_folder.mkdir(parents=True, exist_ok=True)
        target_world = server_folder / "world"
        if target_world.exists():
            shutil.move(str(target_world), str(server_folder / f"world_backup_{uuid.uuid4().hex[:8]}"))
        shutil.move(str(world_dir), str(target_world))
        return str(target_world)
    finally:
        shutil.rmtree(temp_out, ignore_errors=True)


# ---------- 缓存 + 定时刷新 ----------
async def scan_one(server: Server) -> dict:
    inst = manager.instance_dir(server)
    ov = await overview(inst)
    bl = await backup_list(inst)
    us = await asyncio.to_thread(usage, inst)
    data = {"overview": ov, "backups": bl, "usage": us, "scanned_at": time.time()}
    _cache[server.id] = data
    return data


def get_cached(server_id: int) -> dict | None:
    return _cache.get(server_id)


async def scan_all() -> None:
    db = SessionLocal()
    try:
        servers = list(db.scalars(select(Server)).all())
    finally:
        db.close()
    for s in servers:
        try:
            await scan_one(s)
        except Exception:  # noqa: BLE001
            pass


async def worker(interval: int = SCAN_INTERVAL) -> None:
    while True:
        try:
            await scan_all()
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(interval)
