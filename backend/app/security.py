"""密码哈希与 JWT 签发/校验。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import secrets

import bcrypt
import jwt

from .config import JWT_ALGORITHM, get_secret_key


def new_session_id() -> str:
    """Random account-session generation, replaced on every revocation."""
    return secrets.token_hex(32)


def validate_password(password: str) -> str:
    if not 1 <= len(password.encode("utf-8")) <= 72:
        raise ValueError("密码必须为 1 至 72 个 UTF-8 字节")
    return password


def hash_password(password: str) -> str:
    validate_password(password)
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        validate_password(password)
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(
    user_id: int, role: str, expire_minutes: int, *, session_id: str
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "sid": session_id,
        "iat": now,
        "exp": now + timedelta(minutes=expire_minutes),
    }
    return jwt.encode(payload, get_secret_key(), algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token, get_secret_key(), algorithms=[JWT_ALGORITHM],
            options={"require": ["sub", "sid", "iat", "exp"]},
        )
        sid = payload.get("sid")
        if not isinstance(sid, str) or len(sid) != 64 or any(c not in "0123456789abcdef" for c in sid):
            return None
        return payload
    except jwt.PyJWTError:
        return None
