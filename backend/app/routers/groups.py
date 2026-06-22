"""互联组:纯组织/路由概念(决定哪些 MC 实例之间聊天互转),不参与权限。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_admin, require_auth
from ..models import Server, ServerGroup
from ..schemas import ServerGroupCreate, ServerGroupOut, ServerGroupUpdate

router = APIRouter(prefix="/groups", tags=["groups"])


def _counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(Server.group_id, func.count()).where(Server.group_id.is_not(None)).group_by(Server.group_id)
    ).all()
    return {gid: n for gid, n in rows}


def _out(group: ServerGroup, count: int) -> ServerGroupOut:
    o = ServerGroupOut.model_validate(group)
    o.server_count = count
    return o


@router.get("", response_model=list[ServerGroupOut])
def list_groups(_: object = Depends(require_auth), db: Session = Depends(get_db)) -> list[ServerGroupOut]:
    counts = _counts(db)
    groups = db.scalars(select(ServerGroup).order_by(ServerGroup.id)).all()
    return [_out(g, counts.get(g.id, 0)) for g in groups]


@router.post("", response_model=ServerGroupOut)
def create_group(
    payload: ServerGroupCreate, _: object = Depends(require_admin), db: Session = Depends(get_db)
) -> ServerGroupOut:
    if db.scalar(select(ServerGroup).where(ServerGroup.name == payload.name.strip())):
        raise HTTPException(status_code=409, detail="同名互联组已存在")
    g = ServerGroup(name=payload.name.strip(), bridge_enabled=payload.bridge_enabled)
    db.add(g)
    db.commit()
    db.refresh(g)
    return _out(g, 0)


@router.patch("/{group_id}", response_model=ServerGroupOut)
def update_group(
    group_id: int,
    payload: ServerGroupUpdate,
    _: object = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ServerGroupOut:
    g = db.get(ServerGroup, group_id)
    if g is None:
        raise HTTPException(status_code=404, detail="互联组不存在")
    if payload.name is not None and payload.name.strip() != g.name:
        if db.scalar(select(ServerGroup).where(ServerGroup.name == payload.name.strip(), ServerGroup.id != group_id)):
            raise HTTPException(status_code=409, detail="同名互联组已存在")
        g.name = payload.name.strip()
    if payload.bridge_enabled is not None:
        g.bridge_enabled = payload.bridge_enabled
    db.commit()
    db.refresh(g)
    return _out(g, _counts(db).get(g.id, 0))


@router.delete("/{group_id}")
def delete_group(
    group_id: int, _: object = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    g = db.get(ServerGroup, group_id)
    if g is None:
        raise HTTPException(status_code=404, detail="互联组不存在")
    # 解绑组内服务器(不删服务器)
    for s in db.scalars(select(Server).where(Server.group_id == group_id)).all():
        s.group_id = None
    db.delete(g)
    db.commit()
    return {"ok": True}
