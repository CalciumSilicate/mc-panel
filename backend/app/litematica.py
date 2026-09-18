"""Litematica 投影库与材料清单解析。"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import nbtlib
from litemapy import Schematic

from .config import DATA_DIR

LIBRARY = DATA_DIR / "litematica"
def _patch_pending_ticks(root) -> None:
    try:
        regions = root.get("Regions") or root.get("regions")
        if not regions:
            return
        for _name, reg in regions.items():
            reg.setdefault("PendingBlockTicks", nbtlib.tag.List([]))
            reg.setdefault("PendingFluidTicks", nbtlib.tag.List([]))
    except Exception:  # noqa: BLE001
        pass


def load_schematic(path: str | Path) -> Schematic:
    try:
        return Schematic.load(str(path))
    except Exception as e:  # noqa: BLE001
        try:
            obj = nbtlib.load(str(path))
            root = getattr(obj, "root", obj)
            _patch_pending_ticks(root)
            return Schematic.from_nbt(root)
        except Exception:  # noqa: BLE001
            raise e


def _region_block_array(reg):
    """litemapy 内部的方块索引 numpy 数组(palette 下标),取不到则 None。"""
    return getattr(reg, "_Region__blocks", None)


def parse_info(path: str | Path) -> dict:
    """尺寸 / 方块总数 / 材料清单(方块 id → 数量)。用 numpy bincount,避免逐方块循环。"""
    import numpy as np

    schem = load_schematic(path)
    materials: dict[str, int] = defaultdict(int)
    total = 0
    size = [0, 0, 0]
    for reg in schem.regions.values():
        arr = _region_block_array(reg)
        palette = list(reg.palette)
        size = [max(size[0], abs(reg.width)), max(size[1], abs(reg.height)), max(size[2], abs(reg.length))]
        if arr is not None:
            counts = np.bincount(arr.ravel(), minlength=len(palette))
            for idx, bs in enumerate(palette):
                c = int(counts[idx]) if idx < len(counts) else 0
                if c and bs.id != "minecraft:air":
                    materials[bs.id] += c
                    total += c
        else:  # 兜底:逐方块
            for x, y, z in reg.allblockpos():
                bs = reg[x, y, z]
                if bs.id != "minecraft:air":
                    materials[bs.id] += 1
                    total += 1
    mats = sorted(({"id": k, "count": v} for k, v in materials.items()), key=lambda m: -m["count"])
    return {"regions": len(schem.regions), "size": size, "total_blocks": total, "materials": mats}


def _cache_file(path: Path) -> Path:
    return path.with_name(path.name + ".info.json")


def cached_info(path: Path) -> dict | None:
    c = _cache_file(path)
    if c.exists():
        try:
            return json.loads(c.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
    return None


def parse_and_cache(path: str | Path) -> dict:
    """解析并把结果缓存到 sidecar(<file>.info.json),下次秒回。"""
    path = Path(path)
    info = parse_info(path)
    try:
        _cache_file(path).write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return info
