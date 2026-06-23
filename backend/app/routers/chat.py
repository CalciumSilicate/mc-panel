"""聊天室:互联组实时消息流(WS)+ 网页发送(注入 MC + QQ)。"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bridge, chat, cqcode
from .. import onebot
from ..database import SessionLocal, get_db
from ..deps import require_auth, require_operate
from ..mcdr import manager
from ..models import Server, ServerGroup, User
from ..security import decode_token

router = APIRouter(prefix="/chat", tags=["chat"])

_MC_TYPES = ("vanilla", "fabric", "forge")


class SendBody(BaseModel):
    text: str


@router.post("/{group_id}/send")
def send_message(
    group_id: int,
    body: SendBody,
    user: User = Depends(require_operate),
    db: Session = Depends(get_db),
) -> dict:
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息为空")
    grp = db.get(ServerGroup, group_id)
    if grp is None:
        raise HTTPException(status_code=404, detail="互联组不存在")

    targets = [
        (s.id, s.mc_version)
        for s in db.scalars(select(Server).where(Server.group_id == group_id)).all()
        if s.server_type in _MC_TYPES
    ]
    try:
        qq_ids = [int(x) for x in json.loads(grp.qq_group_ids or "[]")]
    except Exception:  # noqa: BLE001
        qq_ids = []

    # 注入组内运行中的 MC 实例
    for sid, mc_version in targets:
        if manager.is_running(sid):
            modern = bridge._modern(mc_version)
            comps = [
                "",
                {"text": "[网页] ", "color": "gray"},
                {"text": f"<{user.username}> ", "color": "gray"},
                {"text": text, "color": "gray"},
            ]
            asyncio.create_task(bridge._safe_send(sid, "tellraw @a " + json.dumps(comps, ensure_ascii=False)))
    # 发到绑定的 QQ 群
    if onebot.client.connected:
        for gid in qq_ids:
            onebot.client.send_group(gid, f"<{user.username}> {text}")
    # 推到聊天室
    chat.publish(group_id, {
        "source": "web",
        "sender": user.username,
        "avatar": "",
        "text": text,
        "segments": cqcode.parse(text),
    })
    return {"ok": True}


_ROLE_ORDER = {"owner": 0, "admin": 1, "member": 2}


@router.get("/{group_id}/members")
async def members(
    group_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    """右侧成员栏:组内游戏在线玩家 + 绑定 QQ 群成员(按群主→管理→成员排序)。"""
    grp = db.get(ServerGroup, group_id)
    if grp is None:
        raise HTTPException(status_code=404, detail="互联组不存在")
    players: list[dict] = []
    for s in db.scalars(select(Server).where(Server.group_id == group_id)).all():
        if s.server_type in _MC_TYPES:
            for p in sorted(bridge.online_players(s.id)):
                players.append({"name": p, "server": s.name})
    try:
        qq_ids = [int(x) for x in json.loads(grp.qq_group_ids or "[]")]
    except Exception:  # noqa: BLE001
        qq_ids = []
    seen: set[str] = set()
    qq_members: list[dict] = []
    for gid in qq_ids:
        resp = await onebot.client.call_action("get_group_member_list", {"group_id": gid})
        for m in (resp or {}).get("data") or []:
            uid = str(m.get("user_id") or "")
            if not uid or uid in seen:
                continue
            seen.add(uid)
            qq_members.append({
                "user_id": uid,
                "name": str(m.get("card") or m.get("nickname") or uid),
                "role": str(m.get("role") or "member"),
            })
    qq_members.sort(key=lambda m: (_ROLE_ORDER.get(m["role"], 9), m["name"]))
    return {"players": players, "qq": qq_members}


@router.websocket("/ws/{group_id}")
async def chat_ws(websocket: WebSocket, group_id: int, token: str = Query(default="")):
    payload = decode_token(token)
    if not payload:
        await websocket.close(code=4401)
        return
    db = SessionLocal()
    try:
        try:
            user = db.get(User, int(payload.get("sub") or 0))
        except (TypeError, ValueError):
            user = None
        group = db.get(ServerGroup, group_id)
    finally:
        db.close()
    if user is None:
        await websocket.close(code=4401)
        return
    if group is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    for msg in chat.recent(group_id):
        await websocket.send_json(msg)
    queue = chat.subscribe(group_id)
    try:
        while True:
            await websocket.send_json(await queue.get())
    except Exception:  # noqa: BLE001 - 断开
        pass
    finally:
        chat.unsubscribe(group_id, queue)
