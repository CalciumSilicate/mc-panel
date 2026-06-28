"""系统设置:MCDR 运行参数 + Java 安装池 + 下载代理 + 注册开关 + QQ 互通(admin+)。"""
from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi import HTTPException
from sqlalchemy.orm import Session
import websockets

from .. import onebot
from ..database import get_db
from ..deps import get_settings_row, require_admin
from ..java import detect_installs, get_java_paths, set_java_paths
from ..schemas import JavaInstall, OneBotPrivateTestRequest, SettingsResponse, SettingsUpdate

router = APIRouter(prefix="/settings", tags=["settings"])


def _to_response(row) -> SettingsResponse:
    installs = [JavaInstall(**i) for i in detect_installs(get_java_paths(row))]
    return SettingsResponse(
        python_executable=row.python_executable,
        java_command=row.java_command,
        default_min_memory=row.default_min_memory,
        default_max_memory=row.default_max_memory,
        token_expire_minutes=row.token_expire_minutes,
        download_proxy=row.download_proxy,
        allow_register=row.allow_register,
        port_min=row.port_min,
        port_max=row.port_max,
        base_url=row.base_url,
        onebot_enabled=row.onebot_enabled,
        onebot_ws_url=row.onebot_ws_url,
        onebot_token=row.onebot_token,
        onebot_connected=onebot.client.connected,
        java_installs=installs,
    )


@router.get("", response_model=SettingsResponse)
def get_settings(_: object = Depends(require_admin), db: Session = Depends(get_db)) -> SettingsResponse:
    return _to_response(get_settings_row(db))


@router.patch("", response_model=SettingsResponse)
def update_settings(
    payload: SettingsUpdate,
    _: object = Depends(require_admin),
    db: Session = Depends(get_db),
) -> SettingsResponse:
    row = get_settings_row(db)
    if payload.python_executable is not None:
        row.python_executable = payload.python_executable
    if payload.java_command is not None:
        row.java_command = payload.java_command
    if payload.default_min_memory is not None:
        row.default_min_memory = payload.default_min_memory
    if payload.default_max_memory is not None:
        row.default_max_memory = payload.default_max_memory
    if payload.token_expire_minutes is not None:
        row.token_expire_minutes = payload.token_expire_minutes
    if payload.download_proxy is not None:
        row.download_proxy = payload.download_proxy.strip()
    if payload.allow_register is not None:
        row.allow_register = payload.allow_register
    if payload.port_min is not None:
        row.port_min = payload.port_min
    if payload.port_max is not None:
        row.port_max = payload.port_max
    if payload.base_url is not None:
        row.base_url = payload.base_url.strip().rstrip("/")
    if payload.onebot_enabled is not None:
        row.onebot_enabled = payload.onebot_enabled
    if payload.onebot_ws_url is not None:
        row.onebot_ws_url = payload.onebot_ws_url.strip()
    if payload.onebot_token is not None:
        row.onebot_token = payload.onebot_token.strip()
    if payload.java_paths is not None:
        set_java_paths(row, payload.java_paths)
    db.commit()
    db.refresh(row)
    # 应用 QQ 互通配置变更(重连)
    onebot.client.reconfigure(row.onebot_enabled, row.onebot_ws_url, row.onebot_token)
    return _to_response(row)


@router.post("/onebot/test-private")
async def test_onebot_private(
    payload: OneBotPrivateTestRequest,
    _: object = Depends(require_admin),
) -> dict:
    ws_url = payload.ws_url.strip()
    if not ws_url:
        raise HTTPException(status_code=400, detail="请先填写 OneBot ws 地址")

    qq = payload.qq.strip()
    if not qq:
        raise HTTPException(status_code=400, detail="请填写 QQ 号")
    if not qq.isdigit():
        raise HTTPException(status_code=400, detail="QQ 号只能包含数字")
    user_id = int(qq)

    uri = ws_url
    token = payload.token.strip()
    if token:
        uri += ("&" if "?" in uri else "?") + "access_token=" + quote(token)

    echo = "mcp_onebot_private_test"
    action = {
        "action": "send_private_msg",
        "params": {"user_id": user_id, "message": payload.message},
        "echo": echo,
    }
    try:
        async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
            await ws.send(json.dumps(action, ensure_ascii=False))
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=8.0)
                data = json.loads(raw)
                if str(data.get("echo")) != echo:
                    continue
                status = str(data.get("status") or "")
                retcode = data.get("retcode")
                if status.lower() == "ok" or retcode == 0:
                    return {"ok": True, "status": status, "retcode": retcode}
                detail = data.get("wording") or data.get("message") or data
                raise HTTPException(status_code=502, detail=f"OneBot 发送失败: {detail}")
    except HTTPException:
        raise
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="OneBot 测试超时，未收到发送结果") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="OneBot 连接或发送失败，请检查 ws 地址和 Access Token") from exc
