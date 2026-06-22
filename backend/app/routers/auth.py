"""鉴权:单管理员密码登录,返回 Bearer token(对齐前端模板)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_settings_row, require_auth
from ..schemas import AuthStatusResponse, LoginRequest, TokenResponse
from ..security import create_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    settings = get_settings_row(db)
    if not verify_password(payload.password, settings.admin_password_hash):
        raise HTTPException(status_code=401, detail="密码错误")
    token = create_access_token("admin", settings.token_expire_minutes)
    return TokenResponse(token=token)


@router.post("/logout")
def logout(_: str = Depends(require_auth)) -> dict:
    # 无状态 JWT:登出由前端丢弃 token 完成。
    return {}


@router.get("/status", response_model=AuthStatusResponse)
def status(_: str = Depends(require_auth)) -> AuthStatusResponse:
    return AuthStatusResponse(authenticated=True)
