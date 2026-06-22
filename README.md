# MC Panel

一个独立的 Minecraft 服务器管理面板:把每个 [MCDReforged](https://github.com/MCDReforged/MCDReforged)(MCDR)实例当作「外部被管理对象」,提供仪表盘、服务器实例管理(含一键新建 vanilla 服务器)与系统设置。

- 后端:FastAPI · SQLAlchemy · SQLite · JWT(单管理员密码)
- 前端:Vite 6 · React 19 · TypeScript · Tailwind · shadcn/ui(派生自 `frontend-template`)

> 当前已实现 **仪表盘 / 服务器实例(含一键新建 vanilla)/ 实例控制台 / 系统设置**。用户/角色体系、插件管理等留作后续扩展。

## 目录结构

```
mc-panel/
├── backend/            FastAPI 后端
│   ├── app/
│   │   ├── main.py     应用装配(错误响应统一为 {"error": ...})
│   │   ├── config.py   路径与端口(优先改这里)
│   │   ├── models.py   Server / SystemSettings
│   │   ├── mcdr.py     MCDR 实例生命周期(创建/启停/状态)
│   │   ├── versions.py Mojang 版本清单 + 服务端 jar 下载
│   │   └── routers/    auth / system(仪表盘) / servers / settings
│   └── requirements.txt
├── web/                React 前端(详见 web/README.md 的内核约定)
│   └── src/
│       ├── api/        system / servers / settings(网络细节关在这里)
│       └── pages/      Overview(仪表盘) / Servers / Settings
└── data/               运行时数据(SQLite、密钥、MCDR 实例),git-ignored
```

## 快速开始(统一入口)

一条命令同时托管 API 与前端页面,无需分别启动前后端:

```bash
# 一次性准备后端环境
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    其他: source .venv/bin/activate
pip install -r requirements.txt

# 回到项目根,统一启动(前端产物不存在时会自动 npm install + build)
cd ..
python run.py
```

然后访问 **http://localhost:16824** 即可 —— 前端与 `/api` 同源,由后端一并提供。

`run.py` 参数:
- `python run.py` —— 前端 `web/dist` 不存在时自动构建再启动
- `python run.py --build` —— 强制重新构建前端再启动(改了前端代码后用)
- `python run.py --no-build` —— 跳过构建(产物须已存在)

说明:
- 健康检查:`GET http://localhost:16824/api/health` → `{"status":"ok"}`
- 默认管理员密码:`admin`(可用环境变量 `MCPANEL_ADMIN_PASSWORD` 覆盖,或登录后在「设置 → 安全」修改)
- 运行参数:`MCPANEL_DATA_DIR`(数据目录)、`MCPANEL_API_PORT`(端口)、`MCPANEL_WEB_DIST`(前端产物目录)

> 仅调试前端、需要热更新时,才单独 `cd web && npm run dev`(:5278,已代理 `/api` 到 16824);日常运行用上面的统一入口即可。

## 新建 vanilla 服务器:做了什么

「服务器实例 → 新建服务器」会:

1. 在 `data/servers/<净化后的名字>/` 生成 MCDR 实例目录(`server/`、`plugins/`、`config/`、`logs/`)
2. 写入 `config.yml`(`handler: vanilla_handler`、`start_command` 用配置的 Java 命令与内存)、`permission.yml`
3. 写入 `server/eula.txt`(`eula=true`)与 `server/server.properties`(端口等)
4. 从 Mojang 官方源下载对应版本的 `server.jar` 到 `server/`(后台进行,期间状态为「安装中」)

启动时以子进程运行 `<python> -m mcdreforged`(工作目录为实例目录),停止时向其 stdin 写入 `stop`。

## 实例控制台

在「服务器实例」列表点 ⌨ 图标打开控制台:

- 实时日志:后端把子进程 stdout/stderr 捕获进内存环形缓冲(每实例最近 500 行),经 WebSocket `GET /api/servers/{id}/console` 推送;连接时先回放历史,再流式追加。
- 发送命令:输入框回车 → `{"command": "..."}` 经同一 WebSocket 写入实例 stdin(实例运行中才可用)。
- 鉴权:WebSocket 无法自定义请求头,token 经 query 参数 `?token=` 传递并校验。
- 为保证 stdio 管道行为,实例 `config.yml` 关闭了 MCDR 的 `advanced_console`。

## 前置依赖

- Python 3.10+(后端)
- Node.js 18+(前端)
- 被启动的实例需要:目标 `python` 环境已安装 `mcdreforged`,以及可用的 `java`(版本号、命令在「设置 → MCDR 运行」配置)

## 生产部署(概要)

同一进程已托管前端,直接用统一入口即可:

```bash
python run.py --build            # 构建前端并启动(:16824 同时提供页面与 API)
```

如需多 worker / 反代,可单独跑 `uvicorn app.main:app --host 0.0.0.0 --port 16824`(前端产物须已 `npm run build`);此时前端由后端托管,Nginx 仅做反代与 TLS 即可。同源部署可收紧后端 CORS。
