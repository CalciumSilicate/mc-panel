"""插件配置:一批推荐 MCDR 插件 + 默认配置 + 表单化可编辑字段。

每个预设:catalogue 安装 id、默认配置文件、实例内目标路径、可视化编辑字段。
字段类型:bool / int / string / string_array / role_level(MCDR 0-4) / crontab / date / json。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import BACKEND_ROOT

_DEFAULT_DIR = BACKEND_ROOT / "default_config"


@dataclass
class Preset:
    key: str
    name: str
    description: str
    plugin_id: str  # MCDR catalogue id
    default_file: str  # default_config 下文件名
    target: str  # 相对实例根目录
    fields: list[dict] = field(default_factory=list)


PRESETS: dict[str, Preset] = {
    "prime_backup": Preset(
        key="prime_backup", name="Prime Backup", description="高效增量备份(去重压缩),支持定时与清理",
        plugin_id="prime_backup", default_file="prime_backup.json", target="config/prime_backup/config.json",
        fields=[
            {"path": "enabled", "type": "bool", "label": "启用插件"},
            {"path": "command.permission.back", "type": "role_level", "label": "回档权限"},
            {"path": "command.permission.confirm", "type": "role_level", "label": "确认权限"},
            {"path": "scheduled_backup.enabled", "type": "bool", "label": "定时备份"},
            {"path": "scheduled_backup.interval", "type": "string", "label": "定时间隔(如 12h)"},
            {"path": "scheduled_backup.crontab", "type": "crontab", "label": "Crontab(留空用间隔)"},
            {"path": "scheduled_backup.require_online_players", "type": "bool", "label": "需有在线玩家才备份"},
            {"path": "prune.enabled", "type": "bool", "label": "自动清理旧备份"},
        ],
    ),
    "quick_backup_multi": Preset(
        key="quick_backup_multi", name="Quick Backup Multi", description="多槽位快速备份/回档",
        plugin_id="quick_backup_multi", default_file="QuickBackupM.json", target="config/QuickBackupM.json",
        fields=[
            {"path": "minimum_permission_level.back", "type": "role_level", "label": "回档权限"},
            {"path": "minimum_permission_level.confirm", "type": "role_level", "label": "确认权限"},
        ],
    ),
    "crash_restart": Preset(
        key="crash_restart", name="Crash Restart", description="服务器崩溃后自动重启",
        plugin_id="crash_restart", default_file="CrashRestart.json", target="config/CrashRestart.json",
        fields=[
            {"path": "MAX_COUNT", "type": "int", "label": "最大重启次数", "min": 0},
            {"path": "COUNTING_TIME", "type": "int", "label": "计时窗口(秒)", "min": 0},
        ],
    ),
    "auto_plugin_reloader": Preset(
        key="auto_plugin_reloader", name="Auto Plugin Reloader", description="插件文件改动后自动重载",
        plugin_id="auto_plugin_reloader", default_file="auto_plugin_reloader.json", target="config/auto_plugin_reloader/config.json",
        fields=[
            {"path": "enabled", "type": "bool", "label": "启用插件"},
            {"path": "detection_interval_sec", "type": "int", "label": "检测间隔(秒)", "min": 1},
        ],
    ),
    "where_is": Preset(
        key="where_is", name="Where Is", description="查询玩家坐标 / 广播自身坐标",
        plugin_id="where_is", default_file="where_is.json", target="config/where_is/config.json",
        fields=[
            {"path": "command_prefix.where_is", "type": "string_array", "label": "where_is 指令前缀"},
            {"path": "command_prefix.here", "type": "string_array", "label": "here 指令前缀"},
            {"path": "permission_requirements.where_is", "type": "role_level", "label": "where_is 权限"},
            {"path": "permission_requirements.here", "type": "role_level", "label": "here 权限"},
            {"path": "click_to_teleport", "type": "bool", "label": "点击坐标可传送"},
        ],
    ),
    "join_motd": Preset(
        key="join_motd", name="joinMOTD", description="玩家进服欢迎信息 / 服务器列表",
        plugin_id="join_motd", default_file="joinMOTD.json", target="config/joinMOTD.json",
        fields=[
            {"path": "serverName", "type": "string", "label": "本服名称"},
            {"path": "mainServerName", "type": "string", "label": "主服务器名"},
            {"path": "serverList", "type": "json", "label": "服务器列表(JSON)"},
            {"path": "start_day", "type": "date", "label": "起始日期(YYYY-MM-DD)"},
        ],
    ),
    "bili_live_helper": Preset(
        key="bili_live_helper", name="Bili Live Helper", description="B 站开播提醒到游戏内",
        plugin_id="bili_live_helper", default_file="bili_live_helper.json", target="config/bili_live_helper/config.json",
        fields=[
            {"path": "enable", "type": "bool", "label": "启用插件"},
            {"path": "account.uid", "type": "int", "label": "UID"},
            {"path": "account.sessdata", "type": "string", "label": "SESSDATA"},
            {"path": "account.bili_jct", "type": "string", "label": "bili_jct"},
            {"path": "account.buvid3", "type": "string", "label": "buvid3"},
            {"path": "account.ac_time_value", "type": "string", "label": "ac_time_value"},
        ],
    ),
}


def deep_get(d: dict, path: str) -> Any:
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def deep_set(d: dict, path: str, value: Any) -> None:
    cur = d
    parts = path.split(".")
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def read_default(preset: Preset) -> dict:
    p = _DEFAULT_DIR / preset.default_file
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def read_merged(instance_dir: Path, preset: Preset) -> dict:
    """默认 ∪ 当前(当前覆盖)。"""
    data = read_default(preset)
    target = instance_dir / preset.target
    if target.exists():
        try:
            cur = json.loads(target.read_text(encoding="utf-8"))
            if isinstance(cur, dict):
                data = _merge(data, cur)
        except Exception:  # noqa: BLE001
            pass
    return data


def _merge(a: dict, b: dict) -> dict:
    out = json.loads(json.dumps(a))

    def rec(tgt: dict, src: dict) -> None:
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(tgt.get(k), dict):
                rec(tgt[k], v)
            else:
                tgt[k] = v

    rec(out, b)
    return out


def field_values(instance_dir: Path, preset: Preset) -> dict:
    merged = read_merged(instance_dir, preset)
    return {f["path"]: deep_get(merged, f["path"]) for f in preset.fields}


def write_values(instance_dir: Path, preset: Preset, values: dict) -> None:
    """把当前配置(无则用默认)读出,应用编辑字段后写回。"""
    target = instance_dir / preset.target
    if target.exists():
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = read_default(preset)
        except Exception:  # noqa: BLE001
            data = read_default(preset)
    else:
        data = read_default(preset)
    allowed = {f["path"] for f in preset.fields}
    for path, value in values.items():
        if path in allowed:
            deep_set(data, path, value)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8")


def ensure_default(instance_dir: Path, preset: Preset) -> None:
    target = instance_dir / preset.target
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(read_default(preset), ensure_ascii=False, indent=4), encoding="utf-8")
