"""用户管理:owner 管所有;admin 仅管 helper/user。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import ROLE_ORDER, require_admin, require_owner
from ..models import User
from ..schemas import UserCreate, UserOut, UserUpdate
from ..security import hash_password

router = APIRouter(prefix="/users", tags=["users"])

ASSIGNABLE_ROLES = {"user", "helper", "admin"}  # owner 只能通过转让产生


def _get_user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return user


def _can_manage(actor: User, target: User) -> bool:
    """只能管理「严格低于自己」的用户,且不能管理自己。"""
    return actor.id != target.id and ROLE_ORDER[actor.role] > ROLE_ORDER[target.role]


def _check_assignable(actor: User, role: str) -> None:
    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(status_code=400, detail="非法角色")
    if ROLE_ORDER[role] >= ROLE_ORDER[actor.role]:
        raise HTTPException(status_code=403, detail="不能赋予不低于自己的角色")


@router.get("", response_model=list[UserOut])
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[User]:
    return list(db.scalars(select(User).order_by(User.id)).all())


@router.post("", response_model=UserOut)
def create_user(
    payload: UserCreate,
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    _check_assignable(actor, payload.role)
    if db.scalar(select(User).where(User.username == payload.username.strip())):
        raise HTTPException(status_code=409, detail="用户名已存在")
    user = User(
        username=payload.username.strip(),
        hashed_password=hash_password(payload.password),
        role=payload.role,
        # 仅 user 需要验证;其他角色直接视为已验证
        verified=payload.role != "user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    target = _get_user_or_404(db, user_id)
    if not _can_manage(actor, target):
        raise HTTPException(status_code=403, detail="无权管理该用户")
    if payload.role is not None and payload.role != target.role:
        _check_assignable(actor, payload.role)
        target.role = payload.role
    if payload.new_password:
        target.hashed_password = hash_password(payload.new_password)
    # 直接修改验证态与绑定玩家
    if payload.verified is not None:
        target.verified = payload.verified
        if not payload.verified:
            target.player_id = ""
            target.verify_code = ""
            target.verify_target = ""
    if payload.player_id is not None:
        target.player_id = payload.player_id.strip()
    db.commit()
    db.refresh(target)
    return target


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    target = _get_user_or_404(db, user_id)
    if not _can_manage(actor, target):
        raise HTTPException(status_code=403, detail="无权删除该用户")
    db.delete(target)
    db.commit()
    return {"ok": True}


@router.post("/{user_id}/transfer-owner", response_model=UserOut)
def transfer_owner(
    user_id: int,
    actor: User = Depends(require_owner),
    db: Session = Depends(get_db),
) -> User:
    """把 owner 转让给目标用户;当前 owner 降为 admin(owner 始终唯一)。"""
    target = _get_user_or_404(db, user_id)
    if target.id == actor.id:
        raise HTTPException(status_code=400, detail="已经是 owner")
    actor.role = "admin"
    target.role = "owner"
    db.commit()
    db.refresh(target)
    return target
