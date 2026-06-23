"""聊天室:互联组实时消息流(WS)+ 网页发送(注入 MC + QQ)。"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bridge, chat
from .. import onebot
from ..database import SessionLocal, get_db
from ..deps import require_operate
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
    chat.publish(group_id, {"source": "web", "user": user.username, "text": text})
    return {"ok": True}


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
