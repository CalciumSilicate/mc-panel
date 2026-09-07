# Docker Compose 部署

面板、Python 3.14 / MCDReforged、Java 21 JRE 和已构建的前端放在一个镜像中。
Minecraft 是容器内由面板管理的子进程，不会为每个实例创建 Docker 容器；无需挂载 Docker socket，也不需要 privileged。
当前 CI 产物为 **linux/amd64**。生产推荐 Linux Docker Engine + Compose v2；Docker Desktop 请用 Linux containers。

## 首次启动

准备 `compose.yaml` 和 `.env.example`（从仓库下载或 clone），在同一目录执行：

```bash
cp .env.example .env
mkdir -p docker-data
sudo chown 1000:1000 docker-data
docker compose pull
docker compose up -d --no-build
docker compose logs -f mc-panel
```

`.env` 中可改镜像标签、数据目录、PUID/PGID、面板监听地址与游戏端口范围。
数据目录必须提前创建并属于配置的 UID/GID，Compose 不会悄悄创建一个不可写的空目录。
修改 UID/GID 后也需调整宿主机目录所有权。不要用 `chmod 777` 处理生产权限。

默认面板只发布到宿主机 `127.0.0.1:16824`。在本机访问，或先用 SSH 转发完成首次建号：

```bash
ssh -L 16824:127.0.0.1:16824 user@your-server
```

打开 http://localhost:16824 ，创建第一个 owner 账号，**没有预置账号密码**。
不要在建号前把面板开放到公网。之后可由宿主机 Nginx / Cloudflare Tunnel 反代到该地址（需支持 WebSocket）。
若反代也在另一容器中，应让两个服务加入同一 Docker 网络，反代目标用 `http://mc-panel:16824`，不是其自身的 localhost。
确需直接开放时可设 `PANEL_BIND=0.0.0.0`，同时配置防火墙与 HTTPS。

默认发布游戏端口 `25565-25575` 的 TCP/UDP，面板内分配的端口应落在此范围；新增范围外端口需修改 Compose 并重建容器。
容器内各实例以及 Velocity 子服仍可通过 `127.0.0.1` 互联。不要让实例绑定宿主机上独有的 IP。
RCON 默认不向宿主机发布；若外部工具需要，单独映射对应端口并限制访问来源。

## 数据都在宿主机

默认 `./docker-data` → 容器 `/data`，也可把 `MCPANEL_DATA_PATH` 设为 `/srv/mc-panel/data` 等绝对路径。

```text
docker-data/
├── panel.db             用户、实例信息、设置等 SQLite 数据库
├── secret.key           持久化 JWT 密钥（备份时不要遗漏）
├── servers/             所有实例，包含世界、配置、插件、模组、实例日志
├── archives/            存档与恢复前备份
├── library/             插件/模组中央库
├── pcrc/                录像机及录像
├── python-packages/     运行时安装的插件 Python 依赖
└── …                    其他缓存和运行时数据
```

只替换镜像不会删除这些数据。面板 stdout/stderr 使用 Docker 日志（已配置轮转）；实例日志在挂载目录内。
镜像构建上下文使用白名单，不会把本机 `data/`、日志、`.env`、虚拟环境打入镜像或上传构建端。
插件所需 pip 包写入 `/data/python-packages`，容器重建后仍可用；Python 大版本升级时应备份并重新安装其中的二进制依赖，避免 ABI 不兼容。

Java 默认命令为 `java`，实际路径 `/opt/java/openjdk/bin/java`（Java 21）。
需要 Java 8/17 等版本的旧服，请派生镜像安装对应 Linux Java，或挂载兼容 Linux 的 JRE，并在 Java 安装池登记容器内路径。
Windows 的 Java/Python 可执行文件不能在 Linux 容器中使用。Minecraft 内存总额还需为面板、MCDR 和 JVM 非堆内存预留空间。

## 更新、停服与备份

```bash
docker compose pull
docker compose up -d --no-build
```

容器收到 SIGTERM 后，面板会并行向实例发送正常停止命令并等待，60 秒内未退出的实例会强停；Compose 总宽限期为 90 秒。
强停仍可能丢失未保存改动，重要世界建议先在面板正常停服再更新。更新后仅启用了“开机自启”的实例自动启动，其余需手动启动。
不要使用 `docker kill` 做日常更新。不要启动多个 worker 或多个容器同时管理同一个数据目录。

可靠备份：`docker compose stop` 完成后复制或打包**整个数据目录**，再 `docker compose start`。
不要只复制正在写入的 SQLite 主文件，也不要删掉挂载目录。回滚镜像不保证数据库迁移可逆，应保留更新前完整备份。

## 从目前的 Windows 部署迁移

1. 先关闭实例开机自启，正常停止全部实例，再停止旧面板；保留完整 `data/` 备份。
2. 将完整 `data/` 复制到新宿主机的挂载目录，调整 UID/GID。首次建号会被跳过，原账号仍有效。
3. 启动容器后，在系统设置把 Python 路径改成 `/usr/local/bin/python`，默认 Java 改成 `java`，清理 Java 安装池中的 Windows 路径。
4. 清理每个实例的 Java 路径覆盖、自定义启动命令等 Windows 绝对路径，替换为容器内 Linux 路径。普通自动生成的启动命令会在启动时重建。
5. 确认端口映射、插件依赖与目录权限后逐个试启动，再恢复需要的开机自启。

不能让旧面板和新容器同时访问这份数据。本仓库的容器配置不会自动迁移或修改目前的 Windows 预览环境。

## GitHub Actions / GHCR

`.github/workflows/container.yml`：

- PR：构建镜像（包含前端 Lint/类型检查），在 Linux 镜像内跑后端测试，验证健康检查、Python/Java、首次建号和重建容器后的数据持久化；不推送。
- 推送 `main`：上述验证通过后发布 `ghcr.io/calciumsilicate/mc-panel:latest` 和 `sha-…` 标签。
- 推送 `v*` 标签：发布对应版本标签，例如 `v0.1.0`，以及 `sha-…`；不覆盖 latest。
- 可手动运行；使用仓库 `GITHUB_TOKEN` 的 `packages: write`，不需要保存个人令牌。镜像名自动转小写，fork 可自动使用自己的仓库名（Compose 中也需对应修改）。

工作流文件需先提交并推送到 GitHub，才会实际运行和产生镜像。
仓库须允许 Actions；首次发布后，若希望任何服务器匿名拉取，在 GitHub Packages 将该包设为 public。
私有包则在部署机用具备 `read:packages` 权限的凭据执行 `docker login ghcr.io`。
生产建议在 `.env` 中固定版本、提交标签或 digest，而不是始终跟随 latest。

本地构建、不依赖已发布镜像：

```bash
docker compose build
docker compose up -d --no-build --pull never
# Linux 开发机上的隔离冒烟测试（使用当前 UID/GID，无需 sudo）：
bash scripts/container-smoke.sh ghcr.io/calciumsilicate/mc-panel:latest
```
