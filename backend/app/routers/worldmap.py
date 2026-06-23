"""世界地图接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import worldmap
from ..database import get_db
from ..deps import require_auth
from ..models import Server

router = APIRouter(prefix="/map", tags=["worldmap"])


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


@router.get("/{server_id}/players")
def map_players(server_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)) -> dict:
    _server(db, server_id)
    return {"players": worldmap.players(db, server_id), "scanned_at": worldmap.scanned_at(server_id)}


@router.get("/{server_id}/positions")
def map_positions(
    server_id: int,
    uuids: str = Query("", description="逗号分隔的 uuid;空=全部"),
    dim: str = Query("minecraft:overworld"),
    hours: int = Query(168),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    ids = [u for u in uuids.split(",") if u]
    return {"tracks": worldmap.positions(db, server_id, ids, dim, hours)}


@router.post("/{server_id}/refresh")
async def refresh(server_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)) -> dict:
    server = _server(db, server_id)
    await worldmap.scan_server_async(server)
    return {"scanned_at": worldmap.scanned_at(server_id)}
