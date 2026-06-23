"""FastAPI 应用装配。

错误响应统一为 ``{"error": "..."}``,以契合前端 api/client 的解析(它读 payload.error)。
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import API_PORT, WEB_DIST, ensure_dirs
from .database import SessionLocal, init_db
from .deps import get_settings_row
from .java import choose_java, detect_installs, get_java_paths
from . import bridge, onebot, verification
from .mcdr import manager
from .models import Server
from .routers import archives, auth, chat, configs, groups, jobs, litematica, modconfigs, mods, pb, pcrc, players as players_router, plugins, servers, settings, stats as stats_router, system, tools, users, worldmap as worldmap_router

# 在模块加载时就建表,确保无论以何种方式启动(uvicorn / TestClient / 直接 import)
# 数据库都已就绪。
ensure_dirs()
init_db()
# 清理上次运行残留的「安装中」标记(下载不会跨重启续传)
manager.clear_stale_installing()
# 控制台逐行钩子:玩家绑定验证 + 互联组内聊天互转
def _line_hook(server_id: int, line: str) -> None:
    verification.handle_line(server_id, line)
    bridge.handle_line(server_id, line)


manager.line_hook = _line_hook


async def _autostart() -> None:
    """面板启动时按优先级分组拉起 auto_start 实例:同级并行,全部就绪后再下一级。"""
    import asyncio
    from collections import defaultdict

    db = SessionLocal()
    try:
        servers_to_start = list(db.scalars(select(Server).where(Server.auto_start.is_(True))).all())
        if not servers_to_start:
            return
        sys_settings = get_settings_row(db)
        installs = detect_installs(get_java_paths(sys_settings))
        python = sys_settings.python_executable
        java_cmd = sys_settings.java_command
    finally:
        db.close()

    groups: dict[int, list] = defaultdict(list)
    for s in servers_to_start:
        groups[getattr(s, "autostart_priority", 0) or 0].append(s)
    # 全部先标记为「队列中」
    for s in servers_to_start:
        manager._queued.add(s.id)

    async def _wait_ready(started: list, timeout: float = 300.0) -> None:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            pending = [s for s in started if manager.is_running(s.id) and s.id not in manager._ready]
            if not pending:
                return
            await asyncio.sleep(2)

    print("[autostart] groups: " + ", ".join(f"prio{p}={[s.name for s in groups[p]]}" for p in sorted(groups)), flush=True)
    try:
        for prio in sorted(groups):
            print(f"[autostart] starting prio {prio}: {[s.name for s in groups[prio]]}", flush=True)
            started = []
            for s in groups[prio]:
                manager._queued.discard(s.id)
                if manager.get_status(s) != "stopped":
                    continue
                if s.java_path_override:
                    java_path = s.java_path_override
                else:
                    java_path, err = choose_java(s.mc_version, installs, java_cmd)
                    if err:
                        continue
                try:
                    await manager.start(s, python, java_path)
                    started.append(s)
                except Exception:  # noqa: BLE001 - 单实例失败不影响其它
                    pass
            await _wait_ready(started)
            print(f"[autostart] prio {prio} all ready", flush=True)
    finally:
        for s in servers_to_start:
            manager._queued.discard(s.id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    import asyncio

    from . import mod_presets
    from . import pb as pb_mod
    from . import plugin_scan
    from . import stats as stats_mod
    from . import worldmap as worldmap_mod

    autostart_task = asyncio.create_task(_autostart())
    # 启动 QQ 互通客户端(OneBot 正向 ws)
    db = SessionLocal()
    try:
        row = get_settings_row(db)
        onebot.client.start(row.onebot_enabled, row.onebot_ws_url, row.onebot_token)
    finally:
        db.close()
    # 后台扫描 worker:插件安装状态(DB 缓存)+ Prime Backup 概览/列表(内存缓存)
    scan_task = asyncio.create_task(plugin_scan.worker())
    pb_task = asyncio.create_task(pb_mod.worker())
    mod_task = asyncio.create_task(mod_presets.worker())
    stats_task = asyncio.create_task(stats_mod.worker())
    map_task = asyncio.create_task(worldmap_mod.worker())
    try:
        yield
    finally:
        autostart_task.cancel()
        scan_task.cancel()
        pb_task.cancel()
        mod_task.cancel()
        stats_task.cancel()
        map_task.cancel()


app = FastAPI(title="mc-panel API", lifespan=lifespan)

# 开发期允许 vite dev server 跨域;生产由反代同源,可收紧。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_: Request, exc: StarletteHTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"error": "请求参数不合法", "detail": exc.errors()})


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


for r in (
    auth.router,
    system.router,
    servers.router,
    settings.router,
    plugins.router,
    mods.router,
    jobs.router,
    archives.router,
    tools.router,
    users.router,
    groups.router,
    chat.router,
    configs.router,
    pb.router,
    litematica.router,
    pcrc.router,
    modconfigs.router,
    stats_router.router,
    worldmap_router.router,
    players_router.router,
):
    app.include_router(r, prefix="/api")


# ---------- 托管前端构建产物(单一入口) ----------
# 在 API 路由之后注册,确保 /api/* 优先匹配。前端为单视图 SPA,任何非 /api、
# 非真实文件的路径都回退到 index.html(支持任意路径硬刷新)。
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"error": "Not Found"})
        candidate = WEB_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        index = WEB_DIST / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse(status_code=404, content={"error": "前端尚未构建"})


def main() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=API_PORT, reload=True)


if __name__ == "__main__":
    main()
