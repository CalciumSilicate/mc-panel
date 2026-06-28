"""Vanilla stats ingestion and query helpers.

Two cadences are used:
- important metrics: every aligned 10-minute boundary
- full metrics: every aligned hour

All stats are read from ``server/world/stats/*.json``. Running servers are
flushed first; RCON is preferred and stdin is used as the fallback by
``manager.send_cmd``.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .mcdr import manager
from .models import PlayerMetric, Server, StatJsonRead, StatMetric

IMPORTANT_INTERVAL = 600
FULL_INTERVAL = 3600
_MC_TYPES = ("vanilla", "fabric", "forge")

IMPORTANT_METRICS: dict[str, str] = {
    "custom.play_time": "游戏时长",
    "custom.play_one_minute": "游戏时长",
    "custom.deaths": "死亡次数",
    "custom.mob_kills": "击杀生物",
    "custom.player_kills": "击杀玩家",
    "custom.jump": "跳跃次数",
    "custom.damage_dealt": "造成伤害",
    "custom.walk_one_cm": "步行距离",
    "custom.sprint_one_cm": "疾跑距离",
}

METRIC_ALIASES = {
    "play_time": "custom.play_time",
    "deaths": "custom.deaths",
    "mob_kills": "custom.mob_kills",
    "player_kills": "custom.player_kills",
    "jump": "custom.jump",
    "damage_dealt": "custom.damage_dealt",
    "walk_one_cm": "custom.walk_one_cm",
    "sprint_one_cm": "custom.sprint_one_cm",
}

LABELS: dict[str, str] = {
    **IMPORTANT_METRICS,
    "custom.leave_game": "离开游戏",
    "custom.play_time": "游戏时长",
    "custom.time_since_death": "距上次死亡",
    "custom.total_world_time": "世界时间",
    "custom.fly_one_cm": "飞行距离",
    "custom.swim_one_cm": "游泳距离",
    "custom.climb_one_cm": "攀爬距离",
    "custom.fall_one_cm": "坠落距离",
    "custom.aviate_one_cm": "鞘翅飞行距离",
}

HIGH_FREQUENCY_PATTERNS = sorted(set(IMPORTANT_METRICS) | {"custom.play_one_minute"})
WHITELIST_PATTERNS = ["*"]
BLACKLIST_PATTERNS: list[str] = []

_scanned_at: dict[int, float] = {}
_scope_scanned_at: dict[tuple[int, str], float] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _next_boundary(step: int) -> float:
    now = int(time.time())
    return float(((now // step) + 1) * step)


async def _sleep_until_boundary(step: int) -> None:
    await asyncio.sleep(max(0.1, _next_boundary(step) - time.time()))


def _normalize_metric(metric: str) -> str:
    metric = metric.strip()
    if metric in METRIC_ALIASES:
        return METRIC_ALIASES[metric]
    if metric.startswith("minecraft:"):
        try:
            left, right = metric.split(".", 1)
            _ns1, cat = left.split(":", 1)
            _ns2, item = right.split(":", 1)
            return f"{cat}.{item}"
        except ValueError:
            return metric
    return metric


def _full_key(metric: str) -> str:
    if "." not in metric:
        return metric
    cat, item = metric.split(".", 1)
    return f"minecraft:{cat}.minecraft:{item}"


def _matches(metric: str, patterns: Iterable[str]) -> bool:
    full = _full_key(metric)
    return any(fnmatch.fnmatch(metric, p) or fnmatch.fnmatch(full, p) for p in patterns)


def sample_type(metric: str) -> str:
    metric = _normalize_metric(metric)
    if _matches(metric, BLACKLIST_PATTERNS):
        return "ignored"
    if _matches(metric, HIGH_FREQUENCY_PATTERNS):
        return "important"
    if _matches(metric, WHITELIST_PATTERNS):
        return "normal"
    return "ignored"


def _label(metric: str) -> str:
    metric = _normalize_metric(metric)
    if metric in LABELS:
        return LABELS[metric]
    if "." in metric:
        cat, item = metric.split(".", 1)
        return f"{cat}.{item}"
    return metric


def _stats_dir(server: Server) -> Path:
    return manager.instance_dir(server) / "server" / "world" / "stats"


def _usercache(inst_server: Path) -> dict[str, str]:
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


def _metrics_from_json(js: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    stats = js.get("stats") or {}
    for cat_ns, items in stats.items():
        if not isinstance(items, dict) or ":" not in cat_ns:
            continue
        ns, cat = cat_ns.split(":", 1)
        if ns != "minecraft":
            continue
        for item_ns, value in items.items():
            if not isinstance(value, (int, float)) or ":" not in item_ns:
                continue
            item_ns_part, item = item_ns.split(":", 1)
            if item_ns_part == "minecraft":
                out[f"{cat}.{item}"] = int(value)
    if "custom.play_time" not in out and "custom.play_one_minute" in out:
        out["custom.play_time"] = out["custom.play_one_minute"]
    return out


def _read_mtime(db: Session, server_id: int, scope: str, filename: str) -> StatJsonRead | None:
    return db.execute(
        select(StatJsonRead).where(
            StatJsonRead.server_id == server_id,
            StatJsonRead.scope == scope,
            StatJsonRead.filename == filename,
        )
    ).scalar_one_or_none()


def _mark_read(db: Session, server_id: int, scope: str, filename: str, mtime: int) -> None:
    row = _read_mtime(db, server_id, scope, filename)
    if row is None:
        row = StatJsonRead(server_id=server_id, scope=scope, filename=filename, last_mtime=mtime, updated_at=_now())
        db.add(row)
    else:
        row.last_mtime = mtime
        row.updated_at = _now()


def _last_total(db: Session, server_id: int, uuid: str, metric: str) -> int | None:
    row = db.execute(
        select(PlayerMetric.total)
        .where(PlayerMetric.server_id == server_id, PlayerMetric.uuid == uuid, PlayerMetric.metric == metric)
        .order_by(PlayerMetric.ts.desc())
        .limit(1)
    ).first()
    return int(row[0]) if row else None


def _upsert_metric_dim(db: Session, metric: str, stype: str) -> None:
    cat, item = metric.split(".", 1) if "." in metric else ("custom", metric)
    row = db.execute(select(StatMetric).where(StatMetric.key == metric)).scalar_one_or_none()
    if row is None:
        db.add(
            StatMetric(
                key=metric,
                category=cat,
                item=item,
                label=_label(metric),
                sample_type=stype,
                updated_at=_now(),
            )
        )
    else:
        row.label = row.label or _label(metric)
        row.sample_type = stype
        row.updated_at = _now()


def scan_server(server: Server, scope: str = "important", target_ts: datetime | None = None) -> int:
    stats_dir = _stats_dir(server)
    if not stats_dir.exists():
        _scanned_at[server.id] = time.time()
        _scope_scanned_at[(server.id, scope)] = _scanned_at[server.id]
        return 0

    wanted = {"important"} if scope == "important" else {"important", "normal"}
    names = _usercache(manager.instance_dir(server) / "server")
    db = SessionLocal()
    written = 0
    try:
        ts = target_ts or _now()
        for f in sorted(stats_dir.glob("*.json")):
            mtime = int(f.stat().st_mtime)
            read_row = _read_mtime(db, server.id, scope, f.name)
            if read_row is not None and mtime <= int(read_row.last_mtime or 0):
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                _mark_read(db, server.id, scope, f.name, mtime)
                continue

            uuid = f.stem.replace("-", "").lower()
            name = names.get(uuid, uuid[:8])
            for metric, total in _metrics_from_json(data).items():
                stype = sample_type(metric)
                _upsert_metric_dim(db, metric, stype)
                if stype not in wanted:
                    continue
                prev = _last_total(db, server.id, uuid, metric)
                delta = 0 if prev is None else total - prev
                if prev == total:
                    continue
                db.add(
                    PlayerMetric(
                        server_id=server.id,
                        uuid=uuid,
                        name=name,
                        metric=metric,
                        total=total,
                        delta=delta,
                        sample_type=stype,
                        ts=ts,
                    )
                )
                written += 1
            _mark_read(db, server.id, scope, f.name, mtime)
        db.commit()
    finally:
        db.close()
    _scanned_at[server.id] = time.time()
    _scope_scanned_at[(server.id, scope)] = _scanned_at[server.id]
    return written


async def scan_server_async(server: Server, scope: str = "important", target_ts: datetime | None = None) -> int:
    if manager.is_running(server.id):
        try:
            rcon_port = server.rcon_port if server.rcon_enabled else 0
            await manager.send_cmd(server.id, "save-all flush", rcon_port, server.rcon_password)
            await asyncio.sleep(2 if scope == "important" else 1)
        except Exception:  # noqa: BLE001
            pass
    return await asyncio.to_thread(scan_server, server, scope, target_ts)


async def scan_all(scope: str = "important", target_ts: datetime | None = None) -> None:
    db = SessionLocal()
    try:
        servers = [s for s in db.scalars(select(Server)).all() if s.server_type in _MC_TYPES]
    finally:
        db.close()
    for server in servers:
        try:
            await scan_server_async(server, scope, target_ts)
        except Exception:  # noqa: BLE001
            pass


async def worker() -> None:
    important_task = asyncio.create_task(_cadence_loop("important", IMPORTANT_INTERVAL))
    full_task = asyncio.create_task(_cadence_loop("full", FULL_INTERVAL))
    try:
        await asyncio.gather(important_task, full_task)
    finally:
        important_task.cancel()
        full_task.cancel()


async def _cadence_loop(scope: str, interval: int) -> None:
    await _sleep_until_boundary(interval)
    while True:
        boundary = datetime.fromtimestamp(int(time.time()) - (int(time.time()) % interval), timezone.utc)
        try:
            await scan_all(scope, boundary)
        except Exception:  # noqa: BLE001
            pass
        await _sleep_until_boundary(interval)


def scanned_at(server_id: int, scope: str | None = None) -> float | None:
    if scope:
        return _scope_scanned_at.get((server_id, scope))
    return _scanned_at.get(server_id)


def list_metrics(db: Session, q: str = "", category: str = "all", limit: int = 200) -> list[dict]:
    rows = db.scalars(select(StatMetric).order_by(StatMetric.sample_type, StatMetric.key)).all()
    if not rows:
        for metric in sorted(set(HIGH_FREQUENCY_PATTERNS)):
            rows.append(
                StatMetric(
                    key=metric,
                    category=metric.split(".", 1)[0],
                    item=metric.split(".", 1)[1],
                    label=_label(metric),
                    sample_type=sample_type(metric),
                )
            )
    ql = q.strip().lower()
    out = []
    for row in rows:
        if category != "all" and row.sample_type != category:
            continue
        if ql and ql not in row.key.lower() and ql not in (row.label or "").lower():
            continue
        out.append({"key": row.key, "label": row.label or _label(row.key), "sample_type": row.sample_type})
        if len(out) >= limit:
            break
    return out


def _metric_list(metrics: Iterable[str]) -> list[str]:
    return [_normalize_metric(m) for m in metrics if m.strip()]


def leaderboard(db: Session, server_id: int, metrics: list[str], window: str, limit: int = 100) -> list[dict]:
    metric_keys = _metric_list(metrics)
    if not metric_keys:
        return []
    rows = db.execute(
        select(PlayerMetric.uuid, PlayerMetric.name, PlayerMetric.metric, PlayerMetric.total, PlayerMetric.delta, PlayerMetric.ts)
        .where(PlayerMetric.server_id == server_id, PlayerMetric.metric.in_(metric_keys))
        .order_by(PlayerMetric.uuid, PlayerMetric.metric, PlayerMetric.ts.asc())
    ).all()
    cutoff = None
    if window != "total":
        hours = {"24h": 24, "7d": 168, "30d": 720, "1y": 8760}.get(window, 24)
        cutoff = _now() - timedelta(hours=hours)

    by_player: dict[str, dict] = {}
    by_key: dict[tuple[str, str], list] = {}
    for uuid, name, metric, total, delta, ts in rows:
        by_player.setdefault(uuid, {"uuid": uuid, "name": name, "value": 0})
        by_key.setdefault((uuid, metric), []).append((ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc), total, delta))

    for (uuid, _metric), series in by_key.items():
        if not series:
            continue
        if cutoff is None:
            value = series[-1][1]
        else:
            value = sum(int(delta or 0) for ts, _total, delta in series if ts > cutoff)
        by_player[uuid]["value"] += int(value or 0)

    out = list(by_player.values())
    out.sort(key=lambda x: -x["value"])
    return out[:limit]


def series(
    db: Session,
    server_id: int,
    uuids: list[str],
    metrics: list[str],
    mode: str = "delta",
    granularity: str = "10min",
    hours: int = 24,
) -> dict[str, list[tuple[float, int]]]:
    metric_keys = _metric_list(metrics)
    if not uuids or not metric_keys:
        return {}
    cutoff = _now() - timedelta(hours=max(1, hours))
    rows = db.execute(
        select(PlayerMetric.uuid, PlayerMetric.metric, PlayerMetric.ts, PlayerMetric.total, PlayerMetric.delta)
        .where(
            PlayerMetric.server_id == server_id,
            PlayerMetric.uuid.in_(uuids),
            PlayerMetric.metric.in_(metric_keys),
            PlayerMetric.ts >= cutoff,
        )
        .order_by(PlayerMetric.uuid, PlayerMetric.ts.asc())
    ).all()
    step = {
        "10min": 600,
        "20min": 1200,
        "30min": 1800,
        "1h": 3600,
        "6h": 21600,
        "12h": 43200,
        "24h": 86400,
    }.get(granularity, 600)
    buckets: dict[str, dict[int, int]] = {u: {} for u in uuids}
    latest_total: dict[tuple[str, str], int] = {}
    total_by_player: dict[str, int] = {u: 0 for u in uuids}
    for uuid, metric, ts, total, delta in rows:
        tsv = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        bucket = int(tsv.timestamp()) - (int(tsv.timestamp()) % step)
        if mode == "total":
            key = (uuid, metric)
            prev = latest_total.get(key, 0)
            cur = int(total or 0)
            total_by_player[uuid] = total_by_player.get(uuid, 0) - prev + cur
            latest_total[key] = cur
            buckets.setdefault(uuid, {})[bucket] = total_by_player[uuid]
        else:
            buckets.setdefault(uuid, {})[bucket] = buckets.setdefault(uuid, {}).get(bucket, 0) + int(delta or 0)
    return {uuid: [(float(ts), val) for ts, val in sorted(points.items())] for uuid, points in buckets.items()}


def player_options(db: Session, server_id: int, limit: int = 200) -> list[dict]:
    rows = db.execute(
        select(PlayerMetric.uuid, func.max(PlayerMetric.name), func.max(PlayerMetric.ts))
        .where(PlayerMetric.server_id == server_id)
        .group_by(PlayerMetric.uuid)
        .order_by(func.max(PlayerMetric.ts).desc())
        .limit(limit)
    ).all()
    return [{"uuid": uuid, "name": name or uuid[:8]} for uuid, name, _ts in rows]
