"""Mojang 版本清单:列出可用的正式版,以及解析服务端 jar 下载地址。"""
from __future__ import annotations

import time

import httpx

from . import net

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
        async with net.client(timeout=20) as client:
            resp = await client.get(VERSION_MANIFEST_URL)
            resp.raise_for_status()
            data = resp.json()
        cache["data"] = [
            v["id"] for v in data.get("versions", []) if v.get("type") == "release"
        ]
        cache["ts"] = now
    return cache["data"][:limit]


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
