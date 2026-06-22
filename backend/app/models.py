"""数据模型:服务器实例 + 单行系统设置(含管理员凭据)。

MVP 采用「单管理员密码」鉴权(对齐前端模板),用户/角色体系留作后续扩展。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Server(Base):
    """一个被本面板管理的 MCDR 实例(对应 SERVERS_ROOT 下的一个目录)。"""

    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    # 实例目录名(SERVERS_ROOT 下),由 name 净化得到。
    dir_name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    server_type: Mapped[str] = mapped_column(String(32), default="vanilla")
    mc_version: Mapped[str] = mapped_column(String(64), default="")
    min_memory: Mapped[str] = mapped_column(String(16), default="1G")
    max_memory: Mapped[str] = mapped_column(String(16), default="2G")
    port: Mapped[int] = mapped_column(Integer, default=25565)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SystemSettings(Base):
    """单行配置表(id 固定为 1)。"""

    __tablename__ = "system_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    admin_password_hash: Mapped[str] = mapped_column(String(255), default="")
    python_executable: Mapped[str] = mapped_column(String(255), default="python")
    java_command: Mapped[str] = mapped_column(String(255), default="java")
    default_min_memory: Mapped[str] = mapped_column(String(16), default="1G")
    default_max_memory: Mapped[str] = mapped_column(String(16), default="2G")
    token_expire_minutes: Mapped[int] = mapped_column(Integer, default=60 * 24 * 7)
    extra: Mapped[str] = mapped_column(Text, default="{}")
