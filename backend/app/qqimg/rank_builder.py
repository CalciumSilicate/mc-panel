"""排行榜数据适配层:mc-panel stats -> RankRow -> base64 PNG。

对外只有 build_rank_png(db, server_ids, args, limit) -> (ok, base64_or_error)。

与 asPanel 的差异都收敛在这里:
- asPanel 用 leaderboard_total(server_ids=...);mc-panel 的 stats.leaderboard 是单服,
  这里跨群内多服按 uuid 求和聚合。
- 通配 metric(如 mined.*)在 mc-panel 的 leaderboard/series 不展开,这里查库展开。
- 头像:mc-panel 用 mc-heads.net(按玩家名),没有 QQ 绑定,大小头像都用 MC 头。
"""
from __future__ import annotations

import base64
import fnmatch
import io
import time
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import stats
from ..models import PlayerMetric
from .boards import BuiltinBoard, resolve_board
from .rank_image import RankRow, render_rank_image

_DAY = 86400
_TREND_DAYS = 7


def _mc_avatar_url(name: str, size: int = 64) -> str:
    name = (name or "").strip() or "Steve"
    return f"https://mc-heads.net/avatar/{name}/{int(size)}"


def _expand_metrics(db: Session, server_ids: List[int], metrics: List[str]) -> List[str]:
    """把含通配符(*/?)的 metric 依据库里实际存在的 metric 展开;普通键原样保留。"""
    patterns = [m for m in metrics if ("*" in m or "?" in m)]
    literals = [m for m in metrics if m not in patterns]
    if not patterns:
        return literals
    rows = db.execute(
        select(PlayerMetric.metric)
        .where(PlayerMetric.server_id.in_(server_ids))
        .distinct()
    ).all()
    known = [r[0] for r in rows]
    expanded = set(literals)
    for pat in patterns:
        for key in known:
            if fnmatch.fnmatch(key, pat):
                expanded.add(key)
    return sorted(expanded)


def _agg_leaderboard(db: Session, server_ids: List[int], metrics: List[str], limit: int) -> List[dict]:
    """跨多服聚合排行:各服 stats.leaderboard 再按 uuid 求和。"""
    merged: dict[str, dict] = {}
    for sid in server_ids:
        for row in stats.leaderboard(db, sid, metrics, "total", limit=1000):
            uuid = row["uuid"]
            slot = merged.setdefault(uuid, {"uuid": uuid, "name": row.get("name"), "value": 0})
            slot["value"] += int(row.get("value") or 0)
            if not slot.get("name") and row.get("name"):
                slot["name"] = row["name"]
    out = [r for r in merged.values() if int(r["value"]) != 0]
    out.sort(key=lambda x: -int(x["value"]))
    return out[:limit]


def _trend_7d(db: Session, server_ids: List[int], uuids: List[str], metrics: List[str], scale: float) -> dict[str, List[float]]:
    """每个玩家最近 7 天的日增量(已乘 scale),用于 sparkline。"""
    if not uuids:
        return {}
    now = int(time.time())
    today_start = now - (now % _DAY)
    bucket_ts = [today_start - _DAY * i for i in range(_TREND_DAYS - 1, -1, -1)]
    # uuid -> {bucket_ts: delta}
    acc: dict[str, dict[int, float]] = {u: {} for u in uuids}
    for sid in server_ids:
        pts = stats.series(db, sid, uuids, metrics, mode="delta", granularity="24h", hours=_TREND_DAYS * 24 + 1)
        for uuid, series in pts.items():
            slot = acc.setdefault(uuid, {})
            for ts, val in series:
                b = int(ts) - (int(ts) % _DAY)
                slot[b] = slot.get(b, 0.0) + float(val)
    out: dict[str, List[float]] = {}
    for uuid in uuids:
        slot = acc.get(uuid, {})
        out[uuid] = [max(0.0, slot.get(b, 0.0)) * scale for b in bucket_ts]
    return out


def _resolve(args: List[str]) -> Tuple[Optional[BuiltinBoard], List[str], str]:
    """返回 (board, metrics, title)。args 是 rank 之后的 token。
    命中内置榜 -> (board, board.metrics, board.name);否则当自定义 metric 列表。"""
    args = [a for a in args if a.strip()]
    if not args:
        board = resolve_board("挖掘榜")
        return board, list(board.metrics), board.name  # type: ignore[union-attr]
    board = resolve_board(" ".join(args)) or resolve_board(args[0])
    if board:
        return board, list(board.metrics), board.name
    # 自定义:token 视为 metric 键(允许省略 minecraft: 命名空间)
    metrics = [a for a in args if "." in a]
    if not metrics:
        return None, [], ""
    title = "自定义榜:" + "+".join(metrics)
    return None, metrics, title


def build_rank_png(db: Session, server_ids: List[int], args: List[str], limit: int = 15) -> Tuple[bool, str]:
    if not server_ids:
        return False, "该 QQ 群未绑定任何 MC 实例,无法出榜。"

    board, raw_metrics, title = _resolve(args)
    if board is None and not raw_metrics:
        return False, "无法识别的榜单或指标。发 ##rank list 看可用榜单。"
    if board is not None and board.special:
        return False, f"「{board.name}」依赖坐标/会话数据,暂未移植,敬请期待。"

    scale = board.scale if board else 1.0
    formatter = board.formatter if board else (lambda x: f"{int(x):,}")

    metrics = _expand_metrics(db, server_ids, raw_metrics)
    if not metrics:
        return False, f"「{title}」暂无可统计的指标数据。"

    rows_data = _agg_leaderboard(db, server_ids, metrics, limit)
    if not rows_data:
        return False, f"「{title}」暂无数据。"

    uuids = [r["uuid"] for r in rows_data]
    trend = _trend_7d(db, server_ids, uuids, metrics, scale)

    rank_rows: List[RankRow] = []
    for i, r in enumerate(rows_data, start=1):
        name = r.get("name") or (r["uuid"][:8] if r.get("uuid") else "Unknown")
        scaled = float(r["value"]) * scale
        avatar = _mc_avatar_url(name, 64)
        rank_rows.append(RankRow(
            rank=i,
            player_name=name,
            player_uuid=r.get("uuid") or "",
            score_text=formatter(scaled),
            avatar_big=avatar,
            avatar_small=avatar,
            trend_values=trend.get(r["uuid"]),
        ))

    subtitle = f"共 {len(rank_rows)} 名 · 近 7 日趋势 · {time.strftime('%Y-%m-%d %H:%M')}"
    img = render_rank_image(title=title, subtitle=subtitle, rows=rank_rows, show_trend=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return True, base64.b64encode(buf.getvalue()).decode()
