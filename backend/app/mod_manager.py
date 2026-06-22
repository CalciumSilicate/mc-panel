"""模组管理:列出/启停/删除/上传本地 mod + Modrinth 在线搜索安装。

mod 位于实例的 server/mods/ 目录(*.jar);禁用通过追加 .disabled 后缀。
元数据尽力从 jar 内的 fabric.mod.json / quilt.mod.json / META-INF/mods.toml 解析。
注意:vanilla 服务端不加载 mod,需 Fabric/Forge 等加载器才会生效。
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

from . import jar_cache, net

MODRINTH_API = "https://api.modrinth.com/v2"


def _read_jar_meta(path: Path) -> dict:
    """返回 {id, name, version, loader};解析失败回退到文件名。"""
    fallback = {"id": "", "name": path.name, "version": "", "loader": ""}
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            if "fabric.mod.json" in names:
                try:
                    data = json.loads(zf.read("fabric.mod.json").decode("utf-8", "ignore"))
                    return {
                        "id": data.get("id", ""),
                        "name": data.get("name") or data.get("id") or path.name,
                        "version": str(data.get("version", "")),
                        "loader": "fabric",
                    }
                except ValueError:
                    pass
            if "quilt.mod.json" in names:
                try:
                    data = json.loads(zf.read("quilt.mod.json").decode("utf-8", "ignore"))
                    ql = data.get("quilt_loader", {})
                    meta = ql.get("metadata", {})
                    return {
                        "id": ql.get("id", ""),
                        "name": meta.get("name") or ql.get("id") or path.name,
                        "version": str(ql.get("version", "")),
                        "loader": "quilt",
                    }
                except ValueError:
                    pass
            if "META-INF/mods.toml" in names or "META-INF/neoforge.mods.toml" in names:
                key = "META-INF/mods.toml" if "META-INF/mods.toml" in names else "META-INF/neoforge.mods.toml"
                try:
                    import tomllib

                    data = tomllib.loads(zf.read(key).decode("utf-8", "ignore"))
                    mods = data.get("mods") or []
                    if mods:
                        m = mods[0]
                        return {
                            "id": m.get("modId", ""),
                            "name": m.get("displayName") or m.get("modId") or path.name,
                            "version": str(m.get("version", "")),
                            "loader": "forge",
                        }
                except (ValueError, ModuleNotFoundError):
                    pass
    except (zipfile.BadZipFile, OSError):
        pass
    return fallback


class ModManager:
    def mods_dir(self, instance_dir: Path) -> Path:
        return instance_dir / "server" / "mods"

    def list_mods(self, instance_dir: Path) -> list[dict]:
        return self.scan_dir(self.mods_dir(instance_dir))

    def scan_dir(self, mdir: Path) -> list[dict]:
        result: list[dict] = []
        if not mdir.exists():
            return result
        for entry in sorted(mdir.iterdir(), key=lambda p: p.name.lower()):
            real = entry.name[:-len(".disabled")] if entry.name.endswith(".disabled") else entry.name
            if not real.endswith(".jar") or entry.is_dir():
                continue
            meta = _read_jar_meta(entry)
            result.append(
                {
                    "file_name": entry.name,
                    "id": meta["id"],
                    "name": meta["name"],
                    "version": meta["version"],
                    "loader": meta["loader"],
                    "size": entry.stat().st_size,
                    "enabled": not entry.name.endswith(".disabled"),
                }
            )
        return result

    def switch_mod(self, instance_dir: Path, file_name: str, enable: bool) -> str:
        mdir = self.mods_dir(instance_dir)
        path = mdir / file_name
        if not path.exists():
            raise FileNotFoundError("mod 不存在")
        currently_enabled = not file_name.endswith(".disabled")
        if enable == currently_enabled:
            return file_name
        new_name = file_name[:-len(".disabled")] if enable else file_name + ".disabled"
        path.rename(mdir / new_name)
        return new_name

    def delete_mod(self, instance_dir: Path, file_name: str) -> None:
        self.delete_file(self.mods_dir(instance_dir), file_name)

    def delete_file(self, directory: Path, file_name: str) -> None:
        path = directory / Path(file_name).name
        if path.exists():
            path.unlink()

    def save_upload(self, instance_dir: Path, filename: str, content: bytes) -> str:
        return self.save_file(self.mods_dir(instance_dir), filename, content)

    def save_file(self, directory: Path, filename: str, content: bytes) -> str:
        name = Path(filename).name
        if not name.endswith(".jar"):
            raise ValueError("仅支持 .jar 模组文件")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(content)
        return name

    def install_from_library(self, library_dir: Path, instance_dir: Path, file_name: str) -> str:
        import shutil

        src = library_dir / Path(file_name).name
        if not src.exists():
            raise FileNotFoundError("库中不存在该文件")
        mdir = self.mods_dir(instance_dir)
        mdir.mkdir(parents=True, exist_ok=True)
        dest = mdir / src.name
        shutil.copyfile(src, dest)
        return dest.name

    # ---------- Modrinth ----------
    async def search_modrinth(
        self, query: str, mc_version: str | None, loader: str | None, limit: int = 20, offset: int = 0
    ) -> list[dict]:
        facets: list[list[str]] = [["project_type:mod"]]
        if mc_version:
            facets.append([f"versions:{mc_version}"])
        if loader:
            facets.append([f"categories:{loader}"])
        params = {
            "query": query,
            "limit": str(limit),
            "offset": str(offset),
            "facets": json.dumps(facets),
            "index": "relevance",
        }
        async with net.client(timeout=30) as client:
            resp = await client.get(f"{MODRINTH_API}/search", params=params)
            resp.raise_for_status()
            hits = resp.json().get("hits", [])
        return [
            {
                "project_id": h.get("project_id"),
                "slug": h.get("slug"),
                "title": h.get("title"),
                "description": h.get("description"),
                "downloads": h.get("downloads", 0),
                "icon_url": h.get("icon_url"),
            }
            for h in hits
        ]

    async def list_versions(
        self, project_id: str, mc_version: str | None, loader: str | None
    ) -> list[dict]:
        params: dict = {}
        if mc_version:
            params["game_versions"] = json.dumps([mc_version])
        if loader:
            params["loaders"] = json.dumps([loader])
        async with net.client(timeout=30) as client:
            resp = await client.get(f"{MODRINTH_API}/project/{project_id}/version", params=params)
            resp.raise_for_status()
            versions = resp.json()
        return [
            {
                "id": v.get("id"),
                "name": v.get("name"),
                "version_number": v.get("version_number"),
                "game_versions": v.get("game_versions", []),
                "loaders": v.get("loaders", []),
                "date_published": v.get("date_published"),
            }
            for v in versions
        ]

    async def install_from_modrinth(self, instance_dir: Path, version_id: str) -> str:
        async with net.client(timeout=30) as client:
            resp = await client.get(f"{MODRINTH_API}/version/{version_id}")
            resp.raise_for_status()
            version = resp.json()
        files = version.get("files") or []
        chosen = next((f for f in files if f.get("primary")), files[0] if files else None)
        if not chosen:
            raise ValueError("该版本没有可下载文件")
        url = chosen["url"]
        file_name = Path(chosen.get("filename") or f"{version_id}.jar").name
        sha1 = (chosen.get("hashes") or {}).get("sha1", "")

        mdir = self.mods_dir(instance_dir)
        mdir.mkdir(parents=True, exist_ok=True)
        dest = mdir / file_name
        await jar_cache.cached_download(
            url, dest, algo="sha1", hexhash=sha1, size=chosen.get("size", 0) or 0
        )
        return dest.name


manager = ModManager()
