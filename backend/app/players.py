"""玩家管理:聚合各实例的 OP(ops.json)、封禁(banned-players.json)、MCDR 权限(permission.yml)。"""
from __future__ import annotations

import json
import asyncio
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from fastapi import HTTPException

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
            if not isinstance(e, dict):
                continue
            n = str(e.get("name", ""))
            if n:
                row(n)["uuid"] = str(e.get("uuid", ""))

    # ops.json: [{uuid,name,level}]
    ops = _load_json(sdir / "ops.json")
    if isinstance(ops, list):
        for e in ops:
            if not isinstance(e, dict):
                continue
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
            if not isinstance(e, dict):
                continue
            n = str(e.get("name", ""))
            if n:
                r = row(n)
                r["banned"] = True
                r["ban_reason"] = str(e.get("reason", ""))
                if e.get("uuid"):
                    r["uuid"] = str(e['uuid'])

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

    from . import bridge
    online = {n.lower() for n in bridge.online_players(server.id)}
    for name in bridge.online_players(server.id):
        row(name)
    for entry in rows.values():
        entry['online'] = entry['name'].lower() in online
    return sorted(rows.values(), key=lambda r: r["name"].lower())


_locks: dict[int, asyncio.Lock] = {}


def _write(path: Path, value, *, yaml_file=False):
    if path.is_symlink() or path.parent.is_symlink():
        raise HTTPException(400, '不允许修改链接文件')
    text = yaml.safe_dump(value, allow_unicode=True, sort_keys=False) if yaml_file else json.dumps(value, ensure_ascii=False, indent=2)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.players-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


async def update_player(server: Server, name: str, patch: dict, actor: str) -> dict:
    if not re.fullmatch(r'[A-Za-z0-9_]{3,16}', name):
        raise HTTPException(400, '玩家名不合法')
    if sum(k in patch for k in ('op', 'banned', 'mcdr_perm')) != 1:
        raise HTTPException(400, '请每次修改一项权限')
    async with _locks.setdefault(server.id, asyncio.Lock()):
        inst = manager.instance_dir(server)
        # Reuse file-browser checks for links, junctions, and special files.
        from .server_files import _check
        for path in [inst, inst / 'server', inst / 'permission.yml', *(inst / 'server' / n for n in ('ops.json', 'banned-players.json', 'usercache.json'))]:
            try:
                _check(path.lstat())
            except FileNotFoundError:
                pass
        current = next((p for p in read_players(server) if p['name'].lower() == name.lower()), None)
        if current is None:
            raise HTTPException(404, '玩家不存在')
        name = current['name']
        reason = patch.get('ban_reason', '').strip() or '由管理员封禁'
        if manager.is_running(server.id):
            try:
                if 'op' in patch:
                    command = f"{'op' if patch['op'] else 'deop'} {name}"
                elif 'banned' in patch:
                    if patch['banned'] and current['banned']:
                        await manager.send_raw(server.id, f'pardon {name}')
                    command = f'ban {name} {reason}' if patch['banned'] else f'pardon {name}'
                else:
                    command = f"!!MCDR permission {'set' if patch['mcdr_perm'] else 'remove'} {name}"
                    if patch['mcdr_perm']:
                        command += f" {patch['mcdr_perm']}"
                await manager.send_raw(server.id, command)
            except RuntimeError as exc:
                raise HTTPException(409, str(exc)) from exc
            for _ in range(40):
                await asyncio.sleep(.1)
                updated = next((p for p in read_players(server) if p['name'].lower() == name.lower()), None)
                if updated is None and (patch.get('op') is False or patch.get('banned') is False or patch.get('mcdr_perm') == ''):
                    updated = {**current, 'op_level': None, 'banned': False, 'ban_reason': '', 'mcdr_perm': ''}
                if updated and (
                    ('op' in patch and (updated['op_level'] is not None) == patch['op']) or
                    ('mcdr_perm' in patch and updated['mcdr_perm'] == patch['mcdr_perm']) or
                    ('banned' in patch and updated['banned'] == patch['banned'] and (not patch['banned'] or updated['ban_reason'] == reason))
                ):
                    return updated
            raise HTTPException(409, '未确认修改结果，请刷新或查看控制台')
        if 'mcdr_perm' in patch:
            path = inst / 'permission.yml'
            try:
                value = yaml.safe_load(path.read_text(encoding='utf-8')) if path.exists() else {'default_level': 'user'}
                if not isinstance(value, dict):
                    raise ValueError()
                for level in _PERM_LEVELS:
                    names = value.get(level) or []
                    if not isinstance(names, list):
                        raise ValueError()
                    value[level] = [n for n in names if str(n).lower() != name.lower()]
                if patch['mcdr_perm']:
                    value[patch['mcdr_perm']].append(name)
            except (ValueError, yaml.YAMLError) as exc:
                raise HTTPException(409, '权限文件格式错误') from exc
            _write(path, value, yaml_file=True)
        else:
            path = inst / 'server' / ('ops.json' if 'op' in patch else 'banned-players.json')
            value = _load_json(path) if path.exists() else []
            if not isinstance(value, list) or any(not isinstance(e, dict) for e in value):
                raise HTTPException(409, '玩家配置文件格式错误')
            original = next((e for e in value if str(e.get('name', '')).lower() == name.lower()), {})
            value = [e for e in value if str(e.get('name', '')).lower() != name.lower()]
            if patch.get('op') or patch.get('banned'):
                if not current['uuid']:
                    raise HTTPException(409, '缺少玩家 UUID，请先让玩家加入服务器')
                entry = {**original, 'name': name, 'uuid': current['uuid']}
                if 'op' in patch:
                    entry.update(level=original.get('level', 4), bypassesPlayerLimit=original.get('bypassesPlayerLimit', False))
                else:
                    entry.update(reason=reason, source=actor, created=datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S %z'), expires='forever')
                value.append(entry)
            _write(path, value)
        return next((p for p in read_players(server) if p['name'].lower() == name.lower()), {
            **current, **({'op_level': None} if 'op' in patch else {'banned': False, 'ban_reason': ''} if 'banned' in patch else {'mcdr_perm': ''}),
        })
