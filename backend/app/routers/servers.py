"""服务器实例:列表 / 新建(vanilla)/ 启停 / 删除 / 版本列表。"""
from __future__ import annotations

import asyncio

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal, get_db
from ..deps import get_settings_row, require_auth
from ..mcdr import manager, sanitize_dir_name
from ..models import Server
from ..security import decode_token
from ..schemas import (
    CreateServerResponse,
    ServerCreate,
    ServerSummary,
    VersionList,
)
from ..versions import list_release_versions

router = APIRouter(prefix="/servers", tags=["servers"])


def _to_summary(server: Server) -> ServerSummary:
    summary = ServerSummary.model_validate(server)
    summary.status = manager.get_status(server)
    return summary


@router.get("", response_model=list[ServerSummary])
def list_servers(
    _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> list[ServerSummary]:
    servers = db.scalars(select(Server).order_by(Server.id)).all()
    return [_to_summary(s) for s in servers]


@router.get("/versions", response_model=VersionList)
async def get_versions(_: str = Depends(require_auth)) -> VersionList:
    try:
        return VersionList(versions=await list_release_versions())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"获取版本列表失败: {exc}")


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


@router.post("", response_model=CreateServerResponse)
def create_server(
    payload: ServerCreate,
    background: BackgroundTasks,
    _: str = Depends(require_auth),
    db: Session = Depends(get_db),
) -> CreateServerResponse:
    if db.scalar(select(Server).where(Server.name == payload.name)):
        raise HTTPException(status_code=409, detail="同名服务器已存在")

    dir_name = sanitize_dir_name(payload.name)
    if db.scalar(select(Server).where(Server.dir_name == dir_name)):
        raise HTTPException(status_code=409, detail="实例目录名冲突,请换个名字")

    settings = get_settings_row(db)
    server = Server(
        name=payload.name,
        dir_name=dir_name,
        server_type="vanilla",
        mc_version=payload.mc_version,
        min_memory=payload.min_memory or settings.default_min_memory,
        max_memory=payload.max_memory or settings.default_max_memory,
        port=payload.port,
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    # 后台下载/初始化,接口立即返回(状态为 installing)。
    background.add_task(_install_in_background, server.id, settings.java_command)
    return CreateServerResponse(id=server.id)


def _get_server_or_404(db: Session, server_id: int) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


@router.post("/{server_id}/start")
async def start_server(
    server_id: int, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    settings = get_settings_row(db)
    try:
        await manager.start(server, settings.python_executable)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": manager.get_status(server)}


@router.post("/{server_id}/stop")
async def stop_server(
    server_id: int, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
    await manager.stop(server)
    return {"status": manager.get_status(server)}


@router.delete("/{server_id}")
async def delete_server(
    server_id: int, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = _get_server_or_404(db, server_id)
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
    if not decode_token(token):
        await websocket.close(code=4401)
        return

    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
    finally:
        db.close()
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
