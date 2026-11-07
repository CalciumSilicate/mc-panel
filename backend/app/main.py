"""FastAPI 应用装配。

错误响应统一为 ``{"error": "..."}``,以契合前端 api/client 的解析(它读 payload.error)。
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import API_PORT, WEB_DIST, ensure_dirs
from .database import SessionLocal, init_db
from .deps import get_settings_row
from . import bridge, onebot, verification
from .mcdr import manager
from .models import Server
from .runtime_client import RuntimeUnavailable
from .routers import archives, auth, chat, configs, groups, jobs, litematica, modconfigs, mods, pb, players as players_router, plugins, servers, settings, system, tools, users
from .routers import server_files as server_files_router
from .routers import uploads as uploads_router

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


@asynccontextmanager
async def lifespan(_: FastAPI):
    import asyncio

    from . import host_metrics, mod_presets, uploads
    from . import pb as pb_mod
    from . import plugin_scan

    await manager.connect_runtime()
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
    host_task = asyncio.create_task(host_metrics.worker())
    upload_cleanup_task = asyncio.create_task(uploads.maintenance())
    try:
        yield
    finally:
        tasks = (scan_task, pb_task, mod_task, host_task, upload_cleanup_task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await uploads.shutdown()
        # Disconnect only: MCDR processes belong to the independent host.

        with SessionLocal() as db:
            instances = list(db.scalars(select(Server)).all())
        await manager.shutdown(instances)
        print("[shutdown] Panel disconnected; hosted instances continue running", flush=True)


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
    # 校验上下文可能含 ValueError;不回传原始 input,避免泄露密码等请求内容。
    details = [{key: value for key, value in error.items() if key not in ("input", "ctx")}
               for error in exc.errors()]
    return JSONResponse(status_code=422, content=jsonable_encoder(
        {"error": "请求参数不合法", "detail": details}
    ))


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
    modconfigs.router,
    players_router.router,
    server_files_router.router,
    uploads_router.router,
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
        root = WEB_DIST.resolve()
        try:
            candidate = (root / full_path).resolve()
            candidate.relative_to(root)
        except (ValueError, OSError, RuntimeError):
            return JSONResponse(status_code=404, content={"error": "Not Found"})
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


@app.exception_handler(RuntimeUnavailable)
async def runtime_unavailable_handler(request: Request, exc: RuntimeUnavailable):
    return JSONResponse(status_code=503, content={"error": str(exc)})
