"""玩家管理接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import players as players_mod
from ..database import get_db
from ..deps import require_helper
from ..models import Server

router = APIRouter(prefix="/players", tags=["players"])


@router.get("/{server_id}")
def list_players(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> list[dict]:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return players_mod.read_players(server)
