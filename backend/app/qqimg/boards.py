"""内置榜单注册表(照搬 asPanel qq_rank_command 的榜单定义)。

每个榜单 = 一组 metric 键 + 缩放系数 scale + 数值格式化器。mc-panel 的 metric 键
与 asPanel 完全一致(规范化短键:custom.play_time / mined.stone / used.* / killed_by.*),
所以榜单定义可以照抄。

榜单值计算:sum(该玩家这些 metric 的 total) * scale,再交给 formatter 格式化。
- 在线榜:play ticks * (1/20/3600) -> 小时 -> "12h30m"
- 距离榜:cm * 0.00001 -> km -> "4.5km" / "120m"
- 其它:整数带千分位

含通配符(mined.*)的榜单由 rank_builder 展开;metric 为空的「特殊榜」(航天/最后在线/
放置)暂未移植,resolve_board 会返回它们但 rank_builder 目前按普通空榜处理(提示无数据)。
"""
from __future__ import annotations

import functools
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

# ---- 复用 asPanel 的 metric 分组常量 ----
_TOOLS = ["axe", "sword", "pickaxe", "shovel", "hoe"]
_MATS = ["wooden", "stone", "iron", "golden", "diamond", "netherite", "copper"]
_BREAK_METRICS = ["used.shears", *[f"used.{m}_{t}" for m in _MATS for t in _TOOLS]]
_WALK_METRICS = [
    "custom.fly_one_cm", "custom.sprint_one_cm", "custom.walk_one_cm",
    "custom.walk_under_water_one_cm", "custom.walk_on_water_one_cm",
    "custom.crouch_one_cm", "custom.swim_one_cm",
]
_VEHICLE = ["boat", "horse", "minecart", "pig", "crouch"]
_VEHICLE_METRICS = [f"custom.{v}_one_cm" for v in _VEHICLE]

_BAD_FOOD_METRICS = [
    "used.poisonous_potato", "used.rotten_flesh", "used.spider_eye",
    "used.pufferfish", "used.suspicious_stew",
]
_EAT_METRICS = [
    "used.apple", "used.golden_apple", "used.enchanted_golden_apple", "used.baked_potato",
    "used.beetroot", "used.beetroot_soup", "used.bread", "custom.eat_cake_slice", "used.carrot",
    "used.chorus_fruit", "used.cooked_chicken", "used.cooked_cod", "used.cooked_mutton",
    "used.cooked_porkchop", "used.cooked_rabbit", "used.cooked_salmon", "used.cookie",
    "used.dried_kelp", "used.glow_berries", "used.golden_carrot", "used.honey_bottle",
    "used.melon_slice", "used.mushroom_stew", "used.potato", "used.poisonous_potato",
    "used.pufferfish", "used.pumpkin_pie", "used.rabbit_stew", "used.raw_beef", "used.raw_chicken",
    "used.raw_cod", "used.raw_mutton", "used.raw_porkchop", "used.raw_rabbit", "used.raw_salmon",
    "used.rotten_flesh", "used.spider_eye", "used.steak", "used.suspicious_stew",
    "used.sweet_berries", "used.tropical_fish",
]


# ---- 数值格式化器 ----

def _time_formatter(hours: float) -> str:
    try:
        total_minutes = int(round(float(hours) * 60))
    except Exception:
        return "0"
    h = total_minutes // 60
    m = total_minutes % 60
    parts: List[str] = []
    if h > 0:
        parts.append(f"{h:,}h")
    if m > 0:
        parts.append(f"{m}m")
    if h == 0 and m == 0:
        parts.append("<1m")
    return "".join(parts) if parts else "0"


def _distance_formatter(km: float) -> str:
    try:
        km_f = float(km)
        abs_km = abs(km_f)
    except Exception:
        return "0"
    if abs_km >= 1_000:
        s = f"{km_f:,.1f}".rstrip("0").rstrip(".")
        return f"{s}km"
    if abs_km >= 1:
        s = f"{km_f:,.2f}".rstrip("0").rstrip(".")
        return f"{s}km"
    meters = km_f * 1000
    return f"{meters:,.2f}".rstrip("0").rstrip(".") + "m"


def _fmt_int(val: object) -> str:
    try:
        return f"{int(val):,}"
    except Exception:
        return str(val)


@dataclass(frozen=True)
class BuiltinBoard:
    name: str
    description: str
    metrics: List[str]
    scale: float
    formatter: Callable[[float], str]
    special: Optional[str] = None  # 非空 metrics 为普通榜;special 标记暂未移植的特殊榜


@functools.lru_cache(maxsize=1)
def _builtin_boards() -> Dict[str, BuiltinBoard]:
    move_metrics = ["custom.aviate_one_cm", "custom.ender_pearl_one_cm", *_WALK_METRICS, *_VEHICLE_METRICS]

    boards = [
        BuiltinBoard("上线榜", "统计上线次数", ["custom.leave_game"], 1.0, _fmt_int),
        BuiltinBoard("在线榜", "统计在线时长", ["custom.play_one_minute", "custom.play_time"], 1 / 20 / 3600, _time_formatter),
        BuiltinBoard("挖掘榜", "统计挖掘方块(按工具使用次数汇总)", list(_BREAK_METRICS), 1.0, _fmt_int),
        BuiltinBoard("真挖掘榜", "统计挖掘方块(按方块挖掘次数汇总)", ["mined.*"], 1.0, _fmt_int),
        BuiltinBoard("击杀榜", "统计击杀玩家数", ["custom.player_kills"], 1.0, _fmt_int),
        BuiltinBoard("被击杀榜", "统计被玩家击杀数", ["killed_by.player"], 1.0, _fmt_int),
        BuiltinBoard("死亡榜", "统计死亡次数", ["custom.deaths"], 1.0, _fmt_int),
        BuiltinBoard("鞘翅榜", "统计鞘翅飞行距离", ["custom.aviate_one_cm"], 0.00001, _distance_formatter),
        BuiltinBoard("珍珠榜", "统计末影珍珠传送距离", ["custom.ender_pearl_one_cm"], 0.00001, _distance_formatter),
        BuiltinBoard("步行榜", "统计步行/游泳等距离", list(_WALK_METRICS), 0.00001, _distance_formatter),
        BuiltinBoard("移动榜", "统计移动距离(含鞘翅/珍珠/步行/交通工具)", move_metrics, 0.00001, _distance_formatter),
        BuiltinBoard("烟花榜", "统计使用烟花次数", ["custom.firework_boost", "used.firework_rocket"], 1.0, _fmt_int),
        BuiltinBoard("不死图腾榜", "统计消耗不死图腾次数", ["used.totem_of_undying"], 1.0, _fmt_int),
        BuiltinBoard("基岩榜", "统计破基岩次数", ["custom.break_bedrock"], 1.0, _fmt_int),
        BuiltinBoard("吃货榜", "统计吃各类食物次数", list(_EAT_METRICS), 1.0, _fmt_int),
        BuiltinBoard("小馋猫榜", "统计吃各类会提供负面效果食物的次数", list(_BAD_FOOD_METRICS), 1.0, _fmt_int),
    ]
    out: Dict[str, BuiltinBoard] = {}
    for b in boards:
        out[b.name] = b
        if b.name.endswith("榜"):
            out[b.name[:-1]] = b
    # 特殊榜(依赖 PlayerPosition/PlayerSession,暂未移植)——先登记,便于 list/help 展示
    _spec = [
        BuiltinBoard("航天榜", "玩家最高 Y 值(米)", [], 1.0, lambda x: f"{float(x):.1f}m", special="space"),
        BuiltinBoard("最后在线榜", "最近一次在线时间(越晚越靠前)", [], 1.0, str, special="last_seen"),
        BuiltinBoard("放置榜", "统计放置方块次数(只统计可挖掘的方块)", [], 1.0, _fmt_int, special="placement"),
    ]
    for b in _spec:
        out[b.name] = b
        if b.name.endswith("榜"):
            out[b.name[:-1]] = b
    return out


def list_board_names() -> List[str]:
    return [
        "上线榜", "在线榜", "挖掘榜", "真挖掘榜", "放置榜", "击杀榜", "被击杀榜", "死亡榜",
        "鞘翅榜", "珍珠榜", "步行榜", "移动榜", "烟花榜", "不死图腾榜", "基岩榜",
        "航天榜", "最后在线榜", "吃货榜", "小馋猫榜",
    ]


def resolve_board(query: str) -> Optional[BuiltinBoard]:
    q = (query or "").strip()
    if not q:
        return None
    return _builtin_boards().get(q)
