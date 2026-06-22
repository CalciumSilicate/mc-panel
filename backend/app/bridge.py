"""互联组内的玩家聊天互转。

机制(全程在面板进程内,无需 MCDR 插件):
  - manager 逐行钩子捕获某实例控制台里的玩家聊天 ``]: <玩家名> 内容``
  - 查该实例所属互联组(bridge_enabled)内其它**运行中的 MC 实例**
  - 用 ``say`` 注入:``[来源服] 玩家: 内容``

防回环:
  - 聊天正则锚定在日志前缀 ``]:`` 之后紧跟 ``<名字>``,而注入的 say 行是
    ``]: [Server] [来源服] 玩家: 内容``(``]:`` 后不是 ``<``),不会被再次匹配。
  - 注入文本不含尖括号,双保险。
"""
from __future__ import annotations

import asyncio
import re

from sqlalchemy import select

from .database import SessionLocal
from .models import Server, ServerGroup

# 仅匹配真实聊天行:日志前缀 "]: " 之后紧跟 "<玩家名> 内容"
_CHAT_RE = re.compile(r"\]:\s*<([^>]{1,16})>\s+(.+?)\s*$")
# 代理端无玩家聊天,不参与
_MC_TYPES = ("vanilla", "fabric", "forge")


def handle_line(server_id: int, line: str) -> None:
    if "<" not in line or "]:" not in line:
        return
    m = _CHAT_RE.search(line)
    if not m:
        return
    player, content = m.group(1).strip(), m.group(2).strip()
    if not content or content.startswith("!!"):  # 跳过空消息与 !! 指令(如绑定码)
        return

    db = SessionLocal()
    try:
        src = db.get(Server, server_id)
        if src is None or not src.group_id or src.server_type not in _MC_TYPES:
            return
        grp = db.get(ServerGroup, src.group_id)
        if grp is None or not grp.bridge_enabled:
            return
        src_name = src.name
        targets = [
            (s.id, s.name)
            for s in db.scalars(
                select(Server).where(Server.group_id == src.group_id, Server.id != server_id)
            ).all()
            if s.server_type in _MC_TYPES
        ]
    finally:
        db.close()

    if not targets:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    from .mcdr import manager

    text = f"say [{src_name}] {player}: {content}"
    for tid, _name in targets:
        if manager.is_running(tid):
            loop.create_task(_safe_send(tid, text))


async def _safe_send(server_id: int, command: str) -> None:
    from .mcdr import manager

    try:
        await manager.send_raw(server_id, command)
    except Exception:  # noqa: BLE001 - 目标可能刚好停了,忽略
        pass
