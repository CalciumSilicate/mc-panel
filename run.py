"""统一入口 —— 一条命令同时托管 API 与前端页面。

用法:
    python run.py            # 前端产物不存在时自动构建,然后启动服务
    python run.py --build    # 强制重新构建前端再启动
    python run.py --no-build # 跳过构建检查(产物须已存在)

启动后访问 http://localhost:16824 即可,前端与 /api 同源,无需单独起 vite。
端口由 MCPANEL_API_PORT 控制(默认 16824)。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DIST_DIR = WEB_DIR / "dist"
BACKEND_DIR = ROOT / "backend"

# 让 `app.*` 可被导入
sys.path.insert(0, str(BACKEND_DIR))


def _npm() -> str:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        sys.exit("✗ 未找到 npm,无法构建前端。请安装 Node.js 18+ 或先在 web/ 手动构建。")
    return npm


def build_frontend() -> None:
    npm = _npm()
    if not (WEB_DIR / "node_modules").exists():
        print("→ 安装前端依赖 (npm install) …")
        subprocess.run([npm, "install", "--no-audit", "--no-fund"], cwd=WEB_DIR, check=True)
    print("→ 构建前端 (npm run build) …")
    subprocess.run([npm, "run", "build"], cwd=WEB_DIR, check=True)


def main() -> None:
    args = set(sys.argv[1:])
    force_build = "--build" in args
    skip_build = "--no-build" in args

    if not skip_build and (force_build or not DIST_DIR.exists()):
        build_frontend()
    elif not DIST_DIR.exists():
        sys.exit("✗ 未找到前端产物 web/dist,请去掉 --no-build 或先构建。")

    import uvicorn

    from app.config import API_PORT

    print(f"→ 启动 MC Panel:http://localhost:{API_PORT}")
    uvicorn.run("app.main:app", host="0.0.0.0", port=API_PORT, reload=False)


if __name__ == "__main__":
    main()
