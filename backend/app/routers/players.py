"""玩家管理接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .. import players as players_mod
from ..database import get_db
from ..deps import require_helper, require_admin, ensure_not_protected
from ..models import Server, User

router = APIRouter(prefix="/players", tags=["players"])


@router.get("/{server_id}")
def list_players(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> list[dict]:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return players_mod.read_players(server)


class PlayerUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    op: bool | None = None
    banned: bool | None = None
    ban_reason: str = Field(default='', max_length=300, pattern=r'^[^\r\n\x00-\x1f]*$')
    mcdr_perm: Literal['', 'guest', 'user', 'helper', 'admin', 'owner'] | None = None


@router.patch('/{server_id}/{name}')
async def update_player(server_id: int, name: str, body: PlayerUpdate,
                        actor: User = Depends(require_admin), db: Session = Depends(get_db)):
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(404, '服务器不存在')
    ensure_not_protected(server)
    if server.server_type not in ('vanilla', 'fabric', 'forge'):
        raise HTTPException(400, '请选择 MC 服务器')
    return await players_mod.update_player(server, name, body.model_dump(exclude_unset=True, exclude_none=True), actor.username)
