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


class User(Base):
    """面板用户。角色:owner(唯一)> admin > helper > user。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


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
    # 额外 JVM 参数(空格分隔,拼到 -Xmx 与 -jar 之间)
    extra_jvm_args: Mapped[str] = mapped_column(String(1024), default="")
    # 面板启动时自动拉起
    auto_start: Mapped[bool] = mapped_column(default=False)
    # 指定该实例使用的 java 可执行文件;空 = 按版本自动选择
    java_path_override: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Archive(Base):
    """一个世界存档(zip,存于 ARCHIVES_DIR)。"""

    __tablename__ = "archives"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    filename: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    size: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(16), default="server")  # server / uploaded
    source_server_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mc_version: Mapped[str] = mapped_column(String(64), default="")
    # 上传/创建者用户 id;user 角色只能管理自己的存档
    owner_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    # 出站下载代理(http/https 共用),空 = 直连
    download_proxy: Mapped[str] = mapped_column(String(255), default="")
    # 是否允许自助注册(默认关闭)
    allow_register: Mapped[bool] = mapped_column(default=False)
    extra: Mapped[str] = mapped_column(Text, default="{}")
