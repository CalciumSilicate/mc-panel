"""Pydantic v2 请求/响应模型。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------- 鉴权 ----------
class LoginRequest(BaseModel):
    password: str


class TokenResponse(BaseModel):
    token: str


class AuthStatusResponse(BaseModel):
    authenticated: bool


# ---------- 服务器 ----------
class ServerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    mc_version: str = Field(min_length=1)
    min_memory: str = "1G"
    max_memory: str = "2G"
    port: int = 25565


class ServerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    min_memory: str | None = None
    max_memory: str | None = None
    port: int | None = None
    mc_version: str | None = None
    extra_jvm_args: str | None = None
    auto_start: bool | None = None
    java_path_override: str | None = None


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
    min_memory: str
    max_memory: str
    port: int
    extra_jvm_args: str = ""
    auto_start: bool = False
    java_path_override: str = ""
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
    created_at: datetime


class SettingsResponse(BaseModel):
    python_executable: str
    java_command: str
    default_min_memory: str
    default_max_memory: str
    token_expire_minutes: int
    download_proxy: str = ""
    # Java 安装池(带探测到的大版本)
    java_installs: list[JavaInstall] = []


class SettingsUpdate(BaseModel):
    python_executable: str | None = None
    java_command: str | None = None
    default_min_memory: str | None = None
    default_max_memory: str | None = None
    token_expire_minutes: int | None = Field(default=None, ge=5)
    download_proxy: str | None = None
    # Java 安装池路径列表(整体替换);为 None 时不改动
    java_paths: list[str] | None = None
    # 仅在需要修改时传入
    new_password: str | None = Field(default=None, min_length=1)
