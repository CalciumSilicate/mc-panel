"""互联组内的玩家聊天 / 进退服互转(照搬 asPanel 的 tellraw 渲染)。

机制(全程在面板进程内,无需 MCDR 插件):
  - manager 逐行钩子捕获实例控制台:玩家聊天、登录(含 bot 判定)、退出
  - 查该实例所属互联组(bridge_enabled)内其它**运行中的 MC 实例**
  - 用 ``tellraw @a`` 注入,按目标服 MC 版本生成兼容的点击事件格式

bot / 真人分类(同 asPanel):登录行 ``名字[local] logged in`` 为假人,
``名字[/地址] logged in`` 为真人;退出时按登录时记下的假人集合判定。

防回环:``tellraw`` 不回显控制台,不产生新聊天/登录行;聊天正则另锚定
``]:`` 后紧跟 ``<名字>`` 作双保险。
"""
from __future__ import annotations

import asyncio
import json
import re

from sqlalchemy import select

from .database import SessionLocal
from .models import Server, ServerGroup

# 真实聊天:日志前缀 "]: " 后紧跟 "<玩家名> 内容"
_CHAT_RE = re.compile(r"\]:\s*<([^>]{1,16})>\s+(.+?)\s*$")
# 登录:"名字[local|/地址] logged in with entity id ..."
_JOIN_RE = re.compile(r"\]:\s*(\w{1,16})\[([^\]]*)\]\s+logged in with entity id\b")
# 退出:"名字 left the game"
_LEFT_RE = re.compile(r"\]:\s*(\w{1,16})\s+left the game\b")

_MC_TYPES = ("vanilla", "fabric", "forge")
# server_id -> 当前在线的假人名集合(用于退出时分类)
_BOTS: dict[int, set[str]] = {}


# ---------- 版本兼容的组件构造 ----------
def _modern(mc_version: str) -> bool:
    """MC 1.21.5+ 改了文本组件的 clickEvent 字段(value→command/url)。
    用数字段元组比较;无法解析(新快照/新版号方案)时按新格式处理。"""
    nums = re.findall(r"\d+", mc_version or "")
    if not nums:
        return True
    return tuple(int(x) for x in nums[:3]) >= (1, 21, 5)


def _click(action: str, value: str, modern: bool) -> dict:
    if modern:
        key = "url" if action == "open_url" else "command"
        return {"action": action, key: value}
    return {"action": action, "value": value}


def _gray(text: str) -> dict:
    return {"text": text, "color": "gray"}


def _prefix(src: str, modern: bool) -> list:
    """[来源服] (灰色,来源服可点击建议 /server)"""
    return [
        _gray("["),
        {"text": src, "color": "gray", "clickEvent": _click("suggest_command", f"/server {src}", modern)},
        _gray("] "),
    ]


def _player(player: str, wrap: bool, modern: bool) -> dict:
    text = f"<{player}> " if wrap else player
    return {"text": text, "color": "gray", "clickEvent": _click("suggest_command", f"@ {player}", modern)}


def _chat_components(src: str, player: str, content: str, modern: bool) -> list:
    return ["", *_prefix(src, modern), _player(player, True, modern), _gray(content)]


def _join_components(src: str, player: str, is_bot: bool, modern: bool) -> list:
    parts = ["", *_prefix(src, modern), _player(player, False, modern)]
    if is_bot:
        parts.append({"text": " (假人)", "color": "dark_gray"})
    parts.append(_gray(" 加入了服务器"))
    return parts


def _leave_components(src: str, player: str, is_bot: bool, modern: bool) -> list:
    parts = ["", *_prefix(src, modern), _player(player, False, modern)]
    if is_bot:
        parts.append({"text": " (假人)", "color": "dark_gray"})
    parts.append(_gray(" 离开了服务器"))
    return parts


# ---------- 主入口 ----------
def handle_line(server_id: int, line: str) -> None:
    if "]:" not in line:
        return
    if "<" in line:
        m = _CHAT_RE.search(line)
        if m:
            content = m.group(2).strip()
            if content and not content.startswith("!!"):
                _broadcast(server_id, lambda src, modern: _chat_components(src, m.group(1).strip(), content, modern))
            return
    mj = _JOIN_RE.search(line)
    if mj:
        name, conn = mj.group(1), mj.group(2)
        is_bot = conn.strip().lower() == "local"
        _BOTS.setdefault(server_id, set())
        if is_bot:
            _BOTS[server_id].add(name)
        else:
            _BOTS[server_id].discard(name)
        _broadcast(server_id, lambda src, modern: _join_components(src, name, is_bot, modern))
        return
    ml = _LEFT_RE.search(line)
    if ml:
        name = ml.group(1)
        is_bot = name in _BOTS.get(server_id, set())
        _BOTS.get(server_id, set()).discard(name)
        _broadcast(server_id, lambda src, modern: _leave_components(src, name, is_bot, modern))


def _broadcast(server_id: int, builder) -> None:
    """builder(src_name, modern) -> tellraw 组件列表;向同组其它运行中的 MC 实例注入。"""
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
            (s.id, s.mc_version)
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

    for tid, mc_version in targets:
        if not manager.is_running(tid):
            continue
        components = builder(src_name, _modern(mc_version))
        cmd = "tellraw @a " + json.dumps(components, ensure_ascii=False)
        loop.create_task(_safe_send(tid, cmd))


async def _safe_send(server_id: int, command: str) -> None:
    from .mcdr import manager

    try:
        await manager.send_raw(server_id, command)
    except Exception:  # noqa: BLE001 - 目标可能刚好停了,忽略
        pass
