"""数据统计接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import stats
from ..database import get_db
from ..deps import require_auth
from ..models import Server

router = APIRouter(prefix="/stats", tags=["stats"])


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


@router.get("/metrics")
def metrics(_: object = Depends(require_auth)) -> list[dict]:
    return [{"key": k, "label": v} for k, v in stats.METRICS.items()]


@router.get("/{server_id}/leaderboard")
def leaderboard(
    server_id: int,
    metric: str = Query("play_time"),
    window: str = Query("total"),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    if metric not in stats.METRICS:
        raise HTTPException(status_code=400, detail="未知指标")
    return {"rows": stats.leaderboard(db, server_id, metric, window), "scanned_at": stats.scanned_at(server_id)}


@router.post("/{server_id}/refresh")
async def refresh(server_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)) -> dict:
    server = _server(db, server_id)
    await stats.scan_server_async(server)
    return {"scanned_at": stats.scanned_at(server_id)}


@router.get("/{server_id}/series")
def series(
    server_id: int,
    uuid: str = Query(...),
    metric: str = Query("play_time"),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    return {"points": stats.series(db, server_id, uuid, metric)}
