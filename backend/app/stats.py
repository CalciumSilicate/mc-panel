"""数据统计:运行中 MC 服 save-all 后读 vanilla stats JSON,精选指标去重入库。

排行榜 total=最新值,delta=最新值−窗口起点值。后台 worker 每 10 分钟扫描。
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .mcdr import manager
from .models import PlayerStat, Server

SCAN_INTERVAL = 600
_MC_TYPES = ("vanilla", "fabric", "forge")

# 精选指标(vanilla custom 命名空间下的 key) -> 中文名
METRICS: dict[str, str] = {
    "play_time": "游戏时长",
    "deaths": "死亡次数",
    "mob_kills": "击杀生物",
    "player_kills": "击杀玩家",
    "jump": "跳跃次数",
    "damage_dealt": "造成伤害",
    "walk_one_cm": "步行距离",
    "sprint_one_cm": "疾跑距离",
}

# server_id -> 上次扫描 epoch
_scanned_at: dict[int, float] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _usercache(inst_server: "object") -> dict[str, str]:
    """usercache.json: uuid(无连字符或有) -> name。"""
    from pathlib import Path

    p: "Path" = inst_server / "usercache.json"
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


def _read_player_metrics(stats_file) -> dict[str, int]:
    try:
        js = json.loads(stats_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    custom = (js.get("stats") or {}).get("minecraft:custom") or {}
    out: dict[str, int] = {}
    for key in METRICS:
        v = custom.get(f"minecraft:{key}")
        if v is None and key == "play_time":
            v = custom.get("minecraft:play_one_minute")
        if isinstance(v, (int, float)):
            out[key] = int(v)
    return out


def _last_value(db: Session, server_id: int, uuid: str, metric: str) -> int | None:
    row = db.execute(
        select(PlayerStat.value)
        .where(PlayerStat.server_id == server_id, PlayerStat.uuid == uuid, PlayerStat.metric == metric)
        .order_by(PlayerStat.ts.desc())
        .limit(1)
    ).first()
    return row[0] if row else None


def scan_server(server: Server) -> None:
    inst_server = manager.instance_dir(server) / "server"
    stats_dir = inst_server / "world" / "stats"
    if not stats_dir.exists():
        _scanned_at[server.id] = time.time()
        return
    names = _usercache(inst_server)
    db = SessionLocal()
    try:
        now = _now()
        for f in stats_dir.glob("*.json"):
            uuid = f.stem.replace("-", "").lower()
            name = names.get(uuid, uuid[:8])
            for metric, value in _read_player_metrics(f).items():
                if _last_value(db, server.id, uuid, metric) == value:
                    continue  # 去重:值未变化不插入
                db.add(PlayerStat(server_id=server.id, uuid=uuid, name=name, metric=metric, value=value, ts=now))
        db.commit()
    finally:
        db.close()
    _scanned_at[server.id] = time.time()


async def scan_server_async(server: Server) -> None:
    # 运行中先 save-all 落盘,再读
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


def leaderboard(db: Session, server_id: int, metric: str, window: str) -> list[dict]:
    """window: total / 24h / 7d / 30d。"""
    rows = db.execute(
        select(PlayerStat.uuid, PlayerStat.name, PlayerStat.value, PlayerStat.ts)
        .where(PlayerStat.server_id == server_id, PlayerStat.metric == metric)
        .order_by(PlayerStat.uuid, PlayerStat.ts.asc())
    ).all()
    # 按 uuid 聚合:latest 值 + 窗口起点值
    by_uuid: dict[str, list] = {}
    for uuid, name, value, ts in rows:
        by_uuid.setdefault(uuid, []).append((ts, value, name))
    cutoff = None
    if window != "total":
        hours = {"24h": 24, "7d": 168, "30d": 720}.get(window, 24)
        cutoff = _now() - timedelta(hours=hours)
    out = []
    for uuid, series in by_uuid.items():
        latest_ts, latest_val, name = series[-1]
        if cutoff is None:
            val = latest_val
        else:
            # 窗口起点:cutoff 之前最后一条(没有则用最早一条)
            base = series[0][1]
            for ts, v, _n in series:
                tsv = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
                if tsv <= cutoff:
                    base = v
                else:
                    break
            val = latest_val - base
        out.append({"uuid": uuid, "name": name, "value": val})
    out.sort(key=lambda x: -x["value"])
    return out


def series(db: Session, server_id: int, uuid: str, metric: str) -> list[tuple[float, int]]:
    rows = db.execute(
        select(PlayerStat.ts, PlayerStat.value)
        .where(PlayerStat.server_id == server_id, PlayerStat.uuid == uuid, PlayerStat.metric == metric)
        .order_by(PlayerStat.ts.asc())
    ).all()
    out = []
    for ts, v in rows:
        tsv = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        out.append((tsv.timestamp(), v))
    return out
