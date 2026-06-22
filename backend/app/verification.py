"""玩家绑定验证:生成验证码 + 从控制台日志捕获绑定指令完成验证。

流程:
  1. 用户填写正版游戏 ID,后端生成验证码并暂存(verify_code + verify_target)。
  2. 用户加入任意服务器,在聊天栏输入 ``!!bind <验证码>``。
  3. 服务器输出 ``<玩家名> !!bind <验证码>``,经 manager._append_line 钩到这里。
  4. 校验码命中、且玩家名与填写 ID 一致 → 标记 verified、绑定 player_id,游戏内回执。
"""
from __future__ import annotations

import asyncio
import re
import secrets

from sqlalchemy import select

from .database import SessionLocal
from .models import User

BIND_KEYWORD = "!!bind"
# 匹配 "<玩家名> !!bind 验证码"(兼容前缀如 [Not Secure])
_BIND_RE = re.compile(r"<([^>]{1,32})>\s*!!bind\s+([A-Za-z0-9]{4,16})")

# 验证码字符集:去掉易混淆的 0/O/1/I/L
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_code(length: int = 6) -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))


def bind_command(code: str) -> str:
    return f"{BIND_KEYWORD} {code}"


def handle_line(server_id: int, line: str) -> None:
    """挂到 manager 的逐行钩子:发现绑定指令则尝试完成验证(同步,DB 操作很轻)。"""
    if BIND_KEYWORD not in line:
        return
    match = _BIND_RE.search(line)
    if not match:
        return
    player, code = match.group(1).strip(), match.group(2).strip().upper()

    db = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.verify_code == code))
        if user is None:
            return  # 未知验证码:静默忽略,避免刷屏
        target = (user.verify_target or "").strip()
        if target and target.lower() != player.lower():
            _reply(server_id, player, f"验证失败:游戏ID应为 {target}")
            return
        user.verified = True
        user.player_id = player
        user.verify_code = ""
        user.verify_target = ""
        db.commit()
        _reply(server_id, player, "绑定成功,账号已验证")
    finally:
        db.close()


def _reply(server_id: int, player: str, message: str) -> None:
    """游戏内 tell 回执(尽力而为,失败忽略)。"""
    from .mcdr import manager

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(manager.send_raw(server_id, f'tell {player} [验证] {message}'))
