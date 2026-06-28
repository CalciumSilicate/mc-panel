"""Stats API."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import stats
from ..database import get_db
from ..deps import require_auth
from ..models import Server

router = APIRouter(prefix="/stats", tags=["stats"])


def _server(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


def _metrics(metric: str = "", metrics: list[str] | None = None) -> list[str]:
    values = list(metrics or [])
    if metric:
        values.append(metric)
    if not values:
        values.append("custom.play_time")
    return values


@router.get("/metrics")
def metrics(
    q: str = Query(""),
    category: str = Query("all", pattern="^(all|important|normal|ignored)$"),
    limit: int = Query(200, ge=1, le=1000),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    return stats.list_metrics(db, q=q, category=category, limit=limit)


@router.get("/{server_id}/players")
def players(
    server_id: int,
    limit: int = Query(200, ge=1, le=1000),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    return {"players": stats.player_options(db, server_id, limit)}


@router.get("/{server_id}/leaderboard")
def leaderboard(
    server_id: int,
    metric: str = Query(""),
    metrics: list[str] = Query(default=[]),
    window: str = Query("total"),
    limit: int = Query(100, ge=1, le=1000),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    metric_keys = _metrics(metric, metrics)
    return {
        "rows": stats.leaderboard(db, server_id, metric_keys, window, limit),
        "scanned_at": stats.scanned_at(server_id),
    }


@router.post("/{server_id}/refresh")
async def refresh(
    server_id: int,
    scope: str = Query("important", pattern="^(important|full)$"),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    server = _server(db, server_id)
    await stats.scan_server_async(server, scope)
    return {"scanned_at": stats.scanned_at(server_id, scope)}


@router.get("/{server_id}/series")
def series(
    server_id: int,
    uuid: str = Query(""),
    uuids: list[str] = Query(default=[]),
    metric: str = Query(""),
    metrics: list[str] = Query(default=[]),
    mode: str = Query("delta", pattern="^(delta|total)$"),
    granularity: str = Query("10min"),
    hours: int = Query(24, ge=1, le=8760),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    ids = list(uuids)
    if uuid:
        ids.append(uuid)
    return {"points": stats.series(db, server_id, ids, _metrics(metric, metrics), mode, granularity, hours)}
