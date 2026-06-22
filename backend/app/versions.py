"""Mojang 版本清单:列出可用的正式版,以及解析服务端 jar 下载地址。"""
from __future__ import annotations

import httpx

VERSION_MANIFEST_URL = (
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
)


async def list_release_versions(limit: int = 60) -> list[str]:
    """返回最近的若干正式版(release)版本号,新到旧。"""
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(VERSION_MANIFEST_URL)
        resp.raise_for_status()
        data = resp.json()
    releases = [v["id"] for v in data.get("versions", []) if v.get("type") == "release"]
    return releases[:limit]


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
