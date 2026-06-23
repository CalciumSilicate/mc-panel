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
    # 验证态与绑定的正版玩家名;未验证的 user 只读
    verified: Mapped[bool] = mapped_column(default=False)
    player_id: Mapped[str] = mapped_column(String(64), default="")
    # 进行中的验证:验证码 + 待绑定的玩家名(目标)
    verify_code: Mapped[str] = mapped_column(String(16), default="")
    verify_target: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ServerGroup(Base):
    """互联组:纯组织/路由概念,只决定"谁和谁互联",不参与权限。"""

    __tablename__ = "server_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    # 组内 MC 实例的玩家聊天是否互相转发
    bridge_enabled: Mapped[bool] = mapped_column(default=True)
    # 绑定的 QQ 群号(JSON 数组);该组 MC 服与这些 QQ 群双向互通
    qq_group_ids: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class PlayerStat(Base):
    """玩家统计快照(来自 vanilla world/stats/<uuid>.json 的精选指标)。仅在值变化时插入。"""

    __tablename__ = "player_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(Integer, index=True)
    uuid: Mapped[str] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    metric: Mapped[str] = mapped_column(String(48), index=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


class PlayerPosition(Base):
    """玩家位置轨迹采样(来自 world/playerdata/<uuid>.dat 的 Pos)。仅在位置变化时插入。"""

    __tablename__ = "player_positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(Integer, index=True)
    uuid: Mapped[str] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    x: Mapped[float] = mapped_column(default=0.0)
    y: Mapped[float] = mapped_column(default=0.0)
    z: Mapped[float] = mapped_column(default=0.0)
    dim: Mapped[str] = mapped_column(String(48), default="minecraft:overworld")
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


class PluginScan(Base):
    """每个实例已安装 MCDR 插件 id 的缓存(由定时 worker 扫描更新),供「插件配置」秒读。"""

    __tablename__ = "plugin_scans"

    server_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    installed_ids: Mapped[str] = mapped_column(Text, default="[]")  # JSON 数组
    scanned_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class PcrcInstance(Base):
    """一个 PCRC 录像机实例(模拟客户端,连进服务器录制 .mcpr)。"""

    __tablename__ = "pcrc_instances"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    dir_name: Mapped[str] = mapped_column(String(120), nullable=False)
    address: Mapped[str] = mapped_column(String(255), default="127.0.0.1")
    port: Mapped[int] = mapped_column(Integer, default=25565)
    authenticate_type: Mapped[str] = mapped_column(String(16), default="offline")  # offline / microsoft
    username: Mapped[str] = mapped_column(String(120), default="PCRC")
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
    # 加载器/核心版本:fabric=loader 版本,forge=forge 版本,velocity=velocity 版本
    loader_version: Mapped[str] = mapped_column(String(64), default="")
    min_memory: Mapped[str] = mapped_column(String(16), default="1G")
    max_memory: Mapped[str] = mapped_column(String(16), default="2G")
    port: Mapped[int] = mapped_column(Integer, default=25565)
    # 额外 JVM 参数(空格分隔,拼到 -Xmx 与 -jar 之间)
    extra_jvm_args: Mapped[str] = mapped_column(String(1024), default="")
    # 面板启动时自动拉起
    auto_start: Mapped[bool] = mapped_column(default=False)
    # 指定该实例使用的 java 可执行文件;空 = 按版本自动选择
    java_path_override: Mapped[str] = mapped_column(String(512), default="")
    # 保护实例:开启后仅 admin 可停;编辑/删除/插件/模组/超平坦/恢复到本服 全禁
    protected: Mapped[bool] = mapped_column(default=False)
    # 所属互联组(纯组织,与权限无关);空 = 不属于任何组
    group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 子服指向的代理(velocity 实例 id);空 = 不挂在任何代理下
    proxy_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    # 自动分配端口的范围
    port_min: Mapped[int] = mapped_column(Integer, default=25565)
    port_max: Mapped[int] = mapped_column(Integer, default=25999)
    # 面板对外可达的基址(用于游戏内图片等绝对链接),如 http://your-host:16824
    base_url: Mapped[str] = mapped_column(String(255), default="")
    # 出站下载代理(http/https 共用),空 = 直连
    download_proxy: Mapped[str] = mapped_column(String(255), default="")
    # 是否允许自助注册(默认关闭)
    allow_register: Mapped[bool] = mapped_column(default=False)
    # QQ 互通(OneBot 11 正向 ws:面板作客户端连 LLBot)
    onebot_enabled: Mapped[bool] = mapped_column(default=False)
    onebot_ws_url: Mapped[str] = mapped_column(String(255), default="ws://127.0.0.1:3001")
    onebot_token: Mapped[str] = mapped_column(String(255), default="")
    extra: Mapped[str] = mapped_column(Text, default="{}")
