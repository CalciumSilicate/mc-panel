"""统一出站 HTTP 客户端:集中应用「下载代理」设置。

代理地址来自系统设置(download_proxy),由 get_settings_row 在每次读取设置时同步到
这里的模块级变量,所有联网请求(Mojang 核心、MCDR 插件库、Modrinth、文件下载)都经
net.client() 创建客户端,从而统一走代理。空 = 直连。
"""
from __future__ import annotations

import httpx

_proxy: str | None = None


def set_proxy(proxy: str | None) -> None:
    global _proxy
    _proxy = (proxy or "").strip() or None


def get_proxy() -> str | None:
    return _proxy


def client(**kwargs) -> httpx.AsyncClient:
    """创建带当前代理设置的 AsyncClient。"""
    return httpx.AsyncClient(proxy=_proxy, **kwargs)
