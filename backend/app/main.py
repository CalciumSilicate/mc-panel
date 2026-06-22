"""FastAPI 应用装配。

错误响应统一为 ``{"error": "..."}``,以契合前端 api/client 的解析(它读 payload.error)。
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import API_PORT, WEB_DIST, ensure_dirs
from .database import init_db
from .mcdr import manager
from .routers import auth, servers, settings, system

# 在模块加载时就建表,确保无论以何种方式启动(uvicorn / TestClient / 直接 import)
# 数据库都已就绪。
ensure_dirs()
init_db()
# 清理上次运行残留的「安装中」标记(下载不会跨重启续传)
manager.clear_stale_installing()

app = FastAPI(title="mc-panel API")

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


for r in (auth.router, system.router, servers.router, settings.router):
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
