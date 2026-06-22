"""QQ 互通:OneBot 11 正向 ws 客户端(面板作客户端连 LLBot)。

- 后台重连循环连接 LLBot 的 ob11.ws;收 group 消息 → 注入绑定互联组内的 MC 实例;
  发送动作 send_group_msg 把 MC 侧消息发回 QQ 群。
- QQ→MC 照搬 asPanel 的 CQ 段渲染(文本/图片/表情/@/回复…)成 tellraw 组件。
- 配置来自 SystemSettings(onebot_enabled / onebot_ws_url / onebot_token)。
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
        self._ws = None
        self._stop = False
        self._connected = False
        self.enabled = False
        self.url = ""
        self.token = ""

    # ---------- 生命周期 ----------
    def start(self, enabled: bool, url: str, token: str) -> None:
        self.enabled, self.url, self.token = enabled, url.strip(), token.strip()
        self._stop = False
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    def reconfigure(self, enabled: bool, url: str, token: str) -> None:
        self.enabled, self.url, self.token = enabled, url.strip(), token.strip()
        # 关掉当前连接让重连循环用新配置重连
        if self._ws is not None:
            asyncio.create_task(self._close_ws())

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
                            self._on_message(json.loads(raw))
                        except Exception:  # noqa: BLE001 - 单条消息异常不断流
                            pass
            except Exception:  # noqa: BLE001 - 连接失败/中断,稍后重连
                pass
            finally:
                self._connected = False
                self._ws = None
            await asyncio.sleep(5)

    # ---------- 收 ----------
    def _on_message(self, data: dict) -> None:
        if data.get("post_type") != "message" or data.get("message_type") != "group":
            return
        group_id = data.get("group_id")
        sender = data.get("sender") or {}
        name = str(sender.get("card") or sender.get("nickname") or data.get("user_id") or "?")
        message = data.get("message")
        _handle_qq_group_message(int(group_id), name, message)

    # ---------- 发 ----------
    def send_group(self, group_id: int, text: str) -> None:
        """把纯文本发到 QQ 群(fire-and-forget)。"""
        if not self._connected or self._ws is None:
            return
        action = {"action": "send_group_msg", "params": {"group_id": group_id, "message": text}}
        try:
            asyncio.create_task(self._ws.send(json.dumps(action, ensure_ascii=False)))
        except Exception:  # noqa: BLE001
            pass


client = OneBotClient()


# ---------- QQ → MC ----------
def _handle_qq_group_message(qq_group_id: int, sender: str, message) -> None:
    """收到 QQ 群消息:注入所有绑定了该 QQ 群的互联组内运行中的 MC 实例。"""
    from . import bridge

    db = SessionLocal()
    try:
        targets: list[tuple[int, str]] = []  # (server_id, mc_version)
        for g in db.scalars(select(ServerGroup)).all():
            try:
                ids = json.loads(g.qq_group_ids or "[]")
            except Exception:  # noqa: BLE001
                ids = []
            if qq_group_id not in [int(x) for x in ids]:
                continue
            for s in db.scalars(select(Server).where(Server.group_id == g.id)).all():
                if s.server_type in _MC_TYPES:
                    targets.append((s.id, s.mc_version))
    finally:
        db.close()
    if not targets:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    from .mcdr import manager

    plain = _segments_to_plain(message)
    for sid, mc_version in targets:
        if not manager.is_running(sid):
            continue
        components = _qq_components(sender, message, bridge._modern(mc_version))
        cmd = "tellraw @a " + json.dumps(components, ensure_ascii=False)
        loop.create_task(bridge._safe_send(sid, cmd))
        # @ 在线本地真人 → 提示音
        for player in bridge.online_players(sid):
            if f"@{player}".lower() in plain.lower() or f"@ {player}".lower() in plain.lower():
                loop.create_task(
                    bridge._safe_send(
                        sid,
                        f"execute at {player} run playsound minecraft:entity.experience_orb.pickup player {player}",
                    )
                )


def _seg_list(message) -> list[dict]:
    """OneBot 消息归一成段数组(兼容 array 与 string/CQ 两种 messageFormat)。"""
    if isinstance(message, list):
        return message
    if isinstance(message, str):
        return [{"type": "text", "data": {"text": message}}]
    return []


def _segments_to_plain(message) -> str:
    out = []
    for seg in _seg_list(message):
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            out.append(str(d.get("text") or ""))
        elif t == "at":
            out.append(f"@{d.get('qq')}")
    return "".join(out)


def _qq_components(sender: str, message, modern: bool) -> list:
    """照搬 asPanel:[QQ] 昵称: <富文本段>。图片/表情/@/回复等转可读组件。"""
    from . import bridge

    parts: list = [
        "",
        {"text": "[QQ] ", "color": "gold"},
        {"text": f"{sender}: ", "color": "aqua"},
    ]
    for seg in _seg_list(message):
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            parts.append({"text": str(d.get("text") or ""), "color": "white"})
        elif t == "at":
            parts.append({"text": f"@{d.get('qq')} ", "color": "aqua"})
        elif t == "image":
            url = str(d.get("url") or d.get("file") or "")
            c = {"text": "[图片]", "color": "aqua"}
            if url:
                c["clickEvent"] = bridge._click("open_url", url, modern)
            parts.append(c)
        elif t == "face":
            parts.append({"text": "[表情]", "color": "yellow"})
        elif t == "record":
            parts.append({"text": "[语音]", "color": "aqua"})
        elif t == "video":
            parts.append({"text": "[视频]", "color": "aqua"})
        elif t == "file":
            parts.append({"text": "[文件]", "color": "aqua"})
        elif t == "reply":
            parts.append({"text": "[回复] ", "color": "light_purple"})
        elif t == "json":
            parts.append({"text": "[卡片]", "color": "gray"})
    return parts
