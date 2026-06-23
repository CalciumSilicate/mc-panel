"""插件配置:推荐插件的一键安装 + 默认配置 + 表单化编辑。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import plugin_presets as presets
from ..database import get_db
from ..deps import ensure_not_protected, get_settings_row, require_helper
from ..mcdr import manager
from ..models import Server
from ..plugin_manager import manager as plugins

router = APIRouter(prefix="/configs", tags=["configs"])

_MC_TYPES = ("vanilla", "fabric", "forge")


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


def _preset(key: str) -> presets.Preset:
    p = presets.PRESETS.get(key)
    if p is None:
        raise HTTPException(status_code=404, detail="未知插件配置")
    return p


@router.get("")
def list_presets() -> list[dict]:
    return [
        {"key": p.key, "name": p.name, "description": p.description, "plugin_id": p.plugin_id, "fields": p.fields}
        for p in presets.PRESETS.values()
    ]


@router.get("/{key}/{server_id}")
def get_config(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    inst = manager.instance_dir(server)
    installed_ids = {p["id"] for p in plugins.list_plugins(inst) if p.get("id")}
    return {
        "installed": preset.plugin_id in installed_ids,
        "values": presets.field_values(inst, preset),
    }


class ValuesBody(BaseModel):
    values: dict[str, Any]


@router.patch("/{key}/{server_id}")
def update_config(key: str, server_id: int, body: ValuesBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    ensure_not_protected(server)
    presets.write_values(manager.instance_dir(server), preset, body.values)
    return {"ok": True}


@router.post("/{key}/{server_id}/install")
async def install_preset(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    ensure_not_protected(server)
    if server.server_type not in _MC_TYPES:
        raise HTTPException(status_code=400, detail="该插件仅适用于 MC 服务器实例")
    inst = manager.instance_dir(server)
    settings = get_settings_row(db)
    result = await plugins.install_from_catalogue(inst, preset.plugin_id, None, settings.python_executable)
    presets.ensure_default(inst, preset)
    return {"ok": True, "file_name": result.get("file_name", "")}
