"""插件安装状态缓存:把"现场扫描 plugins 目录"换成 DB 缓存 + 定时 worker 刷新。

「插件配置」读缓存即可秒回;worker 周期性扫描所有实例更新缓存;安装后即时写缓存。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .mcdr import manager
from .models import PluginScan, Server
from .plugin_manager import manager as plugins

SCAN_INTERVAL = 120  # 秒


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _scan_ids(server: Server) -> list[str]:
    inst = manager.instance_dir(server)
    return sorted({p["id"] for p in plugins.list_plugins(inst) if p.get("id")})


def _write(db: Session, server_id: int, ids: list[str]) -> None:
    row = db.get(PluginScan, server_id)
    if row is None:
        db.add(PluginScan(server_id=server_id, installed_ids=json.dumps(ids), scanned_at=_now()))
    else:
        row.installed_ids = json.dumps(ids)
        row.scanned_at = _now()
    db.commit()


def scan_server(db: Session, server: Server) -> set[str]:
    ids = _scan_ids(server)
    _write(db, server.id, ids)
    return set(ids)


def get_installed_ids(db: Session, server_id: int) -> set[str] | None:
    """读缓存;无缓存返回 None(调用方可触发一次现场扫描)。"""
    row = db.get(PluginScan, server_id)
    if row is None:
        return None
    try:
        return set(json.loads(row.installed_ids))
    except Exception:  # noqa: BLE001
        return set()


def mark_installed(db: Session, server_id: int, plugin_id: str) -> None:
    """安装后即时把插件 id 写入缓存,UI 无需等 worker。"""
    cur = get_installed_ids(db, server_id) or set()
    cur.add(plugin_id)
    _write(db, server_id, sorted(cur))


def scan_all_once() -> None:
    db = SessionLocal()
    try:
        for s in db.scalars(select(Server)).all():
            try:
                scan_server(db, s)
            except Exception:  # noqa: BLE001 - 单个实例失败不影响其它
                db.rollback()
    finally:
        db.close()


async def worker(interval: int = SCAN_INTERVAL) -> None:
    while True:
        try:
            await asyncio.to_thread(scan_all_once)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(interval)
