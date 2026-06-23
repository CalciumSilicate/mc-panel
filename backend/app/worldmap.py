"""世界地图:save-all 后读 playerdata NBT 的 Pos 采样玩家位置,位置变化才入库。"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import nbtlib
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .mcdr import manager
from .models import PlayerPosition, Server

SCAN_INTERVAL = 300
_MC_TYPES = ("vanilla", "fabric", "forge")
_scanned_at: dict[int, float] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _usercache(inst_server) -> dict[str, str]:
    p = inst_server / "usercache.json"
    out: dict[str, str] = {}
    if p.exists():
        try:
            for e in json.loads(p.read_text(encoding="utf-8")):
                u = str(e.get("uuid", "")).replace("-", "").lower()
                if u:
                    out[u] = str(e.get("name", ""))
        except Exception:  # noqa: BLE001
            pass
    return out


def _read_pos(dat_file):
    try:
        root = nbtlib.load(str(dat_file))
        pos = root.get("Pos")
        if not pos or len(pos) < 3:
            return None
        x, y, z = float(pos[0]), float(pos[1]), float(pos[2])
        dim = str(root.get("Dimension", "minecraft:overworld"))
        return x, y, z, dim
    except Exception:  # noqa: BLE001
        return None


def _last_pos(db: Session, server_id: int, uuid: str):
    row = db.execute(
        select(PlayerPosition.x, PlayerPosition.y, PlayerPosition.z, PlayerPosition.dim)
        .where(PlayerPosition.server_id == server_id, PlayerPosition.uuid == uuid)
        .order_by(PlayerPosition.ts.desc())
        .limit(1)
    ).first()
    return row


def scan_server(server: Server) -> None:
    inst_server = manager.instance_dir(server) / "server"
    pdata = inst_server / "world" / "playerdata"
    if not pdata.exists():
        _scanned_at[server.id] = time.time()
        return
    names = _usercache(inst_server)
    db = SessionLocal()
    try:
        now = _now()
        for f in pdata.glob("*.dat"):
            uuid = f.stem.replace("-", "").lower()
            res = _read_pos(f)
            if res is None:
                continue
            x, y, z, dim = res
            last = _last_pos(db, server.id, uuid)
            if last and abs(last[0] - x) < 0.5 and abs(last[1] - y) < 0.5 and abs(last[2] - z) < 0.5 and last[3] == dim:
                continue  # 位置基本未变,去重
            db.add(PlayerPosition(server_id=server.id, uuid=uuid, name=names.get(uuid, uuid[:8]), x=x, y=y, z=z, dim=dim, ts=now))
        db.commit()
    finally:
        db.close()
    _scanned_at[server.id] = time.time()


async def scan_server_async(server: Server) -> None:
    if manager.is_running(server.id):
        try:
            await manager.send_raw(server.id, "save-all flush")
            await asyncio.sleep(2)
        except Exception:  # noqa: BLE001
            pass
    await asyncio.to_thread(scan_server, server)


async def scan_all() -> None:
    db = SessionLocal()
    try:
        servers = [s for s in db.scalars(select(Server)).all() if s.server_type in _MC_TYPES]
    finally:
        db.close()
    for s in servers:
        try:
            await scan_server_async(s)
        except Exception:  # noqa: BLE001
            pass


async def worker(interval: int = SCAN_INTERVAL) -> None:
    while True:
        try:
            await scan_all()
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(interval)


def scanned_at(server_id: int) -> float | None:
    return _scanned_at.get(server_id)


def players(db: Session, server_id: int) -> list[dict]:
    rows = db.execute(
        select(PlayerPosition.uuid, PlayerPosition.name, PlayerPosition.ts)
        .where(PlayerPosition.server_id == server_id)
        .order_by(PlayerPosition.ts.desc())
    ).all()
    seen: dict[str, dict] = {}
    for uuid, name, _ts in rows:
        if uuid not in seen:
            seen[uuid] = {"uuid": uuid, "name": name}
    return list(seen.values())


def positions(db: Session, server_id: int, uuids: list[str], dim: str, hours: int) -> dict[str, list]:
    cutoff = _now() - timedelta(hours=hours)
    q = select(PlayerPosition.uuid, PlayerPosition.x, PlayerPosition.y, PlayerPosition.z, PlayerPosition.ts).where(
        PlayerPosition.server_id == server_id,
        PlayerPosition.dim == dim,
        PlayerPosition.ts >= cutoff,
    )
    if uuids:
        q = q.where(PlayerPosition.uuid.in_(uuids))
    q = q.order_by(PlayerPosition.uuid, PlayerPosition.ts.asc())
    out: dict[str, list] = {}
    for uuid, x, y, z, _ts in db.execute(q).all():
        out.setdefault(uuid, []).append([round(x, 1), round(y, 1), round(z, 1)])
    return out
