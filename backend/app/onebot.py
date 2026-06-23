"""QQ 互通:OneBot 11 正向 ws 客户端(面板作客户端连 LLBot)。

QQ→MC 渲染照搬 asPanel:整条以 [QQ] <用户> 内容 [↑] 形式注入,各段(文本/表情/@/
图片/语音/文件/分享/回复)用对应颜色 + suggest_command 点击(点击多为 .CQ 形式,
配合 MC→QQ 的 . 前缀可回带表情/@/回复);回复消息单独渲染 │ 回复 <被回复者> 原文 一行。

MC→QQ(在 bridge 里):仅转发以 . 或 。开头的聊天,去前缀后发 <玩家> 内容。
"""
from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

import websockets
from sqlalchemy import select

from .database import SessionLocal
from .models import Server, ServerGroup

_MC_TYPES = ("vanilla", "fabric", "forge")


class OneBotClient:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ws = None
        self._stop = False
        self._connected = False
        self._echo = 0
        self._pending: dict[str, asyncio.Future] = {}
        self.enabled = False
        self.url = ""
        self.token = ""

    def start(self, enabled: bool, url: str, token: str) -> None:
        self.enabled, self.url, self.token = enabled, url.strip(), token.strip()
        self._stop = False
        self._loop = asyncio.get_running_loop()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    def reconfigure(self, enabled: bool, url: str, token: str) -> None:
        """可能从同步线程池(设置接口)调用,不能假设当前线程有事件循环。"""
        self.enabled, self.url, self.token = enabled, url.strip(), token.strip()
        if self._ws is None or self._loop is None:
            return
        try:
            asyncio.get_running_loop()
            self._loop.create_task(self._close_ws())
        except RuntimeError:
            # 在没有运行 loop 的线程里:跨线程调度到客户端所在 loop
            try:
                asyncio.run_coroutine_threadsafe(self._close_ws(), self._loop)
            except Exception:  # noqa: BLE001
                pass

    async def _close_ws(self) -> None:
        try:
            if self._ws is not None:
                await self._ws.close()
        except Exception:  # noqa: BLE001
            pass

    @property
    def connected(self) -> bool:
        return self._connected

    async def _run(self) -> None:
        while not self._stop:
            if not self.enabled or not self.url:
                await asyncio.sleep(3)
                continue
            uri = self.url
            if self.token:
                uri += ("&" if "?" in uri else "?") + "access_token=" + quote(self.token)
            try:
                async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
                    self._ws = ws
                    self._connected = True
                    async for raw in ws:
                        try:
                            self._dispatch(json.loads(raw))
                        except Exception:  # noqa: BLE001
                            pass
            except Exception:  # noqa: BLE001
                pass
            finally:
                self._connected = False
                self._ws = None
            await asyncio.sleep(5)

    def _dispatch(self, data: dict) -> None:
        echo = data.get("echo")
        if echo is not None:
            fut = self._pending.pop(str(echo), None)
            if fut and not fut.done():
                fut.set_result(data)
            return
        if data.get("post_type") == "message" and data.get("message_type") == "group":
            asyncio.create_task(_process_group_message(data))

    # ---------- 发 ----------
    def send_group(self, group_id: int, text: str) -> None:
        if not self._connected or self._ws is None:
            return
        action = {"action": "send_group_msg", "params": {"group_id": group_id, "message": text}}
        try:
            asyncio.create_task(self._ws.send(json.dumps(action, ensure_ascii=False)))
        except Exception:  # noqa: BLE001
            pass

    async def call_action(self, action: str, params: dict, timeout: float = 5.0) -> dict | None:
        if not self._connected or self._ws is None:
            return None
        self._echo += 1
        echo = f"mcp_{self._echo}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[echo] = fut
        try:
            await self._ws.send(json.dumps({"action": action, "params": params, "echo": echo}))
            return await asyncio.wait_for(fut, timeout)
        except Exception:  # noqa: BLE001
            self._pending.pop(echo, None)
            return None


client = OneBotClient()


# ---------- 消息段工具 ----------
def _seg_list(message) -> list[dict]:
    if isinstance(message, list):
        return message
    if isinstance(message, str):
        return [{"type": "text", "data": {"text": message}}]
    return []


def _web_segments(message, reply_user: str | None, reply_plain: str | None) -> list[dict]:
    """OneBot 消息 → 聊天室前端用的结构化段(回复内容已预先解析)。"""
    out: list[dict] = []
    if reply_user is not None:
        out.append({"type": "reply", "user": reply_user, "text": (reply_plain or "")[:80]})
    for seg in _seg_list(message):
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            out.append({"type": "text", "text": str(d.get("text") or "")})
        elif t == "at":
            out.append({"type": "at", "qq": str(d.get("qq") or ""), "name": str(d.get("name") or d.get("text") or "")})
        elif t == "image":
            out.append({"type": "image", "url": str(d.get("url") or d.get("file") or "")})
        elif t == "face":
            out.append({"type": "face", "id": str(d.get("id") or "")})
        elif t == "record":
            out.append({"type": "text", "text": "[语音]"})
        elif t == "video":
            out.append({"type": "text", "text": "[视频]"})
        elif t == "file":
            out.append({"type": "text", "text": "[文件]"})
    return out


def _plain(message) -> str:
    out = []
    for seg in _seg_list(message):
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            out.append(str(d.get("text") or ""))
        elif t == "at":
            out.append(f"@{d.get('name') or d.get('qq')}")
    return "".join(out)


def _seg_comp(seg: dict, modern: bool) -> dict | None:
    from . import bridge

    t, d = seg.get("type"), seg.get("data") or {}
    if t == "text":
        return {"text": str(d.get("text") or ""), "color": "gray"}
    if t == "face":
        comp = {"text": "[表情]", "color": "yellow"}
        comp.update(bridge.click_event("suggest_command", f".[CQ:face,id={d.get('id')}] ", modern))
        return comp
    if t == "at":
        qq = str(d.get("qq") or "")
        name = str(d.get("name") or d.get("text") or qq)
        disp = "@全体成员" if qq.lower() == "all" else f"@{name}"
        comp = {"text": disp, "color": "aqua"}
        if qq and qq.lower() != "all":
            comp.update(bridge.click_event("suggest_command", f".[CQ:at,qq={qq}] ", modern))
        return comp
    if t == "image":
        url = str(d.get("url") or d.get("file") or "")
        comp = {"text": "[图片]", "color": "aqua"}
        if url:
            comp.update(bridge.click_event("suggest_command", url, modern))
        return comp
    if t == "record":
        url = str(d.get("url") or d.get("file") or "")
        comp = {"text": "[语音]", "color": "aqua"}
        if url:
            comp.update(bridge.click_event("suggest_command", url, modern))
        return comp
    if t == "video":
        return {"text": "[短视频]", "color": "gray"}
    if t in ("share", "json", "xml"):
        url = str(d.get("url") or d.get("jumpUrl") or d.get("file") or "")
        comp = {"text": "[链接]", "color": "aqua"}
        if url:
            comp.update(bridge.click_event("suggest_command", url, modern))
        return comp
    if t == "file":
        url = str(d.get("url") or d.get("file") or "")
        comp = {"text": "[文件]", "color": "aqua"}
        if url:
            comp.update(bridge.click_event("suggest_command", url, modern))
        return comp
    if t == "forward":
        return {"text": "[合并转发]", "color": "gray"}
    return None  # reply 单独处理


def _main_line(user: str, sender_qq: str, message, message_id, modern: bool) -> list:
    from . import bridge

    parts: list = ["", {"text": "[QQ] ", "color": "gray"}]
    up = {"text": f"<{user}> ", "color": "gray"}
    if sender_qq:
        up.update(bridge.click_event("suggest_command", f".[CQ:at,qq={sender_qq}] ", modern))
    parts.append(up)
    for seg in _seg_list(message):
        c = _seg_comp(seg, modern)
        if c:
            parts.append(c)
    if message_id is not None:
        up2 = {"text": " [↑]", "color": "gray"}
        up2.update(bridge.click_event("suggest_command", f".[CQ:reply,id={message_id}] ", modern))
        parts.append(up2)
    return parts


def _reply_line(reply_user: str, reply_plain: str, modern: bool) -> list:
    content = reply_plain.strip()
    if len(content) > 40:
        content = content[:40] + "…"
    return [
        "",
        {"text": "│ ", "color": "dark_gray"},
        {"text": "回复 ", "color": "light_purple"},
        {"text": f"<{reply_user}> ", "color": "dark_gray"},
        {"text": content, "color": "dark_gray"},
    ]


# ---------- QQ → MC ----------
async def _process_group_message(payload: dict) -> None:
    from . import bridge
    from .mcdr import manager

    qq_group = int(payload.get("group_id") or 0)
    sender = payload.get("sender") or {}
    user = str(sender.get("card") or sender.get("nickname") or payload.get("user_id") or "?")
    sender_qq = str(payload.get("user_id") or "")
    message = payload.get("message")
    message_id = payload.get("message_id")

    # 目标:所有绑定了该 QQ 群的互联组内的 MC 实例
    db = SessionLocal()
    try:
        targets: list[tuple[int, str]] = []
        feed_groups: list[int] = []
        for g in db.scalars(select(ServerGroup)).all():
            try:
                ids = [int(x) for x in json.loads(g.qq_group_ids or "[]")]
            except Exception:  # noqa: BLE001
                ids = []
            if qq_group not in ids:
                continue
            feed_groups.append(g.id)
            for s in db.scalars(select(Server).where(Server.group_id == g.id)).all():
                if s.server_type in _MC_TYPES:
                    targets.append((s.id, s.mc_version))
    finally:
        db.close()

    # 回复:取被回复消息内容(get_msg)
    reply_user = reply_plain = None
    for seg in _seg_list(message):
        if seg.get("type") == "reply":
            rid = (seg.get("data") or {}).get("id")
            if rid:
                resp = await client.call_action("get_msg", {"message_id": int(rid)})
                d = (resp or {}).get("data") or {}
                rs = d.get("sender") or {}
                reply_user = str(rs.get("card") or rs.get("nickname") or d.get("user_id") or "")
                reply_plain = _plain(d.get("message"))
            break

    # 推到聊天室(结构化段:文本/图片/@/表情/回复 + 头像)
    from . import chat

    feed = {
        "source": "qq",
        "sender": user,
        "sender_id": sender_qq,
        "avatar": f"https://q1.qlogo.cn/g?b=qq&nk={sender_qq}&s=100" if sender_qq else "",
        "text": _plain(message),
        "segments": _web_segments(message, reply_user, reply_plain),
    }
    for gid in feed_groups:
        chat.publish(gid, feed)
    if not targets:
        return

    loop = asyncio.get_running_loop()
    at_names = [s for s in _plain(message).replace("@", " @").split() if s.startswith("@")]
    for sid, mc_version in targets:
        if not manager.is_running(sid):
            continue
        modern = bridge._modern(mc_version)
        if reply_user is not None:
            loop.create_task(bridge._safe_send(sid, "tellraw @a " + json.dumps(_reply_line(reply_user, reply_plain or "", modern), ensure_ascii=False)))
        cmd = "tellraw @a " + json.dumps(_main_line(user, sender_qq, message, message_id, modern), ensure_ascii=False)
        loop.create_task(bridge._safe_send(sid, cmd))
        # @ 在线真人 → 提示音
        plain_low = _plain(message).lower()
        for p in bridge.online_players(sid):
            if f"@{p}".lower() in plain_low:
                loop.create_task(bridge._safe_send(sid, f"execute at {p} run playsound minecraft:entity.experience_orb.pickup player {p}"))
