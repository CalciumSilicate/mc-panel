"""Pydantic v2 请求/响应模型。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------- 鉴权 ----------
class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    role: str
    verified: bool = False
    player_id: str = ""
    created_at: datetime


class MeOut(UserOut):
    """当前用户:额外带上进行中的验证信息(验证码 / 目标玩家名)。"""

    verify_code: str = ""
    verify_target: str = ""


class AuthStatusResponse(BaseModel):
    authenticated: bool
    user: UserOut | None = None


class BootstrapInfo(BaseModel):
    needs_setup: bool
    allow_register: bool


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=1)


class VerifyRequest(BaseModel):
    player_id: str = Field(min_length=1, max_length=64)


class VerifyInfo(BaseModel):
    code: str
    player_id: str
    command: str


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)
    role: str = "user"


class UserUpdate(BaseModel):
    role: str | None = None
    new_password: str | None = Field(default=None, min_length=1)
    verified: bool | None = None
    player_id: str | None = None


# ---------- 互联组 ----------
class ServerGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    bridge_enabled: bool = True
    qq_group_ids: list[int] = []


class ServerGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    bridge_enabled: bool | None = None
    qq_group_ids: list[int] | None = None


class ServerGroupOut(BaseModel):
    id: int
    name: str
    bridge_enabled: bool
    qq_group_ids: list[int] = []
    created_at: datetime
    server_count: int = 0


# ---------- 服务器 ----------
class ServerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    server_type: str = "vanilla"  # vanilla / fabric / forge / velocity
    mc_version: str = ""  # velocity 无需 MC 版本
    loader_version: str = ""  # fabric/forge/velocity 的核心版本
    min_memory: str = "1G"
    max_memory: str = "2G"
    port: int = 25565
    group_id: int | None = None


class ServerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    min_memory: str | None = None
    max_memory: str | None = None
    port: int | None = None
    mc_version: str | None = None
    loader_version: str | None = None
    extra_jvm_args: str | None = None
    auto_start: bool | None = None
    java_path_override: str | None = None
    protected: bool | None = None
    group_id: int | None = None


class PropertiesResponse(BaseModel):
    properties: dict[str, str]


class PropertiesUpdate(BaseModel):
    properties: dict[str, str]


class InstallProgress(BaseModel):
    downloaded: int
    total: int
    percent: float


class ServerSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    server_type: str
    mc_version: str
    loader_version: str = ""
    min_memory: str
    max_memory: str
    port: int
    extra_jvm_args: str = ""
    auto_start: bool = False
    java_path_override: str = ""
    protected: bool = False
    group_id: int | None = None
    group_name: str = ""
    created_at: datetime
    # 运行时派生字段
    status: str = "stopped"
    install: InstallProgress | None = None


class CreateServerResponse(BaseModel):
    id: int


class VersionList(BaseModel):
    versions: list[str]


class JavaInstall(BaseModel):
    path: str
    major: int | None = None


class JavaInfo(BaseModel):
    """某 MC 版本的 Java 需求与当前是否可满足(供新建对话框提示)。"""

    mc_version: str
    required_major: int | None
    satisfied: bool
    chosen_major: int | None = None
    message: str | None = None


# ---------- 仪表盘 ----------
class ResourceUsage(BaseModel):
    used_gb: float
    total_gb: float
    percent: float


class DashboardOverview(BaseModel):
    cpu_percent: float
    memory: ResourceUsage
    disk: ResourceUsage
    total_servers: int
    running_servers: int
    servers: list[ServerSummary]


# ---------- 系统设置 ----------
class ArchiveOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    filename: str
    size: int
    source: str
    source_server_id: int | None
    mc_version: str
    owner_user_id: int | None = None
    created_at: datetime


class SettingsResponse(BaseModel):
    python_executable: str
    java_command: str
    default_min_memory: str
    default_max_memory: str
    token_expire_minutes: int
    download_proxy: str = ""
    allow_register: bool = False
    port_min: int = 25565
    port_max: int = 25999
    onebot_enabled: bool = False
    onebot_ws_url: str = ""
    onebot_token: str = ""
    onebot_connected: bool = False
    # Java 安装池(带探测到的大版本)
    java_installs: list[JavaInstall] = []


class SettingsUpdate(BaseModel):
    python_executable: str | None = None
    java_command: str | None = None
    default_min_memory: str | None = None
    default_max_memory: str | None = None
    token_expire_minutes: int | None = Field(default=None, ge=5)
    download_proxy: str | None = None
    allow_register: bool | None = None
    port_min: int | None = Field(default=None, ge=1, le=65535)
    port_max: int | None = Field(default=None, ge=1, le=65535)
    onebot_enabled: bool | None = None
    onebot_ws_url: str | None = None
    onebot_token: str | None = None
    # Java 安装池路径列表(整体替换);为 None 时不改动
    java_paths: list[str] | None = None
