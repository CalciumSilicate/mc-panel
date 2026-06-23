"""聊天室:按互联组的实时消息流(内存级,进程内)。

bridge / onebot 处理 MC/QQ 事件时顺带 publish 到这里;web 发的消息也 publish。
聊天室 WebSocket 连接后回放最近消息,再实时推送。不落库(重启清空,和控制台一致)。
"""
from __future__ import annotations

import asyncio
import time
from collections import deque

_BUFFER = 200
_QUEUE_MAX = 500
_buffers: dict[int, deque[dict]] = {}
_subs: dict[int, set[asyncio.Queue]] = {}


def publish(group_id: int | None, msg: dict) -> None:
    """msg: {source: mc|qq|web|system, server?, player?, user?, text, ts}"""
    if not group_id:
        return
    msg.setdefault("ts", time.time())
    buf = _buffers.setdefault(group_id, deque(maxlen=_BUFFER))
    buf.append(msg)
    for q in list(_subs.get(group_id, set())):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


def recent(group_id: int) -> list[dict]:
    return list(_buffers.get(group_id, ()))


def subscribe(group_id: int) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _subs.setdefault(group_id, set()).add(q)
    return q


def unsubscribe(group_id: int, q: asyncio.Queue) -> None:
    s = _subs.get(group_id)
    if s:
        s.discard(q)
