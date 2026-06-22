"""超平坦 level.dat 生成器。

MC 各版本 level.dat 中世界生成配置的格式不同:
  - 1.16+(DataVersion>=2504):Data.WorldGenSettings 下的 dimensions/generator(type=minecraft:flat)
  - 1.13–1.15:Data.generatorName=flat + generatorOptions(JSON 字符串)
据服务器版本选择格式并写入对应 DataVersion。返回 gzip 压缩的 level.dat 字节。
"""
from __future__ import annotations

import io
import json
import os
import re
import secrets
import tempfile
from pathlib import Path

import nbtlib
from nbtlib import Byte, Compound, Int, List, Long, String

# 已知正式版 → DataVersion(最简映射,未知版本回退到最大已知值)
DATA_VERSIONS: dict[str, int] = {
    "1.13": 1519, "1.13.1": 1628, "1.13.2": 1631,
    "1.14": 1952, "1.14.1": 1957, "1.14.2": 1963, "1.14.3": 1968, "1.14.4": 1976,
    "1.15": 2225, "1.15.1": 2227, "1.15.2": 2230,
    "1.16": 2566, "1.16.1": 2567, "1.16.2": 2578, "1.16.3": 2580, "1.16.4": 2584, "1.16.5": 2586,
    "1.17": 2724, "1.17.1": 2730,
    "1.18": 2860, "1.18.1": 2865, "1.18.2": 2975,
    "1.19": 3105, "1.19.1": 3117, "1.19.2": 3120, "1.19.3": 3218, "1.19.4": 3337,
    "1.20": 3463, "1.20.1": 3465, "1.20.2": 3578, "1.20.3": 3698, "1.20.4": 3700,
    "1.20.5": 3837, "1.20.6": 3839,
    "1.21": 3953, "1.21.1": 3955, "1.21.2": 4080, "1.21.3": 4082, "1.21.4": 4189,
    "1.21.5": 4325, "1.21.6": 4435, "1.21.7": 4438, "1.21.8": 4440,
}
_NEW_FORMAT_MIN = 2504  # 1.16 起用 WorldGenSettings


def data_version_for(mc_version: str) -> int:
    v = (mc_version or "").strip()
    if v in DATA_VERSIONS:
        return DATA_VERSIONS[v]
    # 同一 1.X 主线取该主线最大已知值
    m = re.match(r"^1\.(\d+)", v)
    if m:
        prefix = f"1.{m.group(1)}"
        same = [val for key, val in DATA_VERSIONS.items() if key == prefix or key.startswith(prefix + ".")]
        if same:
            return max(same)
    # 未知(快照/更新版本):回退到最大已知值(对全新世界服务端会自行升级)
    return max(DATA_VERSIONS.values())


def _layers_nbt(layers: list[dict]) -> "List":
    return List[Compound]([
        Compound({"block": String(ly["block"]), "height": Int(int(ly["height"]))})
        for ly in layers
    ])


def _flat_settings(layers: list[dict], biome: str, structures: list[str]) -> Compound:
    settings = Compound({
        "biome": String(biome),
        "layers": _layers_nbt(layers),
        "features": Byte(0),
        "lakes": Byte(0),
    })
    if structures:
        settings["structure_overrides"] = List[String]([String(s) for s in structures])
    return settings


def _world_gen_settings(layers, biome, structures, seed: int) -> Compound:
    overworld = Compound({
        "type": String("minecraft:overworld"),
        "generator": Compound({
            "type": String("minecraft:flat"),
            "settings": _flat_settings(layers, biome, structures),
        }),
    })
    nether = Compound({
        "type": String("minecraft:the_nether"),
        "generator": Compound({
            "type": String("minecraft:noise"),
            "settings": String("minecraft:nether"),
            "biome_source": Compound({
                "type": String("minecraft:multi_noise"),
                "preset": String("minecraft:nether"),
            }),
        }),
    })
    the_end = Compound({
        "type": String("minecraft:the_end"),
        "generator": Compound({
            "type": String("minecraft:noise"),
            "settings": String("minecraft:end"),
            "biome_source": Compound({"type": String("minecraft:the_end")}),
        }),
    })
    return Compound({
        "seed": Long(seed),
        "generate_features": Byte(1),
        "bonus_chest": Byte(0),
        "dimensions": Compound({
            "minecraft:overworld": overworld,
            "minecraft:the_nether": nether,
            "minecraft:the_end": the_end,
        }),
    })


def _old_generator_options(layers, biome, structures) -> str:
    payload: dict = {
        "layers": [{"block": ly["block"], "height": int(ly["height"])} for ly in layers],
        "biome": biome,
    }
    if structures:
        # 旧格式 structures 为 {name: {}}(去掉命名空间)
        payload["structures"] = {s.split(":")[-1]: {} for s in structures}
    return json.dumps(payload, separators=(",", ":"))


def _base_data(mc_version: str, data_version: int, seed: int) -> Compound:
    return Compound({
        "DataVersion": Int(data_version),
        "version": Int(19133),
        "Version": Compound({
            "Id": Int(data_version),
            "Name": String(mc_version or ""),
            "Snapshot": Byte(0),
        }),
        "LevelName": String("world"),
        "GameType": Int(0),
        "Difficulty": Byte(2),
        "hardcore": Byte(0),
        "allowCommands": Byte(0),
        "initialized": Byte(0),
        "Time": Long(0),
        "DayTime": Long(0),
        "raining": Byte(0),
        "thundering": Byte(0),
        "DataPacks": Compound({
            "Enabled": List[String]([String("vanilla")]),
            "Disabled": List[String]([]),
        }),
    })


def build_level_dat(
    mc_version: str,
    layers: list[dict],
    biome: str,
    structures: list[str],
    seed: int | None = None,
) -> bytes:
    if not layers:
        raise ValueError("至少需要一层")
    if seed is None:
        seed = int.from_bytes(secrets.token_bytes(8), "big", signed=True)
    data_version = data_version_for(mc_version)
    data = _base_data(mc_version, data_version, seed)

    if data_version >= _NEW_FORMAT_MIN:
        data["WorldGenSettings"] = _world_gen_settings(layers, biome, structures, seed)
    else:
        data["generatorName"] = String("flat")
        data["generatorVersion"] = Int(0)
        data["generatorOptions"] = String(_old_generator_options(layers, biome, structures))
        data["RandomSeed"] = Long(seed)

    nbt_file = nbtlib.File({"Data": data})
    nbt_file.root_name = ""
    fd, path = tempfile.mkstemp(suffix=".dat")
    os.close(fd)
    try:
        nbt_file.save(path, gzipped=True)
        return Path(path).read_bytes()
    finally:
        os.unlink(path)


def format_name(mc_version: str) -> str:
    return "worldgensettings" if data_version_for(mc_version) >= _NEW_FORMAT_MIN else "legacy"
