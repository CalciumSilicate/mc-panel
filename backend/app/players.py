"""玩家管理:聚合各实例的 OP(ops.json)、封禁(banned-players.json)、MCDR 权限(permission.yml)。"""
from __future__ import annotations

import json

import yaml

from .mcdr import manager
from .models import Server

_PERM_LEVELS = ["owner", "admin", "helper", "user", "guest"]


def _load_json(path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def read_players(server: Server) -> list[dict]:
    inst = manager.instance_dir(server)
    sdir = inst / "server"

    # 名字(小写) -> 记录
    rows: dict[str, dict] = {}

    def row(name: str) -> dict:
        key = name.lower()
        if key not in rows:
            rows[key] = {"name": name, "uuid": "", "op_level": None, "banned": False, "ban_reason": "", "mcdr_perm": ""}
        return rows[key]

    # usercache:已知玩家 + uuid
    uc = _load_json(sdir / "usercache.json")
    if isinstance(uc, list):
        for e in uc:
            n = str(e.get("name", ""))
            if n:
                row(n)["uuid"] = str(e.get("uuid", ""))

    # ops.json: [{uuid,name,level}]
    ops = _load_json(sdir / "ops.json")
    if isinstance(ops, list):
        for e in ops:
            n = str(e.get("name", ""))
            if n:
                r = row(n)
                r["op_level"] = e.get("level")
                if e.get("uuid"):
                    r["uuid"] = str(e["uuid"])

    # banned-players.json: [{uuid,name,reason}]
    bans = _load_json(sdir / "banned-players.json")
    if isinstance(bans, list):
        for e in bans:
            n = str(e.get("name", ""))
            if n:
                r = row(n)
                r["banned"] = True
                r["ban_reason"] = str(e.get("reason", ""))

    # permission.yml: level -> [names]
    perm_path = inst / "permission.yml"
    if perm_path.exists():
        try:
            perm = yaml.safe_load(perm_path.read_text(encoding="utf-8")) or {}
            for level in _PERM_LEVELS:
                for n in (perm.get(level) or []):
                    if n:
                        row(str(n))["mcdr_perm"] = level
        except Exception:  # noqa: BLE001
            pass

    return sorted(rows.values(), key=lambda r: r["name"].lower())
