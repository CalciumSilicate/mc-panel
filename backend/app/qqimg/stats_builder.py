"""个人统计卡数据适配层:mc-panel stats + 位置 -> data dict -> base64 PNG。

对外:build_stats_png(db, server_ids, player_name, online_names, range_token) -> (ok, b64_or_err)。

沿用 asPanel 的 TOTAL_ITEMS / CHART_ITEMS(展示哪些统计/图表)以保证出图观感一致;
数据来源换成 mc-panel:
- 统计卡/趋势图:stats.series(mode=total/delta),跨群内多服按 ts 求和聚合
- 玩家识别:按名字查(mc-panel 无 QQ 绑定)——从 player_metrics/player_positions 找 uuid
- 坐标地图:player_positions 最近轨迹(dim 字符串 -> int)
"""
from __future__ import annotations

import base64
import io
import time
from datetime import timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import stats
from ..models import PlayerMetric, PlayerPosition
from .boards import _BREAK_METRICS, _VEHICLE_METRICS, _WALK_METRICS, _distance_formatter, _fmt_int, _time_formatter
from .stats_image import render_combined_view

# (label, metrics, unit, formatter)
TOTAL_ITEMS = [
    ("上线次数", ["custom.leave_game"], 1, _fmt_int),
    ("在线时长(hr)", ["custom.play_one_minute", "custom.play_time"], 1 / 20 / 3600, _time_formatter),
    ("挖掘方块", _BREAK_METRICS, 1, _fmt_int),
    ("死亡次数", ["custom.deaths"], 1, _fmt_int),
    ("鞘翅飞行", ["custom.aviate_one_cm"], 0.00001, _distance_formatter),
    ("珍珠传送", ["custom.ender_pearl_one_cm"], 0.00001, _distance_formatter),
    ("步行前进", _WALK_METRICS, 0.00001, _distance_formatter),
    ("交通工具", _VEHICLE_METRICS, 0.00001, _distance_formatter),
    ("使用烟花", ["custom.firework_boost", "used.firework_rocket"], 1, _fmt_int),
    ("消耗不死图腾", ["used.totem_of_undying"], 1, _fmt_int),
    ("破基岩", ["custom.break_bedrock"], 1, _fmt_int),
]

# (label, metrics, unit, is_delta)
CHART_ITEMS = [
    ("上线时长 (min)", ["custom.play_one_minute", "custom.play_time"], 1 / 20 / 60, True),
    ("移动 (m)", ["custom.aviate_one_cm", "custom.ender_pearl_one_cm", *_WALK_METRICS, *_VEHICLE_METRICS], 0.01, True),
    ("挖掘方块", _BREAK_METRICS, 1, True),
    ("破基岩", ["custom.break_bedrock"], 1, True),
    ("死亡次数", ["custom.deaths"], 1, True),
]

# range token -> (hours, granularity, label)
_RANGES = {
    "1d": (25, "1h", "今天"),
    "1w": (7 * 24 + 1, "24h", "本周"),
    "1m": (31 * 24, "24h", "本月"),
    "1y": (366 * 24, "24h", "今年"),
    "all": (3650 * 24, "24h", "全部"),
}
_DEFAULT_RANGE = "1m"


def _mc_avatar_url(name: str, size: int = 128) -> str:
    name = (name or "").strip() or "Steve"
    return f"https://mc-heads.net/avatar/{name}/{int(size)}"


def _dim_to_int(dim: str) -> int:
    d = (dim or "").lower()
    if "nether" in d:
        return -1
    if "end" in d:
        return 1
    return 0


def _resolve_player(db: Session, server_ids: List[int], name: str) -> Optional[Tuple[str, str]]:
    """按名字(不分大小写)找 (uuid, 规范名)。先查 player_metrics,再查 player_positions。"""
    target = (name or "").strip().lower()
    if not target:
        return None
    for sid in server_ids:
        for opt in stats.player_options(db, sid, limit=500):
            if (opt.get("name") or "").lower() == target:
                return opt["uuid"], opt["name"]
    rows = db.execute(
        select(PlayerPosition.uuid, PlayerPosition.name)
        .where(PlayerPosition.server_id.in_(server_ids))
        .distinct()
    ).all()
    for uuid, nm in rows:
        if (nm or "").lower() == target:
            return uuid, nm
    return None


def _combine(series_by_server: List[Dict[str, List[Tuple[float, int]]]], uuid: str) -> List[Tuple[int, int]]:
    """把多服的 {uuid:[(ts,val)]} 按 ts 求和,返回按 ts 升序的 [(ts,val)]。"""
    acc: Dict[int, int] = {}
    for m in series_by_server:
        for ts, val in m.get(uuid, []):
            acc[int(ts)] = acc.get(int(ts), 0) + int(val or 0)
    return sorted(acc.items())


def _metrics_sum(series: List[Tuple[int, int]]) -> Tuple[int, int]:
    if not series:
        return 0, 0
    return series[-1][1], series[-1][1] - series[0][1]


def _label_ts(ts: int, granularity: str) -> str:
    if granularity == "1h":
        return time.strftime("%H:00", time.localtime(ts))
    return time.strftime("%m-%d", time.localtime(ts))


def _build_totals(db: Session, server_ids: List[int], uuid: str, hours: int, gran: str) -> List[dict]:
    out: List[dict] = []
    for label, metrics, unit, fmt in TOTAL_ITEMS:
        per_server = [stats.series(db, sid, [uuid], metrics, mode="total", granularity=gran, hours=hours) for sid in server_ids]
        total, delta = _metrics_sum(_combine(per_server, uuid))
        if total:
            out.append({
                "label": label, "total": total, "delta": delta,
                "label_total": fmt(total * unit), "label_delta": fmt(delta * unit),
            })
    return out


def _build_charts(db: Session, server_ids: List[int], uuid: str, hours: int, gran: str) -> List[dict]:
    charts: List[dict] = []
    for label, metrics, unit, _is_delta in CHART_ITEMS:
        per_server = [stats.series(db, sid, [uuid], metrics, mode="delta", granularity=gran, hours=hours) for sid in server_ids]
        combined = _combine(per_server, uuid)
        if not combined:
            continue
        x = [_label_ts(ts, gran) for ts, _ in combined]
        y = [val * unit for _, val in combined]
        if not any(y):
            continue
        charts.append({"label": label, "x": x, "y": y, "total": round(sum(y), 2)})
    return charts


def _build_positions(db: Session, server_ids: List[int], uuid: str, hours: int) -> Optional[dict]:
    """返回 {'location':..} 或 {'path':..};无数据返回 None。"""
    cutoff = stats._now() - timedelta(hours=hours)
    rows = db.execute(
        select(PlayerPosition.x, PlayerPosition.z, PlayerPosition.dim, PlayerPosition.ts)
        .where(PlayerPosition.server_id.in_(server_ids), PlayerPosition.uuid == uuid, PlayerPosition.ts >= cutoff)
        .order_by(PlayerPosition.ts.asc())
    ).all()
    if not rows:
        # 回退:最后一次已知位置
        last = db.execute(
            select(PlayerPosition.x, PlayerPosition.z, PlayerPosition.dim)
            .where(PlayerPosition.server_id.in_(server_ids), PlayerPosition.uuid == uuid)
            .order_by(PlayerPosition.ts.desc())
        ).first()
        if last:
            return {"location": {"x": float(last[0]), "z": float(last[1]), "dim": _dim_to_int(last[2])}}
        return None
    pts = [(float(x), float(z), _dim_to_int(dim)) for x, z, dim, _ts in rows]
    if len(pts) == 1:
        return {"location": {"x": pts[0][0], "z": pts[0][1], "dim": pts[0][2]}}
    return {"path": pts}


def build_stats_png(
    db: Session,
    server_ids: List[int],
    player_name: str,
    online_names: Optional[set[str]] = None,
    range_token: Optional[str] = None,
) -> Tuple[bool, str]:
    if not server_ids:
        return False, "该 QQ 群未绑定任何 MC 实例,无法查统计。"
    if not (player_name or "").strip():
        return False, "请指定玩家名:## <玩家名> [1d/1w/1m/1y/all]\n(mc-panel 暂无 QQ 绑定,不能直接查自己)"

    hours, gran, range_label = _RANGES.get((range_token or _DEFAULT_RANGE).lower(), _RANGES[_DEFAULT_RANGE])

    resolved = _resolve_player(db, server_ids, player_name)
    if not resolved:
        return False, f"未找到玩家「{player_name}」的数据。"
    uuid, canon = resolved

    online = {n.lower() for n in (online_names or set())}
    is_online = canon.lower() in online

    data = {
        "qq_avatar": _mc_avatar_url(canon, 140),  # 无 QQ 绑定,用 MC 头
        "mc_avatar": _mc_avatar_url(canon, 50),
        "player_name": canon,
        "uuid": uuid,
        "is_online": is_online,
        "in_server": None,
        "last_seen": None,
        "time_range_label": range_label,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "data_source_text": f"mc-panel · {range_label} · server={server_ids}",
        "totals": _build_totals(db, server_ids, uuid, hours, gran),
        "charts": _build_charts(db, server_ids, uuid, hours, gran),
    }
    pos = _build_positions(db, server_ids, uuid, hours)
    if pos:
        data.update(pos)

    img = render_combined_view(data, None)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return True, base64.b64encode(buf.getvalue()).decode()
