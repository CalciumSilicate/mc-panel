"""鉴权:首次引导建 owner、登录、注册、登出、当前用户、改密。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import verification
from ..database import get_db
from ..deps import get_current_user, get_settings_row
from ..models import User
from ..schemas import (
    AuthStatusResponse,
    BootstrapInfo,
    ChangePasswordRequest,
    Credentials,
    MeOut,
    TokenResponse,
    UserOut,
    VerifyInfo,
    VerifyRequest,
)
from ..security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(User)) or 0


def _issue_token(user: User, db: Session) -> str:
    expire = get_settings_row(db).token_expire_minutes
    return create_access_token(user.id, user.role, expire)


@router.get("/bootstrap", response_model=BootstrapInfo)
def bootstrap(db: Session = Depends(get_db)) -> BootstrapInfo:
    """公开:前端据此决定显示「引导建号 / 登录 / 注册」。"""
    return BootstrapInfo(
        needs_setup=_user_count(db) == 0,
        allow_register=get_settings_row(db).allow_register,
    )


@router.post("/setup", response_model=TokenResponse)
def setup(payload: Credentials, db: Session = Depends(get_db)) -> TokenResponse:
    """仅当系统尚无用户时:创建第一个账号(owner)。"""
    if _user_count(db) > 0:
        raise HTTPException(status_code=400, detail="已初始化,无法再次引导")
    user = User(
        username=payload.username.strip(),
        hashed_password=hash_password(payload.password),
        role="owner",
        verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(token=_issue_token(user, db))


@router.post("/login", response_model=TokenResponse)
def login(payload: Credentials, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.scalar(select(User).where(User.username == payload.username.strip()))
    if user is None or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return TokenResponse(token=_issue_token(user, db))


@router.post("/register", response_model=TokenResponse)
def register(payload: Credentials, db: Session = Depends(get_db)) -> TokenResponse:
    if not get_settings_row(db).allow_register:
        raise HTTPException(status_code=403, detail="未开放注册")
    if db.scalar(select(User).where(User.username == payload.username.strip())):
        raise HTTPException(status_code=409, detail="用户名已存在")
    user = User(
        username=payload.username.strip(),
        hashed_password=hash_password(payload.password),
        role="user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(token=_issue_token(user, db))


@router.post("/logout")
def logout(_: User = Depends(get_current_user)) -> dict:
    return {}


@router.get("/status", response_model=AuthStatusResponse)
def status(user: User = Depends(get_current_user)) -> AuthStatusResponse:
    return AuthStatusResponse(authenticated=True, user=UserOut.model_validate(user))


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/verify/request", response_model=VerifyInfo)
def verify_request(
    payload: VerifyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VerifyInfo:
    """生成验证码并暂存待绑定的玩家名;用户随后在游戏内输入绑定指令。"""
    code = verification.generate_code()
    user.verify_code = code
    user.verify_target = payload.player_id.strip()
    db.commit()
    return VerifyInfo(code=code, player_id=user.verify_target, command=verification.bind_command(code))


@router.post("/verify/cancel")
def verify_cancel(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    user.verify_code = ""
    user.verify_target = ""
    db.commit()
    return {"ok": True}


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if not verify_password(payload.old_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="原密码错误")
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}
