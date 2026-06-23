"""服务器实例:列表 / 新建(vanilla)/ 启停 / 删除 / 版本列表。"""
from __future__ import annotations

import asyncio
import uuid

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal, get_db
from ..deps import (
    ROLE_ORDER,
    ensure_not_protected,
    get_settings_row,
    require_admin,
    require_auth,
    require_operate,
    role_at_least,
)
from ..java import choose_java, detect_installs, get_java_paths, required_java_major
from ..mcdr import manager
from ..models import Server, ServerGroup, User
from ..security import decode_token
from ..schemas import (
    CreateServerResponse,
    InstallProgress,
    JavaInfo,
    PropertiesResponse,
    PropertiesUpdate,
    ServerCreate,
    ServerSummary,
    ServerUpdate,
    VersionList,
)

# 编辑对话框「服务器属性」开放的 server.properties 键(其余键写回时保留不动)
COMMON_PROPERTY_KEYS = [
    "motd",
    "max-players",
    "difficulty",
    "gamemode",
    "view-distance",
    "white-list",
    "pvp",
    "online-mode",
    "level-seed",
]
from .. import ports as port_utils
from .. import proxy as proxy_mod
from .. import versions as versions_mod

router = APIRouter(prefix="/servers", tags=["servers"])


def _to_summary(server: Server, group_name: str = "") -> ServerSummary:
    summary = ServerSummary.model_validate(server)
    summary.status = manager.get_status(server)
    summary.group_name = group_name
    summary.needs_restart = manager.needs_restart(server.id)
    if summary.status == "installing":
        prog = manager.install_progress(server.id)
        if prog is not None:
            downloaded, total = prog
            percent = round(downloaded / total * 100, 1) if total else 0.0
            summary.install = InstallProgress(
                downloaded=downloaded, total=total, percent=percent
            )
    return summary


def _group_name(db: Session, group_id: int | None) -> str:
    if not group_id:
        return ""
    g = db.get(ServerGroup, group_id)
    return g.name if g else ""


def _port_in_use(db: Session, port: int, exclude_id: int | None = None) -> bool:
    """端口是否已被其它面板实例占用(DB 层去重)。"""
    q = select(Server).where(Server.port == port)
    if exclude_id is not None:
        q = q.where(Server.id != exclude_id)
    return db.scalar(q) is not None


@router.post("/proxy/{proxy_id}/wire")
async def wire_proxy(
    proxy_id: int, _: str = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    """一键接线:为该 Velocity 主服与其全部子服配置 modern 转发(需相关实例已停止)。"""
    proxy = _get_server_or_404(db, proxy_id)
    if proxy.server_type != "velocity":
        raise HTTPException(status_code=400, detail="只有 Velocity 实例可作为代理主服")
    backends = list(db.scalars(select(Server).where(Server.proxy_id == proxy_id)).all())
    if not backends:
        raise HTTPException(status_code=400, detail="该代理下还没有子服")
    busy = [s.name for s in [proxy, *backends] if manager.get_status(s) in ("running", "starting", "installing")]
    if busy:
        raise HTTPException(status_code=400, detail=f"请先停止:{', '.join(busy)}")
    results = await proxy_mod.wire(proxy, backends)
    return {"results": results}


@router.get("/suggest-port")
def suggest_port(_: str = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """给新建对话框推荐一个空闲端口(在设置的范围内,避开已有实例 + 系统未占用)。"""
    row = get_settings_row(db)
    lo, hi = sorted((row.port_min or 25565, row.port_max or 25999))
    taken = {p for (p,) in db.execute(select(Server.port)).all()}
    return {"port": port_utils.find_free_port(taken, lo, hi) or lo}


@router.get("", response_model=list[ServerSummary])
def list_servers(
    _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> list[ServerSummary]:
    names = {g.id: g.name for g in db.scalars(select(ServerGroup)).all()}
    servers = db.scalars(select(Server).order_by(Server.id)).all()
    return [_to_summary(s, names.get(s.group_id, "")) for s in servers]


@router.get("/versions", response_model=VersionList)
async def get_versions(
    type: str = Query(default="vanilla"),
    channel: str = Query(default="release"),  # release / snapshot / experimental
    refresh: bool = Query(default=False),
    _: str = Depends(require_admin),
) -> VersionList:
    """各类型可选的 MC/游戏版本(velocity 无 MC 版本,返回空)。"""
    try:
        if type == "fabric":
            return VersionList(versions=await versions_mod.list_fabric_games(channel, force=refresh))
        if type == "forge":
            return VersionList(versions=await versions_mod.list_forge_games(force=refresh))
        if type == "velocity":
            return VersionList(versions=[])
        return VersionList(versions=await versions_mod.list_mc_versions(channel, force=refresh))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"获取版本列表失败: {exc}")


@router.get("/loaders", response_model=VersionList)
async def get_loaders(
    type: str = Query(...),
    mc_version: str = Query(default=""),
    refresh: bool = Query(default=False),
    _: str = Depends(require_admin),
) -> VersionList:
    """加载器/核心版本:fabric/forge 依赖 mc_version;velocity 直接列版本。"""
    try:
        if type == "fabric":
            return VersionList(versions=await versions_mod.list_fabric_loaders(mc_version, force=refresh))
        if type == "forge":
            return VersionList(versions=await versions_mod.list_forge_loaders(mc_version, force=refresh))
        if type == "velocity":
            return VersionList(versions=await versions_mod.list_velocity_versions(force=refresh))
        return VersionList(versions=[])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"获取加载器版本失败: {exc}")


@router.get("/java-info", response_model=JavaInfo)
def java_info(
    mc_version: str = Query(...),
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> JavaInfo:
    """某 MC 版本的 Java 需求与当前是否可满足(供新建对话框提示)。"""
    row = get_settings_row(db)
    installs = detect_installs(get_java_paths(row))
    java_path, error = choose_java(mc_version, installs, row.java_command)
    required = required_java_major(mc_version)
    chosen = next(
        (i["major"] for i in installs if i["path"] == java_path and i["major"] is not None),
        None,
    )
    return JavaInfo(
        mc_version=mc_version,
        required_major=required,
        satisfied=error is None,
        chosen_major=chosen,
        message=error,
    )


async def _install_in_background(server_id: int, java_command: str) -> None:
    """后台:为新建的实例下载并初始化文件。使用独立 DB 会话读取实例。"""
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
        if server is None:
            return
        try:
            await manager.create_instance(server, java_command)
        except Exception:  # noqa: BLE001 - 失败已写入 .install_failed 标记
            pass
    finally:
        db.close()
        manager.clear_install_task(server_id)


async def _redownload_in_background(server_id: int) -> None:
    """后台:更换版本/重试时按类型重装核心。"""
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
        if server is None:
            return
        java_command = get_settings_row(db).java_command
        try:
            await manager.redownload_jar(server, java_command)
        except Exception:  # noqa: BLE001 - 失败已写入 .install_failed 标记
            pass
    finally:
        db.close()
        manager.clear_install_task(server_id)


def _launch_install(server_id: int, coro) -> None:
    """创建可中止的安装任务并登记到 manager。"""
    manager.set_install_task(server_id, asyncio.create_task(coro))


@router.post("", response_model=CreateServerResponse)
async def create_server(
    payload: ServerCreate,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> CreateServerResponse:
    if db.scalar(select(Server).where(Server.name == payload.name)):
        raise HTTPException(status_code=409, detail="同名服务器已存在")

    st = payload.server_type
    if st not in ("vanilla", "fabric", "forge", "velocity"):
        raise HTTPException(status_code=400, detail="不支持的服务器类型")
    if st != "velocity" and not payload.mc_version:
        raise HTTPException(status_code=400, detail="请选择 MC 版本")
    if st != "vanilla" and not payload.loader_version:
        label = {"fabric": "Fabric Loader", "forge": "Forge", "velocity": "Velocity"}[st]
        raise HTTPException(status_code=400, detail=f"请选择 {label} 版本")

    # 目录名用 UUID,与显示名解耦:之后改名只是改 DB,零风险
    dir_name = uuid.uuid4().hex

    settings = get_settings_row(db)
    if payload.group_id and not db.get(ServerGroup, payload.group_id):
        raise HTTPException(status_code=400, detail="互联组不存在")
    if _port_in_use(db, payload.port):
        raise HTTPException(status_code=409, detail=f"端口 {payload.port} 已被其它实例使用")
    server = Server(
        name=payload.name,
        dir_name=dir_name,
        server_type=st,
        mc_version=payload.mc_version,
        loader_version=payload.loader_version,
        min_memory=payload.min_memory or settings.default_min_memory,
        max_memory=payload.max_memory or settings.default_max_memory,
        port=payload.port,
        group_id=payload.group_id,
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    # 后台下载/初始化,接口立即返回(状态为 installing),任务可中止。
    _launch_install(server.id, _install_in_background(server.id, settings.java_command))
    return CreateServerResponse(id=server.id)


def _get_server_or_404(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


@router.patch("/{server_id}", response_model=ServerSummary)
async def update_server(
    server_id: int,
    payload: ServerUpdate,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ServerSummary:
    server = _get_server_or_404(db, server_id)

    # 受保护实例:仅允许取消保护本身,其它编辑一律拒绝(强制先取消保护)
    if server.protected:
        if payload.protected is False:
            server.protected = False
            db.commit()
            db.refresh(server)
            return _to_summary(server)
        raise HTTPException(status_code=409, detail="实例受保护,请先取消保护后再编辑")

    status = manager.get_status(server)

    if payload.name and payload.name != server.name:
        clash = db.scalar(
            select(Server).where(Server.name == payload.name, Server.id != server_id)
        )
        if clash:
            raise HTTPException(status_code=409, detail="同名服务器已存在")
        server.name = payload.name

    start_cmd_changed = False
    if payload.min_memory and payload.min_memory != server.min_memory:
        server.min_memory = payload.min_memory
        start_cmd_changed = True
    if payload.max_memory and payload.max_memory != server.max_memory:
        server.max_memory = payload.max_memory
        start_cmd_changed = True
    if payload.extra_jvm_args is not None and payload.extra_jvm_args != server.extra_jvm_args:
        server.extra_jvm_args = payload.extra_jvm_args
        start_cmd_changed = True

    port_changed = payload.port is not None and payload.port != server.port
    if port_changed:
        if _port_in_use(db, payload.port, exclude_id=server_id):
            raise HTTPException(status_code=409, detail=f"端口 {payload.port} 已被其它实例使用")
        server.port = payload.port

    if payload.auto_start is not None:
        server.auto_start = payload.auto_start
    if payload.java_path_override is not None:
        server.java_path_override = payload.java_path_override
    if payload.protected is not None:
        server.protected = payload.protected
    if "group_id" in payload.model_fields_set:
        if payload.group_id and not db.get(ServerGroup, payload.group_id):
            raise HTTPException(status_code=400, detail="互联组不存在")
        server.group_id = payload.group_id
    if "proxy_id" in payload.model_fields_set:
        if payload.proxy_id is not None:
            px = db.get(Server, payload.proxy_id)
            if px is None or px.server_type != "velocity":
                raise HTTPException(status_code=400, detail="代理必须是 Velocity 实例")
        server.proxy_id = payload.proxy_id

    mc_changed = bool(payload.mc_version) and payload.mc_version != server.mc_version
    loader_changed = payload.loader_version is not None and payload.loader_version != server.loader_version
    version_changed = mc_changed or loader_changed
    if version_changed:
        if status in ("running", "starting", "installing"):
            raise HTTPException(status_code=400, detail="更换版本/核心需先停止实例")
        if mc_changed:
            server.mc_version = payload.mc_version
        if loader_changed:
            server.loader_version = payload.loader_version

    db.commit()
    db.refresh(server)

    # 落盘(内存/JVM/端口改动重启后生效)
    if start_cmd_changed:
        manager.apply_start_command(server)
    if port_changed:
        manager.apply_port(server)
    if version_changed:
        _launch_install(server.id, _redownload_in_background(server.id))

    # 运行中改了配置 → 标记需要重启
    manager.mark_needs_restart(server.id)

    return _to_summary(server, _group_name(db, server.group_id))


@router.get("/{server_id}/properties", response_model=PropertiesResponse)
def get_properties(
    server_id: int, _: str = Depends(require_admin), db: Session = Depends(get_db)
) -> PropertiesResponse:
    server = _get_server_or_404(db, server_id)
    current = manager.read_properties(server)
    return PropertiesResponse(properties={k: current.get(k, "") for k in COMMON_PROPERTY_KEYS})


@router.patch("/{server_id}/properties", response_model=PropertiesResponse)
def update_properties(
    server_id: int,
    payload: PropertiesUpdate,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PropertiesResponse:
    server = _get_server_or_404(db, server_id)
    updates = {
        k: str(v) for k, v in payload.properties.items() if k in COMMON_PROPERTY_KEYS
    }
    if updates:
        manager.write_properties(server, updates)
        manager.mark_needs_restart(server.id)
    current = manager.read_properties(server)
    return PropertiesResponse(properties={k: current.get(k, "") for k in COMMON_PROPERTY_KEYS})


class VelocityConfig(BaseModel):
    motd: str = ""
    show_max_players: int = 500
    online_mode: bool = True
    forwarding_mode: str = "NONE"


@router.get("/{server_id}/velocity-config", response_model=VelocityConfig)
def get_velocity_config(
    server_id: int, _: str = Depends(require_admin), db: Session = Depends(get_db)
) -> VelocityConfig:
    server = _get_server_or_404(db, server_id)
    if server.server_type != "velocity":
        raise HTTPException(status_code=400, detail="非 Velocity 实例")
    return VelocityConfig(**manager.read_velocity_config(server))


@router.patch("/{server_id}/velocity-config", response_model=VelocityConfig)
def update_velocity_config(
    server_id: int,
    payload: VelocityConfig,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> VelocityConfig:
    server = _get_server_or_404(db, server_id)
    if server.server_type != "velocity":
        raise HTTPException(status_code=400, detail="非 Velocity 实例")
    ensure_not_protected(server)
    manager.write_velocity_config(server, payload.model_dump())
    return VelocityConfig(**manager.read_velocity_config(server))


@router.post("/{server_id}/reinstall")
async def reinstall_server(
    server_id: int,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """重新下载服务端核心(用于安装失败/中断后的重试)。"""
    server = _get_server_or_404(db, server_id)
    if manager.get_status(server) in ("running", "installing"):
        raise HTTPException(status_code=400, detail="运行中或安装中,无法重新安装")
    _launch_install(server.id, _redownload_in_background(server.id))
    return {"ok": True}


@router.post("/{server_id}/cancel-install")
async def cancel_install(
    server_id: int,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """中止进行中的安装/下载。"""
    server = _get_server_or_404(db, server_id)
    if manager.get_status(server) != "installing":
        raise HTTPException(status_code=400, detail="该实例不在安装中")
    await manager.cancel_install(server)
    return {"ok": True}


@router.post("/{server_id}/start")
async def start_server(
    server_id: int, _: object = Depends(require_operate), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    # 启动前实地探测端口是否被占用(自身已在运行则跳过)
    if not manager.is_running(server.id) and not port_utils.is_port_free(server.port):
        raise HTTPException(status_code=400, detail=f"端口 {server.port} 已被占用,无法启动")
    settings = get_settings_row(db)
    if server.java_path_override:
        java_path = server.java_path_override
    else:
        installs = detect_installs(get_java_paths(settings))
        java_path, java_error = choose_java(server.mc_version, installs, settings.java_command)
        if java_error:
            raise HTTPException(status_code=400, detail=java_error)
    try:
        await manager.start(server, settings.python_executable, java_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": manager.get_status(server)}


@router.post("/{server_id}/stop")
async def stop_server(
    server_id: int, user: User = Depends(require_operate), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    # 受保护实例仅 admin 可停
    if server.protected and not role_at_least(user, "admin"):
        raise HTTPException(status_code=403, detail="实例受保护,仅管理员可停止")
    await manager.stop(server)
    return {"status": manager.get_status(server)}


@router.post("/{server_id}/force-stop")
async def force_stop_server(
    server_id: int, user: User = Depends(require_operate), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    if server.protected and not role_at_least(user, "admin"):
        raise HTTPException(status_code=403, detail="实例受保护,仅管理员可停止")
    await manager.force_stop(server)
    return {"status": manager.get_status(server)}


@router.delete("/{server_id}")
async def delete_server(
    server_id: int, _: str = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    ensure_not_protected(server)
    await manager.delete_instance(server)
    db.delete(server)
    db.commit()
    return {"ok": True}


@router.websocket("/{server_id}/console")
async def console_ws(websocket: WebSocket, server_id: int, token: str = Query(default="")):
    """实例控制台:连接后回放最近日志,随后实时推送新行;客户端发来的
    ``{"command": "..."}`` 写入实例 stdin。

    浏览器 WebSocket 无法自定义请求头,故 token 经 query 参数传入。
    """
    payload = decode_token(token)
    if not payload:
        await websocket.close(code=4401)
        return

    db = SessionLocal()
    try:
        try:
            user = db.get(User, int(payload.get("sub") or 0))
        except (TypeError, ValueError):
            user = None
        server = db.get(Server, server_id)
    finally:
        db.close()
    # 控制台需 helper 及以上
    if user is None or ROLE_ORDER.get(user.role, 0) < ROLE_ORDER["helper"]:
        await websocket.close(code=4403)
        return
    if server is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    queue = manager.subscribe(server_id)

    async def pump_logs() -> None:
        for line in manager.recent_lines(server_id):
            await websocket.send_json({"type": "log", "line": line})
        while True:
            await websocket.send_json({"type": "log", "line": await queue.get()})

    async def pump_commands() -> None:
        while True:
            data = await websocket.receive_json()
            command = (data or {}).get("command")
            if not command:
                continue
            try:
                await manager.send_command(server, command)
            except RuntimeError as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})

    log_task = asyncio.create_task(pump_logs())
    cmd_task = asyncio.create_task(pump_commands())
    try:
        await asyncio.wait({log_task, cmd_task}, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for task in (log_task, cmd_task):
            task.cancel()
        manager.unsubscribe(server_id, queue)
