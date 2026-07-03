"""QQ 互通:OneBot 11 正向 ws 客户端(面板作客户端连 LLBot)。

QQ→MC 渲染照搬 asPanel:整条以 [QQ] <用户> 内容 [↑] 形式注入,各段(文本/表情/@/
图片/语音/文件/分享/回复)用对应颜色 + suggest_command 点击(点击多为 .CQ 形式,
配合 MC→QQ 的 . 前缀可回带表情/@/回复);回复消息单独渲染 │ 回复 <被回复者> 原文 一行。

MC→QQ(在 bridge 里):仅转发以 . 或 。开头的聊天,去前缀后发 <玩家> 内容。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
from urllib.parse import quote

import websockets
from sqlalchemy import select

from . import net
from .config import API_PORT, CHAT_IMG_DIR
from .database import SessionLocal
from .models import Server, ServerGroup


async def _cache_image(url: str) -> str:
    """把 QQ 图片下载到本地缓存,返回 /api/chat/img/<name>;失败回退原 url。"""
    if not url or url.startswith("/api/"):
        return url
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()
    CHAT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    for p in CHAT_IMG_DIR.glob(h + ".*"):
        return f"/api/chat/img/{p.name}"
    try:
        async with net.client(timeout=20, follow_redirects=True) as c:
            r = await c.get(url)
            r.raise_for_status()
        ext = mimetypes.guess_extension((r.headers.get("content-type") or "").split(";")[0].strip()) or ".png"
        name = h + ext
        (CHAT_IMG_DIR / name).write_bytes(r.content)
        return f"/api/chat/img/{name}"
    except Exception:  # noqa: BLE001
        return url


# qq 号 -> 群名片/昵称 缓存(由成员列表接口填充,用于 @ 显示名字)
_member_names: dict[str, str] = {}


def remember_members(members: list[dict]) -> None:
    for m in members:
        uid = str(m.get("user_id") or "")
        if uid:
            _member_names[uid] = str(m.get("card") or m.get("nickname") or uid)


def member_name(qq: str) -> str:
    return _member_names.get(str(qq), str(qq))

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


def _web_segments(message, reply_user: str | None, reply_plain: str | None, img_map: dict | None = None) -> list[dict]:
    """OneBot 消息 → 聊天室前端用的结构化段(回复内容已预先解析;图片用本地缓存路径)。"""
    img_map = img_map or {}
    out: list[dict] = []
    if reply_user is not None:
        out.append({"type": "reply", "user": reply_user, "text": (reply_plain or "")[:80]})
    for seg in _seg_list(message):
        t, d = seg.get("type"), seg.get("data") or {}
        if t == "text":
            out.append({"type": "text", "text": str(d.get("text") or "")})
        elif t == "at":
            qq = str(d.get("qq") or "")
            out.append({"type": "at", "qq": qq, "name": str(d.get("name") or d.get("text") or "") or member_name(qq)})
        elif t == "image":
            u = str(d.get("url") or d.get("file") or "")
            out.append({"type": "image", "url": img_map.get(u, u)})
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


def _seg_comp(seg: dict, modern: bool, img_map: dict, base_url: str) -> dict | None:
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
        name = str(d.get("name") or d.get("text") or "") or member_name(qq)
        disp = "@全体成员" if qq.lower() == "all" else f"@{name}"
        comp = {"text": disp, "color": "aqua"}
        if qq and qq.lower() != "all":
            comp.update(bridge.click_event("suggest_command", f".[CQ:at,qq={qq}] ", modern))
        return comp
    if t == "image":
        url = str(d.get("url") or d.get("file") or "")
        local = img_map.get(url, "")
        comp = {"text": "[图片]", "color": "aqua"}
        if local:
            comp.update(bridge.click_event("open_url", base_url + local, modern))
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


def _main_line(user: str, sender_qq: str, message, message_id, modern: bool, img_map: dict, base_url: str) -> list:
    from . import bridge

    parts: list = ["", {"text": "[QQ] ", "color": "gray"}]
    up = {"text": f"<{user}> ", "color": "gray"}
    if sender_qq:
        up.update(bridge.click_event("suggest_command", f".[CQ:at,qq={sender_qq}] ", modern))
    parts.append(up)
    for seg in _seg_list(message):
        c = _seg_comp(seg, modern, img_map, base_url)
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

    # 目标:所有绑定了该 QQ 群的互联组内的 MC 实例 + 面板基址
    db = SessionLocal()
    try:
        from .deps import get_settings_row

        base_url = (get_settings_row(db).base_url or "").rstrip("/")
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
    if not base_url:
        base_url = f"http://localhost:{API_PORT}"

    # ## 前缀:QQ 群指令(排行榜出图,照搬 asPanel);命中则回图/回文,不再转发到 MC
    _cmd_plain = _plain(message).strip()
    if _cmd_plain.startswith("##"):
        server_ids = [sid for sid, _v in targets]
        if await _handle_rank_command(qq_group, server_ids, _cmd_plain):
            return

    # 先把图片下载到本地缓存(原始 url -> /api/chat/img/<name>),feed 与游戏内共用
    img_map: dict[str, str] = {}
    for seg in _seg_list(message):
        if seg.get("type") == "image":
            u = str((seg.get("data") or {}).get("url") or (seg.get("data") or {}).get("file") or "")
            if u and u not in img_map:
                img_map[u] = await _cache_image(u)

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

    # 推到聊天室(结构化段:文本/图片/@/表情/回复 + 头像);图片下载到本地缓存
    from . import chat

    segments = _web_segments(message, reply_user, reply_plain, img_map)
    feed = {
        "source": "qq",
        "sender": user,
        "sender_id": sender_qq,
        "avatar": f"https://q1.qlogo.cn/g?b=qq&nk={sender_qq}&s=100" if sender_qq else "",
        "text": _plain(message),
        "segments": segments,
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
        cmd = "tellraw @a " + json.dumps(_main_line(user, sender_qq, message, message_id, modern, img_map, base_url), ensure_ascii=False)
        loop.create_task(bridge._safe_send(sid, cmd))
        # @ 在线真人 → 提示音
        plain_low = _plain(message).lower()
        for p in bridge.online_players(sid):
            if f"@{p}".lower() in plain_low:
                loop.create_task(bridge._safe_send(sid, f"execute at {p} run playsound minecraft:entity.experience_orb.pickup player {p}"))


# ---------- ## 群指令:排行榜出图(照搬 asPanel) ----------
_rank_limit: dict[int, int] = {}  # qq_group -> 榜单人数上限(内存级,默认 15)


def _rank_help() -> str:
    from .qqimg import boards
    return (
        "##rank 指令帮助:\n"
        "- ##rank : 默认榜单(挖掘榜)\n"
        "- ##rank list : 查看有哪些榜单\n"
        "- ##rank <榜单名> : 例如 ##rank 在线榜(可不带“榜”字)\n"
        "- ##rank <metric1> [metric2] ... : 自定义指标总量榜\n"
        "- ##rank limit <数量> : 设置榜单人数上限(1~100,默认 15)\n"
        "内置榜单:" + "，".join(boards.list_board_names())
    )


def _build_rank_sync(server_ids: list[int], args: list[str], limit: int) -> tuple[bool, str]:
    """阻塞:开 DB、查库、PIL 出图、拉头像。放线程池里跑,别堵事件循环。"""
    from .qqimg.rank_builder import build_rank_png

    db = SessionLocal()
    try:
        return build_rank_png(db, server_ids, args, limit)
    finally:
        db.close()


def _build_stats_sync(server_ids: list[int], name: str, online: set[str], rng: str | None) -> tuple[bool, str]:
    """阻塞:个人统计卡(DB + matplotlib + PIL + 拉头像),放线程池里跑。"""
    from .qqimg.stats_builder import build_stats_png

    db = SessionLocal()
    try:
        return build_stats_png(db, server_ids, name, online, rng)
    finally:
        db.close()


async def _handle_rank_command(qq_group: int, server_ids: list[int], text: str) -> bool:
    """处理 ## 前缀指令。命中并已回复返回 True(调用方随后 return,不转发到 MC)。

    - ##rank ...        排行榜出图
    - ## <玩家名> [范围]  个人统计卡出图(范围:1d/1w/1m/1y/all,默认 1m)
    """
    from .qqimg import boards

    body = text[2:].strip()
    tokens = body.split()
    if not tokens:
        client.send_group(qq_group, "用法:\n##rank <榜单>  查排行榜(##rank help)\n## <玩家名> [1d/1w/1m/1y/all]  查个人统计卡")
        return True

    if tokens[0].lower() != "rank":
        # 个人统计卡:## <玩家名> [范围]
        name = tokens[0]
        rng = tokens[1].lower() if len(tokens) > 1 else None
        online: set[str] = set()
        try:
            from . import bridge
            for sid in server_ids:
                online |= set(bridge.online_players(sid))
        except Exception:  # noqa: BLE001
            pass
        loop = asyncio.get_running_loop()
        try:
            ok, payload = await loop.run_in_executor(None, _build_stats_sync, server_ids, name, online, rng)
        except Exception as e:  # noqa: BLE001
            client.send_group(qq_group, f"出图失败:{e}")
            return True
        client.send_group(qq_group, f"[CQ:image,file=base64://{payload}]" if ok else payload)
        return True

    args = tokens[1:]
    low0 = args[0].lower() if args else ""
    if low0 in ("help", "h", "?"):
        client.send_group(qq_group, _rank_help())
        return True
    if low0 == "list":
        client.send_group(qq_group, "可用榜单:" + "，".join(boards.list_board_names()) + "\n也支持自定义指标:##rank <metric1> [metric2] ...")
        return True
    if low0 == "limit":
        if len(args) < 2:
            client.send_group(qq_group, f"当前 limit={_rank_limit.get(qq_group, 15)}(用法:##rank limit <数量>)")
            return True
        try:
            n = int(args[1])
        except Exception:  # noqa: BLE001
            client.send_group(qq_group, "limit 必须是整数")
            return True
        if n < 1 or n > 100:
            client.send_group(qq_group, "limit 范围:1~100")
            return True
        _rank_limit[qq_group] = n
        client.send_group(qq_group, f"已设置 limit={n}")
        return True

    limit = _rank_limit.get(qq_group, 15)
    loop = asyncio.get_running_loop()
    try:
        ok, payload = await loop.run_in_executor(None, _build_rank_sync, server_ids, args, limit)
    except Exception as e:  # noqa: BLE001
        client.send_group(qq_group, f"出榜失败:{e}")
        return True
    if ok:
        client.send_group(qq_group, f"[CQ:image,file=base64://{payload}]")
    else:
        client.send_group(qq_group, payload)
    return True
