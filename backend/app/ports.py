"""端口工具:空闲探测 + 自动分配。"""
from __future__ import annotations

import os
import socket


def is_port_free(port: int, host: str = "0.0.0.0") -> bool:
    """实地 try-bind 判断端口当前是否可用(含被面板外程序占用的情况)。"""
    if port <= 0 or port > 65535:
        return False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # POSIX servers can reuse their port while closed connections remain
            # in TIME_WAIT. A live listener still prevents this bind. Windows'
            # SO_REUSEADDR can share a live listener, so keep its default here.
            if os.name != "nt":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def find_free_port(taken: set[int], lo: int = 25565, hi: int = 25999) -> int:
    """在 [lo, hi] 内找第一个既不在 taken 里、又未被系统占用的端口;找不到返回 0。"""
    for p in range(lo, hi + 1):
        if p not in taken and is_port_free(p):
            return p
    return 0
