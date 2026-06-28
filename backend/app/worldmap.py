"""世界地图:通过 RCON 采集在线玩家实时位置。

走 RCON(``data get entity <name> Pos/Dimension``)而非读 playerdata NBT /
``save-all``:命令与返回不经过 MCDR 控制台,不污染 stdin/stdout 与日志。
仅对「已启用 RCON 且正在运行」的实例采集;未启用 RCON 的实例不显示世界地图。
位置变化才入库(去重)。
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .mcdr import manager
from .models import PlayerPosition, Server
from .rcon import RconClient, RconError

SCAN_INTERVAL = 10
_MC_TYPES = ("vanilla", "fabric", "forge")
_scanned_at: dict[int, float] = {}

# data get entity <name> Pos  ->  "... has the following entity data: [12.3d, 64.0d, -8.0d]"
_POS_RE = re.compile(r"\[\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*\]")
# data get entity <name> Dimension  ->  '... entity data: "minecraft:overworld"'
_DIM_RE = re.compile(r'"([^"]+)"')


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _usercache(inst_server) -> dict[str, str]:
    """读 usercache.json,返回 uuid(无连字符,小写) -> name。"""
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


def _last_pos(db: Session, server_id: int, uuid: str):
    row = db.execute(
        select(PlayerPosition.x, PlayerPosition.y, PlayerPosition.z, PlayerPosition.dim)
        .where(PlayerPosition.server_id == server_id, PlayerPosition.uuid == uuid)
        .order_by(PlayerPosition.ts.desc())
        .limit(1)
    ).first()
    return row


def _parse_online(text: str) -> list[str]:
    """解析 vanilla ``list`` 输出末尾的玩家名列表。"""
    idx = text.find("online:")
    if idx < 0:
        return []
    tail = text[idx + len("online:"):].strip()
    return [n.strip() for n in tail.split(",") if n.strip()]


def _parse_pos(text: str):
    m = _POS_RE.search(text)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2)), float(m.group(3))


def _parse_dim(text: str) -> str:
    m = _DIM_RE.search(text)
    return m.group(1) if m else "minecraft:overworld"


async def _collect(server: Server) -> list[tuple]:
    """RCON 连一次,拉在线玩家及其坐标/维度。返回 (uuid, name, x, y, z, dim) 列表。"""
    names = _usercache(manager.instance_dir(server) / "server")  # uuid->name
    name_to_uuid = {v.lower(): k for k, v in names.items() if v}
    out: list[tuple] = []
    try:
        async with RconClient("127.0.0.1", server.rcon_port, server.rcon_password) as rc:
            online = _parse_online(await rc.command("list"))
            for name in online:
                try:
                    pos = _parse_pos(await rc.command(f"data get entity {name} Pos"))
                    if pos is None:
                        continue
                    dim = _parse_dim(await rc.command(f"data get entity {name} Dimension"))
                except RconError:
                    continue  # 单个玩家失败不影响其它
                # 拿不到 uuid 时用名字小写兜底,保证轨迹 key 稳定
                uuid = name_to_uuid.get(name.lower(), "") or name.lower()
                out.append((uuid, name, pos[0], pos[1], pos[2], dim))
    except RconError:
        return []
    return out


def _persist(server_id: int, samples: list[tuple]) -> None:
    db = SessionLocal()
    try:
        now = _now()
        for uuid, name, x, y, z, dim in samples:
            last = _last_pos(db, server_id, uuid)
            if (
                last
                and abs(last[0] - x) < 0.5
                and abs(last[1] - y) < 0.5
                and abs(last[2] - z) < 0.5
                and last[3] == dim
            ):
                continue  # 位置基本未变,去重
            db.add(
                PlayerPosition(
                    server_id=server_id, uuid=uuid, name=name, x=x, y=y, z=z, dim=dim, ts=now
                )
            )
        db.commit()
    finally:
        db.close()


async def scan_server_async(server: Server) -> None:
    """对单个实例采集一次(仅当已启用 RCON 且运行中)。"""
    if not getattr(server, "rcon_enabled", False) or not manager.is_running(server.id):
        _scanned_at[server.id] = time.time()
        return
    samples = await _collect(server)
    if samples:
        await asyncio.to_thread(_persist, server.id, samples)
    _scanned_at[server.id] = time.time()


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
