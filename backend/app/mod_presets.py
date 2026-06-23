"""模组配置:推荐模组/代理插件(ViaVersion、Velocity Proxy)的安装 + 默认配置 + 表单编辑。

与「插件配置」类似,但目标是模组/velocity 插件:按 server_type 装到对应目录,配置为 yaml/toml。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import jar_cache
from .mcdr import manager
from .mod_manager import manager as mods
from .plugin_presets import deep_get, deep_set


@dataclass
class ModPreset:
    key: str
    name: str
    description: str
    slug: str  # Modrinth slug
    loader: str  # modrinth loader: fabric / velocity ...
    server_types: list[str]  # 适用的实例类型
    install_dir: str  # 安装目录(相对实例根)
    marker: str  # 判断是否已装:文件名包含该子串
    fmt: str  # yaml / toml
    target: str  # 配置文件(相对实例根)
    default: dict
    fields: list[dict] = field(default_factory=list)


PRESETS: dict[str, ModPreset] = {
    "viaversion": ModPreset(
        key="viaversion", name="ViaVersion", description="让不同版本的客户端连入(装在 Velocity 主服)",
        slug="viaversion", loader="velocity", server_types=["velocity"], install_dir="server/plugins",
        marker="viaversion", fmt="yaml", target="server/plugins/viaversion/config.yml",
        default={"packet-limiter": {"max-per-second": 800, "sustained-max-per-second": 200}},
        fields=[
            {"path": "packet-limiter.max-per-second", "type": "int", "label": "每秒最大包数", "min": -1},
            {"path": "packet-limiter.sustained-max-per-second", "type": "int", "label": "持续期最大包数", "min": -1},
        ],
    ),
    "velocity_proxy": ModPreset(
        key="velocity_proxy", name="Velocity Proxy", description="Fabric 子服接入 Velocity modern 转发(FabricProxy-Lite)",
        slug="fabricproxy-lite", loader="fabric", server_types=["fabric"], install_dir="server/mods",
        marker="fabricproxy", fmt="toml", target="server/config/FabricProxy-Lite.toml",
        default={
            "hackOnlineMode": True, "hackMessageChain": True, "hackEarlySend": False,
            "disconnectMessage": "This server requires you to connect with Velocity.", "secret": "",
        },
        fields=[
            {"path": "hackOnlineMode", "type": "bool", "label": "Hack Online Mode"},
            {"path": "hackMessageChain", "type": "bool", "label": "Hack Message Chain"},
            {"path": "hackEarlySend", "type": "bool", "label": "Hack Early Send"},
            {"path": "disconnectMessage", "type": "string", "label": "断开提示"},
            {"path": "secret", "type": "string", "label": "转发密钥(与 velocity 一致)"},
        ],
    ),
}


# ---------- toml(扁平)----------
def _read_toml_flat(text: str) -> dict:
    d: dict[str, Any] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("[") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if v.lower() in ("true", "false"):
            d[k] = v.lower() == "true"
        elif v.startswith('"'):
            d[k] = v.strip('"')
        else:
            try:
                d[k] = int(v)
            except ValueError:
                d[k] = v.strip('"')
    return d


def _write_toml_flat(d: dict) -> str:
    out = []
    for k, v in d.items():
        if isinstance(v, bool):
            out.append(f"{k} = {'true' if v else 'false'}")
        elif isinstance(v, (int, float)):
            out.append(f"{k} = {v}")
        else:
            out.append(f'{k} = "{v}"')
    return "\n".join(out) + "\n"


def _merge(a: dict, b: dict) -> dict:
    import json

    out = json.loads(json.dumps(a))

    def rec(t, s):
        for k, v in s.items():
            if isinstance(v, dict) and isinstance(t.get(k), dict):
                rec(t[k], v)
            else:
                t[k] = v

    rec(out, b)
    return out


def _read_current(inst: Path, preset: ModPreset) -> dict:
    target = inst / preset.target
    if not target.exists():
        return {}
    try:
        text = target.read_text(encoding="utf-8")
        if preset.fmt == "yaml":
            return yaml.safe_load(text) or {}
        return _read_toml_flat(text)
    except Exception:  # noqa: BLE001
        return {}


def read_merged(inst: Path, preset: ModPreset) -> dict:
    return _merge(preset.default, _read_current(inst, preset))


def field_values(inst: Path, preset: ModPreset) -> dict:
    merged = read_merged(inst, preset)
    return {f["path"]: deep_get(merged, f["path"]) for f in preset.fields}


def _write(inst: Path, preset: ModPreset, data: dict) -> None:
    target = inst / preset.target
    target.parent.mkdir(parents=True, exist_ok=True)
    if preset.fmt == "yaml":
        target.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    else:
        target.write_text(_write_toml_flat(data), encoding="utf-8")


def write_values(inst: Path, preset: ModPreset, values: dict) -> None:
    data = _read_current(inst, preset) or dict(preset.default)
    allowed = {f["path"] for f in preset.fields}
    for path, value in values.items():
        if path in allowed:
            deep_set(data, path, value)
    _write(inst, preset, data)


def ensure_default(inst: Path, preset: ModPreset) -> None:
    if not (inst / preset.target).exists():
        _write(inst, preset, dict(preset.default))


def is_installed(inst: Path, preset: ModPreset) -> bool:
    d = inst / preset.install_dir
    if not d.exists():
        return False
    return any(preset.marker in p.name.lower() for p in d.iterdir() if p.is_file())


async def install(server, preset: ModPreset) -> str:
    inst = manager.instance_dir(server)
    versions = await mods.list_versions(preset.slug, server.mc_version, preset.loader)
    if not versions:
        raise RuntimeError(f"未找到适配 {server.mc_version} 的 {preset.slug}")
    version = await mods._fetch_version(versions[0]["id"])
    files = version.get("files") or []
    chosen = next((f for f in files if f.get("primary")), files[0] if files else None)
    if not chosen:
        raise RuntimeError("该版本没有可下载文件")
    dest_dir = inst / preset.install_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(chosen.get("filename") or "mod.jar").name
    await jar_cache.cached_download(
        chosen["url"], dest, algo="sha1",
        hexhash=(chosen.get("hashes") or {}).get("sha1", ""), size=chosen.get("size", 0) or 0, progress=None,
    )
    ensure_default(inst, preset)
    return dest.name
