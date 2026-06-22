"""Mojang 版本清单:列出可用的正式版,以及解析服务端 jar 下载地址。"""
from __future__ import annotations

import time

import httpx

from . import net

VERSION_MANIFEST_URL = (
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
)

# 版本清单的内存 TTL 缓存(进程级,所有客户端共享)。
VERSIONS_CACHE_TTL = 1800  # 30 分钟
# 缓存完整 manifest 的 (id, type) 列表,按 channel 过滤
_manifest_cache: dict = {"data": None, "ts": 0.0}


async def _manifest_versions(force: bool = False) -> list[dict]:
    now = time.time()
    cache = _manifest_cache
    fresh = cache["data"] is not None and now - cache["ts"] < VERSIONS_CACHE_TTL
    if force or not fresh:
        async with net.client(timeout=20) as client:
            resp = await client.get(VERSION_MANIFEST_URL)
            resp.raise_for_status()
            data = resp.json()
        cache["data"] = [
            {"id": v["id"], "type": v.get("type", "")} for v in data.get("versions", [])
        ]
        cache["ts"] = now
    return cache["data"]


def _channel_match(channel: str, vid: str, vtype: str) -> bool:
    if channel == "release":
        return vtype == "release"
    if channel == "snapshot":
        return vtype == "snapshot" and "experimental" not in vid
    if channel == "experimental":
        return "experimental" in vid or vtype in ("old_beta", "old_alpha")
    return True


async def list_mc_versions(channel: str = "release", limit: int = 80, force: bool = False) -> list[str]:
    """按频道返回 MC 版本号(新到旧):release / snapshot / experimental。"""
    vers = await _manifest_versions(force)
    return [v["id"] for v in vers if _channel_match(channel, v["id"], v["type"])][:limit]


async def list_release_versions(limit: int = 60, force: bool = False) -> list[str]:
    return await list_mc_versions("release", limit, force)


async def get_server_download(mc_version: str) -> dict:
    """解析指定版本官方服务端 jar 的下载信息:{url, sha1, size}。

    先拉版本清单找到该版本,再拉其 meta(version detail),其中 downloads.server
    带有 url / sha1 / size。size 用于进度总量,sha1 用于本地缓存命中。
    """
    async with net.client(timeout=20) as client:
        resp = await client.get(VERSION_MANIFEST_URL)
        resp.raise_for_status()
        manifest = resp.json()

        entry = next(
            (v for v in manifest.get("versions", []) if v.get("id") == mc_version),
            None,
        )
        if entry is None:
            raise ValueError(f"未找到版本 {mc_version}")

        detail_resp = await client.get(entry["url"])
        detail_resp.raise_for_status()
        detail = detail_resp.json()

    server = detail.get("downloads", {}).get("server")
    if not server or "url" not in server:
        raise ValueError(f"版本 {mc_version} 没有提供官方服务端 jar")
    return {
        "url": server["url"],
        "sha1": server.get("sha1", ""),
        "size": int(server.get("size", 0) or 0),
    }


# ---------------- 多加载器:版本列表 + 下载解析 ----------------
# 通用 JSON 缓存(url -> (ts, data))
_json_cache: dict[str, tuple[float, object]] = {}


async def _cached_json(url: str, ttl: int = VERSIONS_CACHE_TTL, force: bool = False):
    now = time.time()
    hit = _json_cache.get(url)
    if not force and hit and now - hit[0] < ttl:
        return hit[1]
    async with net.client(timeout=20) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
    _json_cache[url] = (now, data)
    return data


# ---- Fabric ----
async def list_fabric_games(channel: str = "release", force: bool = False) -> list[str]:
    data = await _cached_json("https://meta.fabricmc.net/v2/versions/game", force=force)
    out = []
    for x in data:
        vid, stable = x["version"], x.get("stable", False)
        if channel == "release" and stable:
            out.append(vid)
        elif channel == "snapshot" and not stable and "experimental" not in vid:
            out.append(vid)
        elif channel == "experimental" and "experimental" in vid:
            out.append(vid)
    return out


async def list_fabric_loaders(mc_version: str, force: bool = False) -> list[str]:
    data = await _cached_json(f"https://meta.fabricmc.net/v2/versions/loader/{mc_version}", force=force)
    return [x["loader"]["version"] for x in data]


async def _latest_fabric_installer() -> str:
    data = await _cached_json("https://meta.fabricmc.net/v2/versions/installer")
    stable = next((x for x in data if x.get("stable")), None)
    return (stable or data[0])["version"]


async def get_fabric_download(mc_version: str, loader_version: str) -> dict:
    """Fabric 自举服务端 jar(首次启动时自动下载原版核心与依赖)。无预知 hash/size。"""
    installer = await _latest_fabric_installer()
    url = (
        f"https://meta.fabricmc.net/v2/versions/loader/"
        f"{mc_version}/{loader_version}/{installer}/server/jar"
    )
    return {"url": url, "sha1": "", "size": 0}


# ---- Forge ----
async def list_forge_games(force: bool = False) -> list[str]:
    data = await _cached_json(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json", force=force
    )
    games: list[str] = []
    for key in data.get("promos", {}):
        mc = key.rsplit("-", 1)[0]
        if mc not in games:
            games.append(mc)
    games.reverse()  # 新到旧
    return games


async def list_forge_loaders(mc_version: str, force: bool = False) -> list[str]:
    """该 MC 版本的全部 Forge 构建(新到旧),取自 maven-metadata;失败回退 promotions。"""
    import re as _re

    try:
        async with net.client(timeout=20) as client:
            resp = await client.get(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
            )
            resp.raise_for_status()
            text = resp.text
        prefix = f"{mc_version}-"
        out = [
            v[len(prefix):]
            for v in _re.findall(r"<version>([^<]+)</version>", text)
            if v.startswith(prefix)
        ]
        out.reverse()
        if out:
            return out[:60]
    except httpx.HTTPError:
        pass
    # 回退:promotions 的 recommended/latest
    data = await _cached_json(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
    )
    promos = data.get("promos", {})
    out = []
    for suffix in ("recommended", "latest"):
        val = promos.get(f"{mc_version}-{suffix}")
        if val and val not in out:
            out.append(val)
    return out


async def get_forge_installer(mc_version: str, forge_version: str) -> dict:
    base = f"https://maven.minecraftforge.net/net/minecraftforge/forge/{mc_version}-{forge_version}"
    name = f"forge-{mc_version}-{forge_version}-installer.jar"
    url = f"{base}/{name}"
    sha1 = ""
    try:
        async with net.client(timeout=20) as client:
            r = await client.get(url + ".sha1")
            if r.status_code == 200:
                sha1 = r.text.strip()
    except httpx.HTTPError:
        pass
    return {"url": url, "sha1": sha1, "name": name}


# ---- Velocity ----
# 版本号用 "版本#build" 表示具体构建(参考 asPanel)
async def list_velocity_versions(force: bool = False, limit: int = 200) -> list[str]:
    """列出 Velocity 的具体构建:每项形如 "3.5.0-SNAPSHOT#577",新到旧。"""
    data = await _cached_json("https://fill.papermc.io/v3/projects/velocity/versions", force=force)
    out: list[str] = []
    for v in data.get("versions", []):  # 版本已是新到旧
        vid = v["version"]["id"]
        for build in reversed(v.get("builds", [])):  # build id 升序 -> 反转成新到旧
            out.append(f"{vid}#{build}")
            if len(out) >= limit:
                return out
    return out


async def get_velocity_download(spec: str) -> dict:
    """解析 "版本#build"(无 # 则取该版本最新构建)的下载信息。"""
    if "#" in spec:
        version, build_str = spec.split("#", 1)
        target_build = int(build_str)
    else:
        version, target_build = spec, None
    builds = await _cached_json(
        f"https://fill.papermc.io/v3/projects/velocity/versions/{version}/builds"
    )
    if not builds:
        raise ValueError(f"Velocity {version} 无可用构建")
    if target_build is not None:
        best = next((b for b in builds if b.get("id") == target_build), None)
        if best is None:
            raise ValueError(f"Velocity {spec} 不存在该构建")
    else:
        stable = [b for b in builds if b.get("channel") == "STABLE"]
        best = max(stable or builds, key=lambda b: b.get("id", 0))
    dl = best.get("downloads", {}).get("server:default") or next(iter(best.get("downloads", {}).values()))
    return {
        "url": dl["url"],
        "sha256": dl.get("checksums", {}).get("sha256", ""),
        "size": int(dl.get("size", 0) or 0),
    }


async def download_file(url: str, dest, *, chunk_size: int = 1 << 16, progress=None) -> None:
    """流式下载到 dest(pathlib.Path)。

    设读超时:连接停滞 120s 无数据则报错,避免下载永久挂起(只要持续有数据,
    每读到一块就会重置该计时)。progress 回调签名 (downloaded:int, total:int)。
    """
    timeout = httpx.Timeout(30.0, read=120.0)
    async with net.client(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length") or 0)
            downloaded = 0
            if progress:
                progress(downloaded, total)
            with open(dest, "wb") as fp:
                async for chunk in resp.aiter_bytes(chunk_size):
                    fp.write(chunk)
                    downloaded += len(chunk)
                    if progress:
                        progress(downloaded, total)
