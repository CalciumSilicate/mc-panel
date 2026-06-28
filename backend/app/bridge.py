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

from . import chat, cqcode
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
# server_id -> 当前在线的真人名集合(用于 QQ @ 提示音)
_ONLINE: dict[int, set[str]] = {}


def online_players(server_id: int) -> set[str]:
    return _ONLINE.get(server_id, set())


def _group_online_count(server_id: int) -> int:
    """该实例所属互联组的在线真人总数(跨组内 MC 实例去重)。"""
    db = SessionLocal()
    try:
        src = db.get(Server, server_id)
        if src is None:
            return 0
        if not src.group_id:
            return len(_ONLINE.get(server_id, set()))
        sids = [
            s.id
            for s in db.scalars(select(Server).where(Server.group_id == src.group_id)).all()
            if s.server_type in _MC_TYPES
        ]
    finally:
        db.close()
    names: set[str] = set()
    for sid in sids:
        names |= _ONLINE.get(sid, set())
    return len(names)


# ---------- 版本兼容的组件构造 ----------
def _modern(mc_version: str) -> bool:
    """MC 1.21.5+ 改了文本组件的 clickEvent 字段(value→command/url)。
    用数字段元组比较;无法解析(新快照/新版号方案)时按新格式处理。"""
    nums = re.findall(r"\d+", mc_version or "")
    if not nums:
        return True
    return tuple(int(x) for x in nums[:3]) >= (1, 21, 5)


def click_event(action: str, value: str, modern: bool) -> dict:
    """生成文本组件里挂载点击事件的那部分(含正确的外层键名)。

    1.21.5+ : 外层键 ``click_event``,内层 suggest/run 用 ``command``、open_url 用 ``url``。
    旧版    : 外层键 ``clickEvent``,内层统一 ``value``。
    返回可直接用 ``**`` 合并进组件的 dict。
    """
    if modern:
        inner = {"action": action, ("url" if action == "open_url" else "command"): value}
        return {"click_event": inner}
    return {"clickEvent": {"action": action, "value": value}}


# 兼容旧调用名
def _click(action: str, value: str, modern: bool) -> dict:
    return click_event(action, value, modern)


def _gray(text: str) -> dict:
    return {"text": text, "color": "gray"}


def _prefix(src: str, modern: bool) -> list:
    """[来源服] (灰色,来源服可点击建议 /server)"""
    return [
        _gray("["),
        {"text": src, "color": "gray", **click_event("suggest_command", f"/server {src}", modern)},
        _gray("] "),
    ]


def _player(player: str, wrap: bool, modern: bool) -> dict:
    text = f"<{player}> " if wrap else player
    return {"text": text, "color": "gray", **click_event("suggest_command", f"@ {player}", modern)}


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
            player, content = m.group(1).strip(), m.group(2).strip()
            if content and not content.startswith("!!"):
                # MC→QQ:仅转发以 . / 。 开头的,去前缀(同 asPanel)
                qq_text = None
                if content[:1] in (".", "。"):
                    msg = content[1:].lstrip()
                    if msg:
                        qq_text = f"<{player}> {msg}"
                _broadcast(
                    server_id,
                    lambda src, modern: _chat_components(src, player, content, modern),
                    qq_text,
                    {
                        "source": "mc",
                        "sender": player,
                        "avatar": f"https://mc-heads.net/avatar/{player}/64",
                        "text": content,
                        "segments": cqcode.parse(content),
                    },
                )
            return
    mj = _JOIN_RE.search(line)
    if mj:
        name, conn = mj.group(1), mj.group(2)
        is_bot = conn.strip().lower() == "local"
        _BOTS.setdefault(server_id, set())
        _ONLINE.setdefault(server_id, set())
        if is_bot:
            _BOTS[server_id].add(name)
            return  # 假人进服不广播
        _BOTS[server_id].discard(name)
        before = _group_online_count(server_id)
        _ONLINE[server_id].add(name)
        after = _group_online_count(server_id)
        _broadcast(
            server_id,
            lambda src, modern: _join_components(src, name, False, modern),
            f"+{name} ({before}→{after})",
            {"source": "system", "text": f"{name} 加入了服务器"},
        )
        return
    ml = _LEFT_RE.search(line)
    if ml:
        name = ml.group(1)
        if name in _BOTS.get(server_id, set()):
            _BOTS[server_id].discard(name)
            return  # 假人退服不广播
        before = _group_online_count(server_id)
        _ONLINE.get(server_id, set()).discard(name)
        after = _group_online_count(server_id)
        _broadcast(
            server_id,
            lambda src, modern: _leave_components(src, name, False, modern),
            f"-{name} ({before}→{after})",
            {"source": "system", "text": f"{name} 离开了服务器"},
        )


def _broadcast(server_id: int, builder, qq_text: str = "", feed: dict | None = None) -> None:
    """builder(src_name, modern) -> tellraw 组件;转给同组其它运行中的 MC 实例,
    把 qq_text 发到该组绑定的 QQ 群,并把 feed 推到聊天室。"""
    db = SessionLocal()
    try:
        src = db.get(Server, server_id)
        if src is None or not src.group_id or src.server_type not in _MC_TYPES:
            return
        grp = db.get(ServerGroup, src.group_id)
        if grp is None or not grp.bridge_enabled:
            return
        src_name = src.name
        group_id = src.group_id
        try:
            qq_ids = [int(x) for x in json.loads(grp.qq_group_ids or "[]")]
        except Exception:  # noqa: BLE001
            qq_ids = []
        targets = [
            (s.id, s.mc_version)
            for s in db.scalars(
                select(Server).where(Server.group_id == src.group_id, Server.id != server_id)
            ).all()
            if s.server_type in _MC_TYPES
        ]
    finally:
        db.close()

    # 推到聊天室(网页实时可见)
    if feed is not None:
        feed["server"] = src_name
        chat.publish(group_id, feed)

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

    # MC → QQ(文本已按 asPanel 规则组装,不再加 [来源服] 前缀)
    if qq_ids and qq_text:
        from .onebot import client as ob

        if ob.connected:
            for gid in qq_ids:
                ob.send_group(gid, qq_text)


async def _safe_send(server_id: int, command: str) -> None:
    """转发 tellraw 到目标实例:配置了 RCON 则优先走 RCON(不污染控制台/日志),
    未开 RCON 回退 stdin。聊天互转的三个方向(跨服 / QQ→MC / 网页→MC)都经此下发。
    目标可能刚好停了,异常忽略。"""
    from .mcdr import manager

    db = SessionLocal()
    try:
        srv = db.get(Server, server_id)
        rcon_port = srv.rcon_port if srv and srv.rcon_enabled else 0
        rcon_password = srv.rcon_password if srv else ""
    finally:
        db.close()
    try:
        await manager.send_cmd(server_id, command, rcon_port, rcon_password)
    except Exception:  # noqa: BLE001 - 目标可能刚好停了,忽略
        pass
