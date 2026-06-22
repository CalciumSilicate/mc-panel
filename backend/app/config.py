"""集中式配置与路径解析。

派生/部署时优先只改这里:数据目录、监听端口、默认凭据均在此处。
所有运行时数据(SQLite、密钥、MCDR 实例)都落在 ``DATA_DIR`` 下,默认 git-ignore。
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

# 后端包根目录: .../mc-panel/backend
BACKEND_ROOT = Path(__file__).resolve().parent.parent
# 项目根目录: .../mc-panel
PROJECT_ROOT = BACKEND_ROOT.parent

# 前端构建产物目录(由 `npm run build` 生成)。后端在此托管 SPA,实现单一入口。
WEB_DIST = Path(os.environ.get("MCPANEL_WEB_DIST", PROJECT_ROOT / "web" / "dist"))

# 运行时数据根目录。可用环境变量覆盖。
DATA_DIR = Path(os.environ.get("MCPANEL_DATA_DIR", PROJECT_ROOT / "data"))
# 每个被管理的 MCDR 实例是 SERVERS_ROOT 下的一个子目录。
SERVERS_ROOT = DATA_DIR / "servers"
# 面板中央库:上传一次,可安装到任意实例。
PLUGIN_LIBRARY = DATA_DIR / "library" / "plugins"
MOD_LIBRARY = DATA_DIR / "library" / "mods"
# 世界存档存放目录。
ARCHIVES_DIR = DATA_DIR / "archives"
DB_PATH = DATA_DIR / "panel.db"
SECRET_KEY_PATH = DATA_DIR / "secret.key"

# HTTP 监听端口。需与前端 vite.config.ts 的代理目标一致。
API_PORT = int(os.environ.get("MCPANEL_API_PORT", "16824"))

# 首次启动时写入的默认管理员密码(之后可在「系统设置」里修改)。
DEFAULT_ADMIN_PASSWORD = os.environ.get("MCPANEL_ADMIN_PASSWORD", "admin")

# 启动 MCDR 实例所用的默认 Python 解释器。默认用后端自身的解释器,
# 这样只要 `pip install -r requirements.txt`(含 mcdreforged),实例即可开箱启动,
# 不会误用 PATH 上没装 mcdreforged 的全局 python。
DEFAULT_PYTHON_EXECUTABLE = sys.executable or "python"

JWT_ALGORITHM = "HS256"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SERVERS_ROOT.mkdir(parents=True, exist_ok=True)


def get_secret_key() -> str:
    """读取持久化的 JWT 密钥;不存在则生成并落盘。"""
    ensure_dirs()
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key, encoding="utf-8")
    return key
