"""Mojang 版本清单:列出可用的正式版,以及解析服务端 jar 下载地址。"""
from __future__ import annotations

import time

import httpx

VERSION_MANIFEST_URL = (
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
)

# 正式版列表的内存 TTL 缓存(进程级,所有客户端共享)。
VERSIONS_CACHE_TTL = 1800  # 30 分钟
_versions_cache: dict = {"data": None, "ts": 0.0}


async def list_release_versions(limit: int = 60, force: bool = False) -> list[str]:
    """返回最近的若干正式版(release)版本号,新到旧。

    结果带 TTL 缓存;force=True 时无视缓存强制刷新并更新缓存。
    """
    now = time.time()
    cache = _versions_cache
    fresh = cache["data"] is not None and now - cache["ts"] < VERSIONS_CACHE_TTL
    if force or not fresh:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(VERSION_MANIFEST_URL)
            resp.raise_for_status()
            data = resp.json()
        cache["data"] = [
            v["id"] for v in data.get("versions", []) if v.get("type") == "release"
        ]
        cache["ts"] = now
    return cache["data"][:limit]


async def get_server_jar_url(mc_version: str) -> str:
    """解析指定版本的官方服务端 jar 下载地址。"""
    async with httpx.AsyncClient(timeout=20) as client:
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
    return server["url"]


async def download_file(url: str, dest, *, chunk_size: int = 1 << 16) -> None:
    """流式下载到 dest(pathlib.Path)。"""
    async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as fp:
                async for chunk in resp.aiter_bytes(chunk_size):
                    fp.write(chunk)
