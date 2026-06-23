"""模组配置:ViaVersion / Velocity Proxy 的安装 + 默认配置 + 表单编辑。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import mod_presets as mp
from ..database import get_db
from ..deps import ensure_not_protected, require_helper
from ..mcdr import manager
from ..models import Server

router = APIRouter(prefix="/modconfigs", tags=["modconfigs"])


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


def _preset(key: str) -> mp.ModPreset:
    p = mp.PRESETS.get(key)
    if p is None:
        raise HTTPException(status_code=404, detail="未知模组配置")
    return p


@router.get("")
def list_presets() -> list[dict]:
    return [
        {"key": p.key, "name": p.name, "description": p.description, "server_types": p.server_types, "fields": p.fields}
        for p in mp.PRESETS.values()
    ]


@router.get("/status/{server_id}")
def status(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    server = _server(db, server_id)
    inst = manager.instance_dir(server)
    return {key: mp.is_installed(inst, p) for key, p in mp.PRESETS.items()}


@router.get("/{key}/{server_id}")
def get_config(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    inst = manager.instance_dir(server)
    return {
        "installed": mp.is_installed(inst, preset),
        "applicable": server.server_type in preset.server_types,
        "values": mp.field_values(inst, preset),
    }


class ValuesBody(BaseModel):
    values: dict[str, Any]


@router.patch("/{key}/{server_id}")
def update_config(key: str, server_id: int, body: ValuesBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    ensure_not_protected(server)
    mp.write_values(manager.instance_dir(server), preset, body.values)
    return {"ok": True}


@router.post("/{key}/{server_id}/install")
async def install_preset(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    ensure_not_protected(server)
    if server.server_type not in preset.server_types:
        raise HTTPException(status_code=400, detail=f"{preset.name} 仅适用于 {'/'.join(preset.server_types)} 实例")
    await mp.install(server, preset)
    return {"ok": True}
