"""Litematica 投影:解析 .litematic → 材料清单 + 可建造指令(相对坐标)。

指令通过面板控制台节流下发到运行中的服务器(见 routers/litematica.py)。
解析与压缩算法移植自 asPanel。
"""
from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path

import nbtlib
from litemapy import Schematic

from .config import DATA_DIR

LIBRARY = DATA_DIR / "litematica"
MAX_FILL_VOLUME = 32
MAX_FORCELOAD_CHUNKS_PER_RANGE = 256


# ---------- SNBT ----------
def _quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _to_snbt(tag) -> str:
    from nbtlib import tag as T

    if isinstance(tag, T.Byte):
        return f"{int(tag)}b"
    if isinstance(tag, T.Short):
        return f"{int(tag)}s"
    if isinstance(tag, T.Int):
        return f"{int(tag)}"
    if isinstance(tag, T.Long):
        return f"{int(tag)}l"
    if isinstance(tag, T.Float):
        v = float(tag)
        return f"{int(v)}.0f" if v == int(v) else f"{v}f"
    if isinstance(tag, T.Double):
        v = float(tag)
        return f"{int(v)}.0d" if v == int(v) else f"{v}d"
    if isinstance(tag, T.String):
        return _quote(str(tag))
    if isinstance(tag, T.ByteArray):
        return "[B;" + ",".join(f"{int(x)}b" for x in tag) + "]"
    if isinstance(tag, T.IntArray):
        return "[I;" + ",".join(str(int(x)) for x in tag) + "]"
    if isinstance(tag, T.LongArray):
        return "[L;" + ",".join(f"{int(x)}l" for x in tag) + "]"
    if isinstance(tag, T.List):
        return "[" + ",".join(_to_snbt(x) for x in tag) + "]"
    if isinstance(tag, T.Compound):
        return "{" + ",".join(f"{_quote(k)}:{_to_snbt(v)}" for k, v in tag.items()) + "}"
    if isinstance(tag, dict):
        return "{" + ",".join(f"{_quote(str(k))}:{_to_snbt(v)}" for k, v in tag.items()) + "}"
    if isinstance(tag, (list, tuple)):
        return "[" + ",".join(_to_snbt(x) for x in tag) + "]"
    if isinstance(tag, bool):
        return "1b" if tag else "0b"
    if isinstance(tag, int):
        return str(tag)
    if isinstance(tag, float):
        return f"{int(tag)}.0d" if tag == int(tag) else f"{tag}d"
    return _quote(str(tag))


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


# ---------- 长方体压缩 ----------
def _merge_points_to_cuboids(pts):
    if not pts:
        return []
    yz_to_xs = defaultdict(list)
    for (x, y, z) in pts:
        yz_to_xs[(y, z)].append(x)
    yz_to_segments = {}
    for (y, z), xs in yz_to_xs.items():
        xs.sort()
        segs, s, e = [], xs[0], xs[0]
        for xx in xs[1:]:
            if xx == e + 1:
                e = xx
            else:
                segs.append((s, e)); s = e = xx
        segs.append((s, e))
        yz_to_segments[(y, z)] = segs
    y_to_map = defaultdict(lambda: defaultdict(list))
    for (y, z), segs in yz_to_segments.items():
        for (x1, x2) in segs:
            y_to_map[y][(x1, x2)].append(z)
    rects = []
    for y, segmap in y_to_map.items():
        for (x1, x2), zs in segmap.items():
            zs.sort()
            s, e = zs[0], zs[0]
            for zz in zs[1:]:
                if zz == e + 1:
                    e = zz
                else:
                    rects.append((y, x1, x2, s, e)); s = e = zz
            rects.append((y, x1, x2, s, e))
    key_to_ys = defaultdict(list)
    for (y, x1, x2, z1, z2) in rects:
        key_to_ys[(x1, x2, z1, z2)].append(y)
    cuboids = []
    for (x1, x2, z1, z2), ys in key_to_ys.items():
        ys.sort()
        s, e = ys[0], ys[0]
        for yy in ys[1:]:
            if yy == e + 1:
                e = yy
            else:
                cuboids.append((x1, x2, s, e, z1, z2)); s = e = yy
        cuboids.append((x1, x2, s, e, z1, z2))
    return cuboids


def _split_cuboid(cuboid, limit=MAX_FILL_VOLUME):
    x1, x2, y1, y2, z1, z2 = cuboid
    lx, ly, lz = x2 - x1 + 1, y2 - y1 + 1, z2 - z1 + 1
    if lx * ly * lz <= limit:
        return [cuboid]
    candidates = []
    for name, laxis, other in (("x", lx, ly * lz), ("y", ly, lx * lz), ("z", lz, lx * ly)):
        if other <= limit:
            max_len = max(1, limit // other)
            chunks = (laxis + max_len - 1) // max_len
            candidates.append((chunks, -laxis, name, max_len))
    if candidates:
        candidates.sort()
        _, _, axis, max_len = candidates[0]
    else:
        axis = "x" if lx >= ly and lx >= lz else ("y" if ly >= lx and ly >= lz else "z")
        longest = lx if axis == "x" else (ly if axis == "y" else lz)
        max_len = max(1, longest // 2)
    out = []
    if axis == "x":
        cur = x1
        while cur <= x2:
            nx2 = min(x2, cur + max_len - 1)
            out.extend(_split_cuboid((cur, nx2, y1, y2, z1, z2), limit)); cur = nx2 + 1
    elif axis == "y":
        cur = y1
        while cur <= y2:
            ny2 = min(y2, cur + max_len - 1)
            out.extend(_split_cuboid((x1, x2, cur, ny2, z1, z2), limit)); cur = ny2 + 1
    else:
        cur = z1
        while cur <= z2:
            nz2 = min(z2, cur + max_len - 1)
            out.extend(_split_cuboid((x1, x2, y1, y2, cur, nz2), limit)); cur = nz2 + 1
    return out


def _blocks_to_fill_cmds(blocks_by_state, limit=MAX_FILL_VOLUME):
    out = []
    for state_id, pts in blocks_by_state.items():
        if not pts:
            continue
        finals = []
        for c in _merge_points_to_cuboids(pts):
            finals.extend(_split_cuboid(c, limit))
        finals.sort(key=lambda t: (t[2], t[4], t[0], t[3], t[5], t[1]))
        for (x1, x2, y1, y2, z1, z2) in finals:
            out.append(f"fill {x1} {y1} {z1} {x2} {y2} {z2} {state_id} replace")
    return out


def _chunks_to_forceload_rects(chunks, max_area=MAX_FORCELOAD_CHUNKS_PER_RANGE):
    if not chunks:
        return []
    remaining = set(chunks)
    rects = []
    while remaining:
        cx0, cz0 = min(remaining, key=lambda t: (t[1], t[0]))
        run = 0
        while (cx0 + run, cz0) in remaining:
            run += 1
        best_w, best_h, best_area = 1, 1, 1
        for w in range(min(run, max_area), 0, -1):
            max_h = max_area // w
            if max_h <= 0:
                continue
            h = 0
            while h < max_h:
                z = cz0 + h
                if all((cx0 + dx, z) in remaining for dx in range(w)):
                    h += 1
                else:
                    break
            if w * h > best_area:
                best_w, best_h, best_area = w, h, w * h
                if best_area == max_area:
                    break
        cx1, cz1, cx2, cz2 = cx0, cz0, cx0 + best_w - 1, cz0 + best_h - 1
        rects.append((cx1, cz1, cx2, cz2))
        for zz in range(cz1, cz2 + 1):
            for xx in range(cx1, cx2 + 1):
                remaining.discard((xx, zz))
    return rects


def _global_min(schem):
    gmx = gmy = gmz = None
    for reg in schem.regions.values():
        try:
            rx, ry, rz = min(reg.xrange()) + reg.x, min(reg.yrange()) + reg.y, min(reg.zrange()) + reg.z
        except Exception:  # noqa: BLE001
            rx, ry, rz = reg.x, reg.y, reg.z
        gmx = rx if gmx is None else min(gmx, rx)
        gmy = ry if gmy is None else min(gmy, ry)
        gmz = rz if gmz is None else min(gmz, rz)
    return (gmx or 0, gmy or 0, gmz or 0)


def parse_info(path: str | Path) -> dict:
    """尺寸 / 方块总数 / 材料清单(方块 id → 数量)。"""
    schem = load_schematic(path)
    materials: dict[str, int] = defaultdict(int)
    total = 0
    gmx = gmy = gmz = None
    Mx = My = Mz = None
    for reg in schem.regions.values():
        for x, y, z in reg.allblockpos():
            bs = reg[x, y, z]
            if bs.id == "minecraft:air":
                continue
            total += 1
            materials[bs.id] += 1
            sx, sy, sz = reg.x + x, reg.y + y, reg.z + z
            gmx = sx if gmx is None else min(gmx, sx); Mx = sx if Mx is None else max(Mx, sx)
            gmy = sy if gmy is None else min(gmy, sy); My = sy if My is None else max(My, sy)
            gmz = sz if gmz is None else min(gmz, sz); Mz = sz if Mz is None else max(Mz, sz)
    size = [(Mx - gmx + 1) if Mx is not None else 0, (My - gmy + 1) if My is not None else 0, (Mz - gmz + 1) if Mz is not None else 0]
    mats = sorted(({"id": k, "count": v} for k, v in materials.items()), key=lambda m: -m["count"])
    return {"regions": len(schem.regions), "size": size, "total_blocks": total, "materials": mats}


def generate_commands(path: str | Path, offset=(0, 0, 0), place_air: bool = False) -> list[str]:
    """生成有序指令:forceload add → fill → summon → data merge → forceload remove(相对坐标)。"""
    schem = load_schematic(path)
    ox, oy, oz = offset
    gmx, gmy, gmz = _global_min(schem)
    blocks_by_state = defaultdict(set)
    summons, merges = [], []
    core_chunks = set()
    for reg in schem.regions.values():
        for x, y, z in reg.allblockpos():
            bs = reg[x, y, z]
            if not place_air and bs.id == "minecraft:air":
                continue
            dx = int(math.floor(reg.x + x - gmx + ox))
            dy = int(math.floor(reg.y + y - gmy + oy))
            dz = int(math.floor(reg.z + z - gmz + oz))
            blocks_by_state[bs.to_block_state_identifier()].add((dx, dy, dz))
            core_chunks.add((dx // 16, dz // 16))
        for ent in getattr(reg, "entities", []) or []:
            ex, ey, ez = ent.position
            dxf, dyf, dzf = reg.x + ex - gmx + ox, reg.y + ey - gmy + oy, reg.z + ez - gmz + oz
            nbt = ent.to_nbt()
            for k in ("id", "Pos", "UUID", "UUIDMost", "UUIDLeast"):
                try:
                    del nbt[k]
                except Exception:  # noqa: BLE001
                    pass
            summons.append(f"summon {ent.id} {dxf} {dyf} {dzf} {_to_snbt(nbt)}")
            core_chunks.add((int(math.floor(dxf)) // 16, int(math.floor(dzf)) // 16))
        for te in getattr(reg, "tile_entities", []) or []:
            tx, ty, tz = te.position
            dx = int(math.floor(reg.x + tx - gmx + ox))
            dy = int(math.floor(reg.y + ty - gmy + oy))
            dz = int(math.floor(reg.z + tz - gmz + oz))
            tnbt = te.to_nbt()
            for k in ("x", "y", "z"):
                try:
                    del tnbt[k]
                except Exception:  # noqa: BLE001
                    pass
            merges.append(f"data merge block {dx} {dy} {dz} {_to_snbt(tnbt)}")
            core_chunks.add((dx // 16, dz // 16))

    blocks = _blocks_to_fill_cmds(blocks_by_state)
    used = set()
    for (cx, cz) in core_chunks:
        for ux in (-1, 0, 1):
            for uz in (-1, 0, 1):
                used.add((cx + ux, cz + uz))
    rects = _chunks_to_forceload_rects(used)
    add_cmds, remove_cmds = [], []
    for (cx1, cz1, cx2, cz2) in rects:
        x1, z1, x2, z2 = cx1 * 16, cz1 * 16, cx2 * 16 + 15, cz2 * 16 + 15
        add_cmds.append(f"forceload add {x1} {z1} {x2} {z2}")
        remove_cmds.append(f"forceload remove {x1} {z1} {x2} {z2}")
    return add_cmds + blocks + summons + merges + remove_cmds
