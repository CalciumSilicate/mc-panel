# 独立 MCDR 托管与本机部署

网站（FastAPI + 前端）与 MCDR 托管是两个独立进程。托管服务持有 MCDR/Java 进程、stdin/stdout、最近日志、就绪状态与开服后指令；网站使用随机令牌认证的 `127.0.0.1` 接口连接。后台服务在网站关闭期间继续读取输出，不会因为控制台断开而堵塞管道。

## 首次迁移

1. 在旧版本面板正常停止所有实例，确认世界已保存。
2. 停止旧网站进程，更新代码并执行 `uv sync --frozen`。
3. 执行 `uv run python run.py --build`。网站自动启动或连接独立托管服务。
4. 在面板启动实例；之后更新网站不需要再次停服。

旧版本已经启动的 MCDR 标准输入/输出管道无法直接转交给新进程，所以首次迁移需要停服一次。已有实例目录、世界和配置保持原位置。

## 日常更新网站

```sh
git pull
uv sync --frozen
```

停止网站，重新运行 `uv run python run.py --build`。仅前端代码更新也可以单独 `npm --prefix web run build`。不要停止托管服务，也不要用杀整棵进程树的方式停止网站。`stop.ps1` 只停止开发启动器记录的网站进程，保留托管服务及实例。

自动启动按优先级由托管服务在自身启动时执行一次。重新连接网站不会把手动停止的实例再次拉起，不会重发开服后指令。网站断开期间网站提供的聊天桥接、玩家绑定等功能暂停，游戏本身继续运行。

## 托管命令

```sh
uv run python runtime.py start                  # 后台启动或连接已有服务
uv run python runtime.py status                 # PID、实例状态、协议版本相关快照
uv run python runtime.py run                    # 前台运行，供系统服务管理器使用
uv run python runtime.py stop                   # 仅无运行实例时允许退出
uv run python runtime.py stop --stop-instances  # 正常停服，超时再清理进程树
```

所有命令和网站必须使用相同的 `MCPANEL_DATA_DIR`（默认仓库 `data/`）、同一系统账号。`data/runtime/` 保存连接令牌、系统锁、进程身份记录及 `host.log`；不要共享、提交、手动修改或在运行期间删除它。全量备份排除此临时目录，恢复也不导入旧连接信息。

托管停止会等待实例保存退出，最多正常等待 60 秒，然后清理仍存活的 MCDR/Java 进程。网站退出仅取消网站负责的安装任务并断开托管连接。要备份或恢复完整数据目录，先停止网站，再执行 `runtime.py stop --stop-instances`。

## Linux 系统服务

`deploy/mc-panel-runtime.service` 与 `deploy/mc-panel.service` 为示例。先创建运行账号，按本机情况修改两份文件中的账号、仓库路径、Python 路径和数据目录。安装依赖并构建前端后，将文件放到 `/etc/systemd/system/`，执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mc-panel-runtime mc-panel
```

更新网站只执行 `sudo systemctl restart mc-panel`。托管服务没有 `PartOf=mc-panel.service`，两者不随网站一同重启。只有升级托管本身、维护 Python 环境或关机时才停止 `mc-panel-runtime`；这会停服。不要在托管仍运行时删除其 Python 环境。

## Windows

开发使用 `dev.cmd` / `dev.ps1`，正常部署使用 `uv run python run.py --build`。后台托管脱离网站控制台，关闭网站窗口不会停止实例。需要开机启动时，可为运行账号设置任务计划，在登录时执行 `uv run python runtime.py start`，并另外启动网站；账号注销、系统重启的进程寿命由 Windows 管理，不能当作网站更新。

## 故障与升级边界

- 网站断连后自动尝试恢复连接。无法确认托管状态时返回 503，禁止启停及依赖停服状态的文件操作，不把未知状态伪装成“已停止”。
- 托管被强杀可能留下 MCDR/Java。启动前检查 PID 与创建时间，发现遗留进程时拒绝再启动一套。查看 `runtime/host.log`，先确认并正常停止遗留实例，再重新启动托管；不要凭 PID 直接杀进程（PID 可能复用）。启动中异常退出的记录需要在确认无遗留进程后人工清理。
- 协议版本不一致时拒绝连接。仅网站更新可不停服；更新托管协议/托管逻辑，需要安排托管维护窗口。运行中的托管不会热加载磁盘上新代码。
- 网站仍只支持一个 worker/一个副本管理同一数据目录，安装、文件操作和聊天桥接依然有网站内存状态。

验证：`PYTHONPATH=backend python -m unittest discover -s backend/tests -p test_runtime_host.py -v` 使用独立临时目录和模拟 MCDR，覆盖网站断开重连、PID 保持、历史日志、命令、开服后指令、并发启动和进程树清理，不操作真实游戏世界。
