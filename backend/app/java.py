"""Java 安装探测、MC 版本→所需 Java 映射、按版本自动选 Java。

设计:面板维护一个 Java 安装池(多条可执行文件路径)。启动实例时,根据 MC 版本
推断所需 Java 大版本,从池里挑「满足要求的最低版本」——这样老版本 MC 用老 Java、
新版本用新 Java(Java 向后兼容,但极老的 MC 在过新的 Java 上也会出问题,故取最低满足)。
"""
from __future__ import annotations

import json
import re
import subprocess

from .models import SystemSettings


def detect_java_major(path: str) -> int | None:
    """运行 `<path> -version` 解析 Java 大版本;失败返回 None。"""
    try:
        result = subprocess.run(
            [path, "-version"], capture_output=True, text=True, timeout=8
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = (result.stderr or "") + (result.stdout or "")
    m = re.search(r'version "(\d+)(?:\.(\d+))?', text)
    if not m:
        return None
    first = int(m.group(1))
    second = int(m.group(2) or 0)
    # 旧式 "1.8.0_xxx" → 8;新式 "21.0.1" → 21
    return second if first == 1 else first


def required_java_major(mc_version: str) -> int | None:
    """推断某 MC 正式版所需的 Java 大版本;无法判断(如快照)返回 None。"""
    v = mc_version.strip()
    m = re.match(r"^1\.(\d+)(?:\.(\d+))?$", v)
    if not m:
        return None
    minor = int(m.group(1))
    patch = int(m.group(2) or 0)
    if minor <= 16:
        return 8
    if minor == 17:
        return 16
    if minor in (18, 19):
        return 17
    if minor == 20:
        return 21 if patch >= 5 else 17  # 1.20.5 起要求 Java 21
    return 21  # 1.21+(更新的版本可能要求更高,但 21 是当前已知下限)


# ---------- Java 池(存于 SystemSettings.extra JSON) ----------
def get_java_paths(row: SystemSettings) -> list[str]:
    try:
        data = json.loads(row.extra or "{}")
    except (ValueError, TypeError):
        return []
    paths = data.get("java_paths", [])
    return [p for p in paths if isinstance(p, str) and p.strip()]


def set_java_paths(row: SystemSettings, paths: list[str]) -> None:
    try:
        data = json.loads(row.extra or "{}")
    except (ValueError, TypeError):
        data = {}
    # 去重保序
    seen: set[str] = set()
    cleaned: list[str] = []
    for p in paths:
        p = p.strip()
        if p and p not in seen:
            seen.add(p)
            cleaned.append(p)
    data["java_paths"] = cleaned
    row.extra = json.dumps(data, ensure_ascii=False)


def detect_installs(paths: list[str]) -> list[dict]:
    """探测每个路径的大版本,返回 [{path, major}]。"""
    return [{"path": p, "major": detect_java_major(p)} for p in paths]


def choose_java(
    mc_version: str, installs: list[dict], fallback: str
) -> tuple[str | None, str | None]:
    """选出该 MC 版本应使用的 java 可执行文件。

    返回 (java_path, error)。error 非空表示无法满足(不应启动)。
    - 需求已知:在池中选「大版本 >= 需求」里最低的那个;池里都太旧 → 报错;
      池为空 → 退回 fallback(无法校验,但尽力而为)。
    - 需求未知(快照等):池非空则选最高版本,否则用 fallback。
    """
    required = required_java_major(mc_version)
    valid = [(i["path"], i["major"]) for i in installs if i.get("major") is not None]

    if required is not None:
        satisfying = sorted((pm for pm in valid if pm[1] >= required), key=lambda x: x[1])
        if satisfying:
            return satisfying[0][0], None
        if valid:
            best = max(mj for _, mj in valid)
            return None, f"{mc_version} 需要 Java {required}+,当前已配置的最高为 Java {best}"
        return fallback, None

    if valid:
        return max(valid, key=lambda x: x[1])[0], None
    return fallback, None
