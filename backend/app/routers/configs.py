"""插件配置:推荐插件的一键安装 + 默认配置 + 表单化编辑。"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import plugin_presets as presets
from .. import plugin_scan
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


@router.get("/status/{server_id}")
def status(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """一次返回该实例所有预设的安装状态(读缓存)+ 上次扫描时间。"""
    server = _server(db, server_id)
    ids = plugin_scan.get_installed_ids(db, server_id)
    if ids is None:
        ids = plugin_scan.scan_server(db, server)
    return {
        "installed": {key: (p.plugin_id in ids) for key, p in presets.PRESETS.items()},
        "scanned_at": plugin_scan.get_scanned_at(db, server_id),
    }


@router.post("/refresh/{server_id}")
def refresh(server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """立即扫描该实例并刷新缓存。"""
    server = _server(db, server_id)
    ids = plugin_scan.scan_server(db, server)
    return {
        "installed": {key: (p.plugin_id in ids) for key, p in presets.PRESETS.items()},
        "scanned_at": plugin_scan.get_scanned_at(db, server_id),
    }


@router.get("/{key}/{server_id}")
def get_config(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    inst = manager.instance_dir(server)
    # 读缓存(无缓存则触发一次现场扫描并写入)
    ids = plugin_scan.get_installed_ids(db, server_id)
    if ids is None:
        ids = plugin_scan.scan_server(db, server)
    return {
        "installed": preset.plugin_id in ids,
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


async def _install_one(preset: presets.Preset, server: Server, python: str) -> None:
    inst = manager.instance_dir(server)
    await plugins.install_from_catalogue(inst, preset.plugin_id, None, python)
    presets.ensure_default(inst, preset)


@router.post("/{key}/{server_id}/install")
async def install_preset(key: str, server_id: int, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    preset = _preset(key)
    server = _server(db, server_id)
    ensure_not_protected(server)
    if server.server_type not in _MC_TYPES:
        raise HTTPException(status_code=400, detail="该插件仅适用于 MC 服务器实例")
    await _install_one(preset, server, get_settings_row(db).python_executable)
    plugin_scan.mark_installed(db, server.id, preset.plugin_id)
    return {"ok": True}


class TargetsBody(BaseModel):
    targets: list[int]


@router.post("/{key}/{server_id}/copy-to")
def copy_config_to(key: str, server_id: int, body: TargetsBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """把源实例该插件的整份配置复制到目标实例。"""
    preset = _preset(key)
    src = _server(db, server_id)
    src_file = manager.instance_dir(src) / preset.target
    content = src_file.read_text(encoding="utf-8") if src_file.exists() else json.dumps(
        presets.read_default(preset), ensure_ascii=False, indent=4
    )
    results: list[dict] = []
    for tid in body.targets:
        t = db.get(Server, tid)
        if t is None or tid == server_id:
            continue
        if t.protected:
            results.append({"name": t.name if t else str(tid), "status": "error", "detail": "实例受保护"})
            continue
        dest = manager.instance_dir(t) / preset.target
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        results.append({"name": t.name, "status": "ok", "detail": "已复制配置"})
    return {"results": results}


@router.post("/{key}/install-to")
async def install_preset_to(key: str, body: TargetsBody, _: str = Depends(require_helper), db: Session = Depends(get_db)) -> dict:
    """把该插件安装到多个目标实例。"""
    preset = _preset(key)
    python = get_settings_row(db).python_executable
    results: list[dict] = []
    for tid in body.targets:
        t = db.get(Server, tid)
        if t is None:
            continue
        if t.protected:
            results.append({"name": t.name, "status": "error", "detail": "实例受保护"})
            continue
        if t.server_type not in _MC_TYPES:
            results.append({"name": t.name, "status": "unsupported", "detail": "非 MC 实例"})
            continue
        try:
            await _install_one(preset, t, python)
            plugin_scan.mark_installed(db, t.id, preset.plugin_id)
            results.append({"name": t.name, "status": "ok", "detail": "已安装"})
        except Exception as exc:  # noqa: BLE001
            results.append({"name": t.name, "status": "error", "detail": str(exc)})
    return {"results": results}
