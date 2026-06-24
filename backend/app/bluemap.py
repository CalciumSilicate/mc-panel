"""世界地图真实底图:调 BlueMap CLI 渲染实例存档为 3D web 地图,面板托管 + 前端 iframe。

BlueMap CLI 是独立 Java 程序(5.22 需 Java 25):
  java -jar bluemap-cli.jar -c <cfg>      # 配置不存在则生成默认后退出
  java -jar bluemap-cli.jar -c <cfg> -r   # 渲染所有 map 后退出
我们让 cwd = <实例>/bluemap,配置直接在该目录,渲染输出 webroot 为其下的 web/。
首次渲染会(在 accept-download=true 下)从 Mojang 拉取客户端资源,耗时较久。
"""
from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path

from . import net, versions
from .config import DATA_DIR
from .database import SessionLocal
from .mcdr import manager
from .models import Server

_GITHUB_LATEST = "https://api.github.com/repos/BlueMap-Minecraft/BlueMap/releases/latest"
_JAR = DATA_DIR / "library" / "bluemap" / "bluemap-cli.jar"

# server_id -> {status: idle|rendering|done|error, message, rendered_at}
_state: dict[int, dict] = {}
_locks: dict[int, asyncio.Lock] = {}

# (map id, dimension, 显示名, region 相对 world 根的子目录)
_DIMS = [
    ("overworld", "minecraft:overworld", "主世界", ""),
    ("nether", "minecraft:the_nether", "下界", "DIM-1"),
    ("the_end", "minecraft:the_end", "末地", "DIM1"),
]


def _bdir(server: Server) -> Path:
    return manager.instance_dir(server) / "bluemap"


def webroot(server: Server) -> Path:
    return _bdir(server) / "web"


def status(server_id: int) -> dict:
    st = _state.get(server_id)
    if st:
        return st
    # 内存无记录(面板重启后):回退到磁盘产物,已有 index.html 即视为已渲染
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
    finally:
        db.close()
    if server is not None:
        index = webroot(server) / "index.html"
        if index.is_file():
            return {"status": "done", "message": "", "rendered_at": index.stat().st_mtime}
    return {"status": "idle", "message": "", "rendered_at": None}


def _get_lock(server_id: int) -> asyncio.Lock:
    lock = _locks.get(server_id)
    if lock is None:
        lock = _locks[server_id] = asyncio.Lock()
    return lock


async def ensure_jar() -> Path:
    """BlueMap CLI jar 不存在则从 GitHub releases 下载最新 *-cli.jar(共享,所有实例复用)。"""
    if _JAR.exists() and _JAR.stat().st_size > 1_000_000:
        return _JAR
    _JAR.parent.mkdir(parents=True, exist_ok=True)
    async with net.client(timeout=30) as client:
        r = await client.get(_GITHUB_LATEST, headers={"User-Agent": "mc-panel"})
        r.raise_for_status()
        assets = r.json().get("assets", [])
    url = next(
        (a["browser_download_url"] for a in assets
         if "cli" in a.get("name", "") and a.get("name", "").endswith(".jar")),
        None,
    )
    if not url:
        raise RuntimeError("未找到 BlueMap CLI 下载链接")
    await versions.download_file(url, _JAR)
    return _JAR


def _pick_java(server: Server) -> str:
    """BlueMap 5.22 需 Java 25。优先用实例 config.yml 配的 java(实例本就用它跑 MC),
    否则用面板 java 池里 major 最高的,最后系统 java。"""
    cfg = manager.instance_dir(server) / "config.yml"
    if cfg.exists():
        try:
            import yaml

            data = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
            sc = data.get("start_command")
            if isinstance(sc, list) and sc and "java" in str(sc[0]).lower():
                return str(sc[0])
        except Exception:  # noqa: BLE001
            pass
    db = SessionLocal()
    try:
        from .deps import get_settings_row
        from .java import detect_installs, get_java_paths

        s = get_settings_row(db)
        installs = [i for i in detect_installs(get_java_paths(s)) if i.get("major")]
        if installs:
            return max(installs, key=lambda i: i["major"])["path"]
        return s.java_command or "java"
    finally:
        db.close()


def _write_configs(server: Server) -> int:
    """改 core.conf 的 accept-download=true,按存在 region 的维度写 maps/*.conf。返回 map 数。"""
    bdir = _bdir(server)
    world = manager.instance_dir(server) / "server" / "world"
    core = bdir / "core.conf"
    if core.exists():
        text = core.read_text(encoding="utf-8")
        text = re.sub(r"(?m)^accept-download:\s*\w+", "accept-download: true", text)
        core.write_text(text, encoding="utf-8")
    maps = bdir / "maps"
    maps.mkdir(parents=True, exist_ok=True)
    for f in maps.glob("*.conf"):
        f.unlink()
    wp = str(world).replace("\\", "/")  # Java 接受正斜杠,免去 HOCON 转义
    count = 0
    for mid, dim, name, sub in _DIMS:
        region = (world / sub / "region") if sub else (world / "region")
        if not region.exists() or not any(region.glob("*.mca")):
            continue
        (maps / f"{mid}.conf").write_text(
            f'world: "{wp}"\ndimension: "{dim}"\nname: "{name}"\n', encoding="utf-8"
        )
        count += 1
    return count


async def _run(java: str, jar: Path, bdir: Path, render_flag: bool) -> tuple[int, str]:
    args = [java, "-jar", str(jar), "-c", str(bdir)]
    if render_flag:
        args.append("-r")
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(bdir),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    return proc.returncode or 0, (out or b"").decode("utf-8", "replace")


async def render(server_id: int) -> None:
    """对实例存档渲染 BlueMap。更新 _state;后台任务调用,异常写入 status。"""
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
    finally:
        db.close()
    if server is None:
        return
    lock = _get_lock(server_id)
    if lock.locked():
        return  # 已在渲染
    prev = _state.get(server_id, {})
    async with lock:
        _state[server_id] = {"status": "rendering", "message": "", "rendered_at": prev.get("rendered_at")}
        try:
            jar = await ensure_jar()
            java = _pick_java(server)
            bdir = _bdir(server)
            bdir.mkdir(parents=True, exist_ok=True)
            if not (bdir / "core.conf").exists():
                await _run(java, jar, bdir, render_flag=False)  # 生成默认配置后退出
            n = _write_configs(server)
            if n == 0:
                raise RuntimeError("该实例没有任何已生成区块的维度(world 为空),请先进服探索并保存世界后再渲染")
            code, out = await _run(java, jar, bdir, render_flag=True)
            if code != 0:
                tail = out[-600:]
                if "UnsupportedClassVersionError" in out:
                    tail = "BlueMap 需要 Java 25,但所选 Java 版本过低,请在系统设置添加 Java 25。\n" + tail
                raise RuntimeError(f"渲染失败(code {code}): {tail}")
            _state[server_id] = {"status": "done", "message": "", "rendered_at": time.time()}
        except Exception as exc:  # noqa: BLE001
            _state[server_id] = {"status": "error", "message": str(exc), "rendered_at": prev.get("rendered_at")}


_bg_tasks: set[asyncio.Task] = set()


def render_bg(server_id: int) -> None:
    """后台启动渲染(保留 task 引用避免被 GC)。"""
    task = asyncio.get_event_loop().create_task(render(server_id))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
