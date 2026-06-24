"""世界地图底图:用 unmined-cli 把实例存档渲染成俯视 PNG,前端当 canvas 底图。

unmined-cli 是独立程序(非 Java)。部分 Windows 机器的 Device Guard 会按路径
拦截临时目录里的 exe,因此把 cli 放在 DATA_DIR(随项目部署在 workspace,属
受信任路径)下运行。渲染极快(2D 色块);解析日志的 "World rectangle" 得到
世界范围,连同 blocks-per-pixel 写入元数据,供前端把底图精确对齐到世界 x-z。
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import time
import zipfile
from pathlib import Path

from . import net
from .config import DATA_DIR
from .database import SessionLocal
from .mcdr import manager
from .models import Server

# unmined-cli 存放目录。注意 Device Guard 可能拦截 temp 路径的 exe,
# 可用 MCPANEL_UNMINED_DIR 指向受信任目录(默认在 DATA_DIR 下,随项目部署在 workspace)。
_UNMINED_DIR = Path(os.environ.get("MCPANEL_UNMINED_DIR") or (DATA_DIR / "library" / "unmined"))
_REGION = 512  # 每个 region 文件覆盖的方块数

# 平台 -> unmined-cli 下载页(WordPress 重定向到最新版压缩包)
_DOWNLOAD = {
    ("Windows", "AMD64"): "https://unmined.net/download/unmined-cli-windows-64bit-dev/",
    ("Windows", "ARM64"): "https://unmined.net/download/unmined-cli-windows-arm64-dev/",
    ("Linux", "x86_64"): "https://unmined.net/download/unmined-cli-linux-x64-dev/",
    ("Linux", "aarch64"): "https://unmined.net/download/unmined-cli-linux-arm64-dev/",
}

# (map id, unmined --dimension 值, region 相对 world 根的子目录)
_DIMS = [
    ("overworld", 0, ["region", "dimensions/minecraft/overworld/region"]),
    ("nether", -1, ["DIM-1/region", "dimensions/minecraft/the_nether/region"]),
    ("the_end", 1, ["DIM1/region", "dimensions/minecraft/the_end/region"]),
]

# server_id -> {status: idle|rendering|done|error, message, rendered_at}
_state: dict[int, dict] = {}
_locks: dict[int, asyncio.Lock] = {}
_bg_tasks: set[asyncio.Task] = set()

_RECT_RE = re.compile(r"World rectangle:\s*rr\(\s*(-?\d+);\s*(-?\d+);\s*(\d+)\s*x\s*(\d+)")
_SIZE_RE = re.compile(r"Output image size:\s*(\d+)\s*x\s*(\d+)")
# 渲染进度行:"Rendering region rr(0; 0), 1 / 4, 25.00%"
_PROG_RE = re.compile(r"(\d+)\s*/\s*(\d+),\s*([\d.]+)\s*%")


def _has_region(world: Path, cands: list[str]) -> bool:
    """候选 region 目录里任一有 .mca 即认为该维度有区块(兼容新旧世界布局)。"""
    for c in cands:
        d = world / c
        if d.exists() and any(d.glob("*.mca")):
            return True
    return False


def _basemap_dir(server: Server) -> Path:
    return manager.instance_dir(server) / "basemap"


def png_path(server: Server, dim_id: str) -> Path:
    return _basemap_dir(server) / f"{dim_id}.png"


def meta_path(server: Server, dim_id: str) -> Path:
    return _basemap_dir(server) / f"{dim_id}.json"


def status(server_id: int) -> dict:
    st = _state.get(server_id)
    if st:
        return st
    # 内存无记录(面板重启后):看磁盘产物,任一维度有 png 即视为已渲染
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
    finally:
        db.close()
    if server is not None:
        for dim_id, _num, _cands in _DIMS:
            p = png_path(server, dim_id)
            if p.is_file():
                return {"status": "done", "message": "", "rendered_at": p.stat().st_mtime}
    return {"status": "idle", "message": "", "rendered_at": None}


def _get_lock(server_id: int) -> asyncio.Lock:
    lock = _locks.get(server_id)
    if lock is None:
        lock = _locks[server_id] = asyncio.Lock()
    return lock


def _find_exe() -> Path | None:
    name = "unmined-cli.exe" if platform.system() == "Windows" else "unmined-cli"
    matches = list(_UNMINED_DIR.rglob(name))
    return matches[0] if matches else None


async def ensure_cli() -> Path:
    """unmined-cli 不存在则按平台下载解压(共享,所有实例复用)。"""
    exe = _find_exe()
    if exe is not None:
        return exe
    key = (platform.system(), platform.machine())
    url = _DOWNLOAD.get(key)
    if url is None:
        raise RuntimeError(f"unmined 暂不支持当前平台 {key};可手动放到 {_UNMINED_DIR}")
    _UNMINED_DIR.mkdir(parents=True, exist_ok=True)
    archive = _UNMINED_DIR / ("unmined.zip" if platform.system() == "Windows" else "unmined.tar.gz")
    async with net.client(timeout=120, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(archive, "wb") as f:
                async for chunk in resp.aiter_bytes(1 << 16):
                    f.write(chunk)
    if platform.system() == "Windows":
        with zipfile.ZipFile(archive) as z:
            z.extractall(_UNMINED_DIR)
    else:
        import tarfile

        with tarfile.open(archive) as t:
            t.extractall(_UNMINED_DIR)
        for p in _UNMINED_DIR.rglob("unmined-cli"):
            p.chmod(0o755)
    archive.unlink(missing_ok=True)
    exe = _find_exe()
    if exe is None:
        raise RuntimeError("unmined 解压后未找到可执行文件")
    return exe


async def _render_dim(exe: Path, world: Path, png: Path, dim_num: int, on_progress=None) -> tuple[int, str]:
    png.parent.mkdir(parents=True, exist_ok=True)
    args = [
        str(exe), "image", "render",
        "--world", str(world),
        "--output", str(png),
        "--dimension", str(dim_num),
        "--zoom", "0",
        "--shadows", "3d",
        "-c",  # 单个 chunk 出错继续
    ]
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(exe.parent),  # unmined 从 cwd/exe 目录读 config/templates
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    lines: list[str] = []
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", "replace").rstrip()
        lines.append(line)
        if on_progress is not None:
            m = _PROG_RE.search(line)
            if m:
                on_progress(float(m.group(3)))
    await proc.wait()
    return proc.returncode or 0, "\n".join(lines)


def _write_meta(server: Server, dim_id: str, log: str) -> bool:
    """从渲染日志解析世界范围,写元数据(供前端对齐)。成功返回 True。"""
    rect = _RECT_RE.search(log)
    size = _SIZE_RE.search(log)
    if not rect:
        return False
    rx, rz = int(rect.group(1)), int(rect.group(2))
    rw, rh = int(rect.group(3)), int(rect.group(4))
    width_px = int(size.group(1)) if size else rw * _REGION
    height_px = int(size.group(2)) if size else rh * _REGION
    bpp = (rw * _REGION) / width_px if width_px else 1  # blocks per pixel(zoom 0 时为 1)
    meta = {
        "minX": rx * _REGION,
        "minZ": rz * _REGION,
        "widthPx": width_px,
        "heightPx": height_px,
        "blocksPerPixel": bpp,
    }
    meta_path(server, dim_id).write_text(json.dumps(meta), encoding="utf-8")
    return True


async def render(server_id: int) -> None:
    """对实例各维度渲染底图。更新 _state;后台任务调用,异常写入 status。"""
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
    finally:
        db.close()
    if server is None:
        return
    lock = _get_lock(server_id)
    if lock.locked():
        return
    prev = _state.get(server_id, {})
    async with lock:
        _state[server_id] = {"status": "rendering", "message": "", "rendered_at": prev.get("rendered_at"),
                             "progress": {"percent": 0, "label": "准备中…"}}
        try:
            from . import archive_manager

            exe = await ensure_cli()
            # 世界目录按实例 level-name 解析(不一定叫 "world")
            world = archive_manager.world_dir(manager.instance_dir(server))
            # 先收集已生成区块的维度
            todo = [
                (dim_id, dim_num)
                for dim_id, dim_num, cands in _DIMS
                if _has_region(world, cands)
            ]
            if not todo:
                raise RuntimeError("该实例没有任何已生成区块的维度,请先进服探索并保存世界")
            done_dims: list[str] = []
            last_err = ""
            n = len(todo)
            for i, (dim_id, dim_num) in enumerate(todo):
                def on_prog(p: float, i=i, dim_id=dim_id) -> None:
                    _state[server_id]["progress"] = {"percent": round((i + p / 100) / n * 100), "label": f"{dim_id} {p:.0f}%"}
                on_prog(0.0)
                code, log = await _render_dim(exe, world, png_path(server, dim_id), dim_num, on_prog)
                if code != 0:
                    last_err = log[-300:]
                    continue
                if _write_meta(server, dim_id, log):
                    done_dims.append(dim_id)
            if not done_dims:
                raise RuntimeError(last_err or "渲染失败")
            _state[server_id] = {"status": "done", "message": ",".join(done_dims), "rendered_at": time.time(),
                                 "progress": {"percent": 100, "label": "完成"}}
        except Exception as exc:  # noqa: BLE001
            _state[server_id] = {"status": "error", "message": str(exc), "rendered_at": prev.get("rendered_at"), "progress": None}


def render_bg(server_id: int) -> None:
    """后台启动渲染(保留 task 引用避免被 GC)。须在事件循环线程内调用(async 路由)。"""
    task = asyncio.create_task(render(server_id))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
