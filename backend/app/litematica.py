"""Litematica 投影库与材料清单解析。"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

import nbtlib
from litemapy import Schematic

from .config import DATA_DIR

LIBRARY = DATA_DIR / "litematica"
AIR = {"minecraft:air", "minecraft:cave_air", "minecraft:void_air"}

# Only appearance data leaves the server: inventories, command blocks and arbitrary
# custom NBT are not needed by a preview. Each payload is also depth/size bounded.
VISUAL_TAGS = set('''Age IsBaby Small ShowArms NoBasePlate Invisible Pose Rotation
Variant variant Type type Color color Sheared Size PuffState CollarColor Sitting
Owner Angry AngerTime HasNectar HasStung Saddle ChestedHorse Tame ArmorItems HandItems
equipment body_armor_item ArmorItem DecorItem SaddleItem Item item ItemRotation Facing
facing direction Rotation rotation CustomName CustomNameVisible VillagerData Profession
RabbitType CatType MainGene HiddenGene Sleeping Crouching IsScreamingGoat HasLeftHorn
HasRightHorn SkinData profile SkullOwner patterns Patterns Base sherds front_text back_text
Text1 Text2 Text3 Text4 GlowingText TextColor block_state BlockState transformation
billboard text line_width background text_opacity shadow see_through alignment
item_display display_width display_height attach_face AttachFace Peek color
Oxidation waxed weather_state Pose pose blockState extending source
CarriedBlockState ShowBottom BeamTarget Invul Pumpkin powered Health Suffocating
progress collar_color saddle body_armor SpawnData
'''.split())


def visual_nbt(data) -> dict:
    budget = [4096]
    characters = [16384]
    def clean(value, depth=0):
        budget[0] -= 1
        if depth > 12 or budget[0] < 0:
            return None
        if isinstance(value, dict):
            return {str(k)[:128]: clean(v, depth+1) for k, v in list(value.items())[:128]}
        if isinstance(value, (nbtlib.List, list, tuple)):
            return [clean(v, depth+1) for v in value[:128]]
        if isinstance(value, (nbtlib.String, str)):
            text = str(value)[:max(0, min(8192, characters[0]))]
            characters[0] -= len(text)
            return text
        if isinstance(value, (nbtlib.Byte, nbtlib.Short, nbtlib.Int, nbtlib.Long, int)):
            return int(value)
        if isinstance(value, (nbtlib.Float, nbtlib.Double, float)):
            return float(value) if math.isfinite(float(value)) else None
        return None
    return {str(k): clean(v) for k,v in data.items() if k in VISUAL_TAGS}


def region_entities(reg):
    """Include mounted passengers stored inside the root entity's NBT."""
    def visit(data, fallback_pos, fallback_rotation, depth=0):
        if depth > 16 or not isinstance(data, dict):
            return
        try:
            pos = tuple(float(v) for v in data.get('Pos', fallback_pos))
            rotation = tuple(float(v) for v in data.get('Rotation', fallback_rotation))
            if len(pos) != 3 or len(rotation) != 2 or not all(math.isfinite(v) for v in pos):
                return
        except (TypeError, ValueError):
            return
        if data.get('id'):
            yield str(data['id']), pos, rotation, data
        for passenger in data.get('Passengers', []):
            yield from visit(passenger, pos, rotation, depth+1)
    for entity in reg.entities:
        yield from visit(entity.data, entity.position, entity.rotation)

def schematic_bounds(schem):
    regions = list(schem.regions.values())
    if not regions:
        return [0, 0, 0], [0, 0, 0]
    low = [min(getattr(r, f"min_schem_{axis}")() for r in regions) for axis in "xyz"]
    high = [max(getattr(r, f"max_schem_{axis}")() for r in regions) for axis in "xyz"]
    return low, high

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
                if c and bs.id not in AIR:
                    materials[bs.id] += c
                    total += c
        else:  # 兜底:逐方块
            for x, y, z in reg.allblockpos():
                bs = reg[x, y, z]
                if bs.id not in AIR:
                    materials[bs.id] += 1
                    total += 1
    low, high = schematic_bounds(schem)
    size = [high[i] - low[i] + 1 for i in range(3)] if schem.regions else [0, 0, 0]
    mats = sorted(({"id": k, "count": v} for k, v in materials.items()), key=lambda m: -m["count"])
    return {"regions": len(schem.regions), "size": size, "total_blocks": total, "materials": mats}


def _cache_file(path: Path) -> Path:
    return path.with_name(path.name + ".info.json")


def cached_info(path: Path) -> dict | None:
    c = _cache_file(path)
    if c.exists() and c.stat().st_mtime_ns >= path.stat().st_mtime_ns:
        try:
            data = json.loads(c.read_text(encoding="utf-8"))
            return data if data.get("cache_version") == 2 else None
        except Exception:  # noqa: BLE001
            return None
    return None


def parse_and_cache(path: str | Path) -> dict:
    """解析并把结果缓存到 sidecar(<file>.info.json),下次秒回。"""
    path = Path(path)
    info = parse_info(path)
    info["cache_version"] = 2
    try:
        _cache_file(path).write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return info


def preview(path: str | Path, layer: int | None = None, region: str | None = None) -> dict:
    """Bounded voxel preview; coordinates preserve region offsets and negative sizes."""
    import math
    import numpy as np

    schem = load_schematic(path)
    low, high = schematic_bounds(schem)
    if region is not None and region not in schem.regions:
        raise ValueError("区域不存在")
    if layer is not None and not low[1] <= layer <= high[1]:
        raise ValueError("层高超出投影范围")
    regions = []
    planes = []
    total = 0
    palette = []
    block_states = []
    state_indices = {}
    entities, block_entities = [], []
    total_entities = 0
    for name, reg in schem.regions.items():
        origin = [reg.min_schem_x(), reg.min_schem_y(), reg.min_schem_z()]
        size = [abs(reg.width), abs(reg.height), abs(reg.length)]
        regions.append({"name": name, "origin": origin, "size": size})
        if region is not None and name != region:
            continue
        # Entity positions are relative to the region anchor, not its minimum
        # corner (these differ for negative region dimensions).
        anchor = [reg.x, reg.y, reg.z]
        for entity_id, relative_pos, rotation, entity_data in region_entities(reg):
            position = [float(v) + anchor[i] for i,v in enumerate(relative_pos)]
            if not all(math.isfinite(v) for v in position):
                continue
            if layer is not None and math.floor(position[1]) != layer:
                continue
            total_entities += 1
            if len(entities) < 512:
                entities.append({"id": entity_id, "position": position,
                                 "rotation": [float(v) if math.isfinite(v) else 0 for v in rotation],
                                 "data": visual_nbt(entity_data)})
        for entity in reg.tile_entities:
            position = [int(v) + anchor[i] for i,v in enumerate(entity.position)]
            if layer is None or position[1] == layer:
                block_entities.append({"position": position, "data": entity.data})
        arr = _region_block_array(reg)
        if arr is None:
            raise ValueError("当前投影格式无法生成预览")
        ids = [block.id for block in reg.palette]
        mapping = []
        for block in reg.palette:
            properties = dict(block.properties())
            key = (block.id, tuple(sorted(properties.items())))
            if key not in state_indices:
                state_indices[key] = len(palette)
                palette.append(block.id)
                block_states.append({"id": block.id, "properties": properties})
            mapping.append(state_indices[key])
        valid = np.array([block not in AIR for block in ids])
        ys = range(size[1]) if layer is None else [layer - origin[1]]
        for y in ys:
            if y < 0 or y >= size[1]:
                continue
            plane = arr[:, y, :]
            count = int(np.count_nonzero(valid[plane]))
            if count:
                planes.append((plane, valid, mapping, origin, y))
                total += count
    limit = 12000
    stride = max(1, math.ceil(total / limit))
    blocks = []
    offset = 0
    for plane, valid, mapping, origin, y in planes:
        xs, zs = np.nonzero(valid[plane])
        start = (-offset) % stride
        for x, z in zip(xs[start::stride], zs[start::stride]):
            blocks.append([int(x) + origin[0], y + origin[1], int(z) + origin[2], mapping[int(plane[x, z])]])
        offset += len(xs)
    shown_positions = {tuple(b[:3]) for b in blocks}
    block_entities = [{"position":e['position'], "data":visual_nbt(e['data'])} for e in block_entities if tuple(e['position']) in shown_positions]
    return {"origin": low, "size": [high[i] - low[i] + 1 for i in range(3)],
            "regions": regions, "palette": palette, "block_states": block_states, "blocks": blocks,
            "entities": entities, "block_entities": block_entities,
            "total_entities": total_entities, "entities_sampled": total_entities > len(entities),
            "total_blocks": total, "sampled": stride > 1, "layer": layer}
