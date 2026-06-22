"""MCDR 插件管理:列出/启停/删除/上传本地插件 + 官方 catalogue 在线安装。

插件位于实例的 plugins/ 目录,形态有:
  - 单文件 .mcdr / .pyz(zip,根目录有 mcdreforged.plugin.json)
  - 单文件 .py(模块顶层有 PLUGIN_METADATA 字典)
  - 文件夹插件(目录下有 mcdreforged.plugin.json)
禁用通过追加 .disabled 后缀实现(MCDR 不加载)。
"""
from __future__ import annotations

import ast
import asyncio
import json
import time
import zipfile
from pathlib import Path

from . import jar_cache, net

CATALOGUE_URL = "https://api.mcdreforged.com/catalogue/everything_slim.json"
_CATALOGUE_TTL = 3600
_catalogue_cache: dict = {"data": None, "ts": 0.0}

PLUGIN_SUFFIXES = (".mcdr", ".pyz", ".py")


def _pick_text(value) -> str:
    """meta 里 name/description 可能是字符串或 {lang: text} 字典。"""
    if isinstance(value, dict):
        return value.get("zh_cn") or value.get("en_us") or next(iter(value.values()), "")
    return str(value or "")


def _read_zip_meta(path: Path) -> dict | None:
    try:
        with zipfile.ZipFile(path) as zf:
            with zf.open("mcdreforged.plugin.json") as fp:
                return json.load(fp)
    except (KeyError, zipfile.BadZipFile, OSError, ValueError):
        return None


def _read_py_meta(path: Path) -> dict | None:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"))
    except (SyntaxError, OSError):
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "PLUGIN_METADATA":
                    try:
                        return ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        return None
    return None


def _read_folder_meta(path: Path) -> dict | None:
    meta_file = path / "mcdreforged.plugin.json"
    if meta_file.exists():
        try:
            return json.loads(meta_file.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
    return None


def _read_meta(path: Path) -> dict | None:
    # 去掉 .disabled 再判断类型
    name = path.name
    real = name[:-len(".disabled")] if name.endswith(".disabled") else name
    if path.is_dir():
        return _read_folder_meta(path)
    if real.endswith((".mcdr", ".pyz")):
        return _read_zip_meta(path)
    if real.endswith(".py"):
        return _read_py_meta(path)
    return None


def _is_plugin_file(path: Path) -> bool:
    real = path.name
    if real.endswith(".disabled"):
        real = real[:-len(".disabled")]
    if path.is_dir():
        return (path / "mcdreforged.plugin.json").exists()
    return real.endswith(PLUGIN_SUFFIXES)


class PluginManager:
    def plugins_dir(self, instance_dir: Path) -> Path:
        return instance_dir / "plugins"

    def list_plugins(self, instance_dir: Path) -> list[dict]:
        return self.scan_dir(self.plugins_dir(instance_dir))

    def scan_dir(self, pdir: Path) -> list[dict]:
        result: list[dict] = []
        if not pdir.exists():
            return result
        for entry in sorted(pdir.iterdir(), key=lambda p: p.name.lower()):
            if not _is_plugin_file(entry):
                continue
            enabled = not entry.name.endswith(".disabled")
            meta = _read_meta(entry) or {}
            authors = meta.get("author") or meta.get("authors") or []
            if isinstance(authors, str):
                authors = [authors]
            result.append(
                {
                    "file_name": entry.name,
                    "id": meta.get("id", ""),
                    "name": _pick_text(meta.get("name")) or meta.get("id", entry.name),
                    "version": str(meta.get("version", "")),
                    "authors": authors,
                    "enabled": enabled,
                    "is_dir": entry.is_dir(),
                }
            )
        return result

    def switch_plugin(self, instance_dir: Path, file_name: str, enable: bool) -> str:
        pdir = self.plugins_dir(instance_dir)
        path = pdir / file_name
        if not path.exists():
            raise FileNotFoundError("插件不存在")
        currently_enabled = not file_name.endswith(".disabled")
        if enable == currently_enabled:
            return file_name
        if enable:
            new_name = file_name[:-len(".disabled")]
        else:
            new_name = file_name + ".disabled"
        path.rename(pdir / new_name)
        return new_name

    def delete_plugin(self, instance_dir: Path, file_name: str) -> None:
        self.delete_file(self.plugins_dir(instance_dir), file_name)

    def delete_file(self, directory: Path, file_name: str) -> None:
        import shutil

        path = directory / Path(file_name).name
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.exists():
            path.unlink()

    def save_upload(self, instance_dir: Path, filename: str, content: bytes) -> str:
        return self.save_file(self.plugins_dir(instance_dir), filename, content)

    def save_file(self, directory: Path, filename: str, content: bytes) -> str:
        name = Path(filename).name
        if not name.endswith(PLUGIN_SUFFIXES):
            raise ValueError("仅支持 .mcdr / .pyz / .py 插件文件")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(content)
        return name

    def install_from_library(self, library_dir: Path, instance_dir: Path, file_name: str) -> str:
        import shutil

        src = library_dir / Path(file_name).name
        if not src.exists():
            raise FileNotFoundError("库中不存在该文件")
        pdir = self.plugins_dir(instance_dir)
        pdir.mkdir(parents=True, exist_ok=True)
        dest = pdir / src.name
        shutil.copyfile(src, dest)
        return dest.name

    # ---------- 在线 catalogue ----------
    async def fetch_catalogue(self, force: bool = False) -> dict:
        now = time.time()
        cache = _catalogue_cache
        fresh = cache["data"] is not None and now - cache["ts"] < _CATALOGUE_TTL
        if force or not fresh:
            async with net.client(timeout=30) as client:
                resp = await client.get(CATALOGUE_URL)
                resp.raise_for_status()
                cache["data"] = resp.json()
                cache["ts"] = now
        return cache["data"]

    async def list_catalogue(self, force: bool = False) -> list[dict]:
        """返回精简的在线插件列表供前端浏览。"""
        data = await self.fetch_catalogue(force)
        plugins = data.get("plugins", {})
        out: list[dict] = []
        for pid, entry in plugins.items():
            meta = entry.get("meta") or {}
            release = entry.get("release") or {}
            latest = release.get("latest_version") or meta.get("version") or ""
            out.append(
                {
                    "id": pid,
                    "name": _pick_text(meta.get("name")) or pid,
                    "version": str(latest),
                    "description": _pick_text(meta.get("description")),
                    "authors": [
                        a.get("name", a) if isinstance(a, dict) else a
                        for a in (meta.get("authors") or [])
                    ],
                }
            )
        out.sort(key=lambda p: p["name"].lower())
        return out

    def _find_release(self, entry: dict, version: str | None) -> dict | None:
        release = entry.get("release") or {}
        releases = release.get("releases") or []
        if not releases:
            return None
        if version:
            for r in releases:
                if r.get("tag_name") == version or str(
                    (r.get("meta") or {}).get("version")
                ) == version:
                    return r
        target = release.get("latest_version")
        if target:
            for r in releases:
                if r.get("tag_name") == target:
                    return r
        return releases[0]

    async def _install_one(
        self, entry: dict, version: str | None, pdir: Path, python_executable: str, progress
    ) -> tuple[str, list[str]]:
        """下载并安装单个插件,返回 (文件名, 依赖插件 id 列表)。"""
        release = self._find_release(entry, version)
        if release is None:
            raise ValueError("该插件没有可用发布")
        asset = release.get("asset") or {}
        url = asset.get("browser_download_url")
        if not url:
            raise ValueError("该发布没有下载地址")
        dest = pdir / Path(asset.get("name") or "plugin.mcdr").name
        await jar_cache.cached_download(
            url,
            dest,
            algo="sha256",
            hexhash=asset.get("hash_sha256", ""),
            size=asset.get("size", 0) or 0,
            progress=progress,
        )
        meta = release.get("meta") or {}
        requirements = [
            r for r in (meta.get("requirements") or [])
            if isinstance(r, str) and "mcdreforged" not in r.lower()
        ]
        if requirements:
            await self._pip_install(python_executable, requirements)
        deps = meta.get("dependencies") or {}
        dep_ids = [k for k in deps.keys() if k != "mcdreforged"]
        return dest.name, dep_ids

    async def install_from_catalogue(
        self,
        instance_dir: Path,
        plugin_id: str,
        version: str | None,
        python_executable: str,
        progress=None,
    ) -> dict:
        """安装插件并递归(BFS)安装其依赖的其他插件(排除 mcdreforged 自身)。"""
        data = await self.fetch_catalogue()
        plugins_map = data.get("plugins") or {}
        pdir = self.plugins_dir(instance_dir)
        pdir.mkdir(parents=True, exist_ok=True)
        installed_now = {p["id"] for p in self.scan_dir(pdir) if p["id"]}

        primary_name: str | None = None
        installed_files: list[str] = []
        visited: set[str] = set()
        queue: list[tuple[str, str | None]] = [(plugin_id, version)]
        while queue:
            pid, ver = queue.pop(0)
            if pid in visited or pid in installed_now:
                continue
            visited.add(pid)
            entry = plugins_map.get(pid)
            if entry is None:
                if pid == plugin_id:
                    raise ValueError(f"插件库中未找到 {plugin_id}")
                continue  # 依赖不在库中,跳过
            name, dep_ids = await self._install_one(entry, ver, pdir, python_executable, progress)
            installed_files.append(name)
            if primary_name is None:
                primary_name = name
            for dep_id in dep_ids:
                if dep_id not in visited and dep_id not in installed_now:
                    queue.append((dep_id, None))
        return {"file_name": primary_name or "", "installed": installed_files}

    async def _pip_install(self, python_executable: str, requirements: list[str]) -> bool:
        try:
            proc = await asyncio.create_subprocess_exec(
                python_executable, "-m", "pip", "install", *requirements,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            return await proc.wait() == 0
        except (OSError, ValueError):
            return False


manager = PluginManager()
