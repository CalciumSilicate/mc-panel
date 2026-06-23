"""CQ 码 → 结构化段(供聊天室前端渲染)。"""
from __future__ import annotations

import re

_CQ = re.compile(r"\[CQ:([a-zA-Z]+)((?:,[^\]]*?)?)\]")


def _unescape(s: str) -> str:
    return (
        s.replace("&#44;", ",")
        .replace("&#91;", "[")
        .replace("&#93;", "]")
        .replace("&amp;", "&")
    )


def _cq_to_seg(typ: str, params: dict) -> dict:
    if typ == "image":
        return {"type": "image", "url": params.get("url") or params.get("file") or ""}
    if typ == "at":
        return {"type": "at", "qq": params.get("qq", ""), "name": params.get("name", "")}
    if typ == "face":
        return {"type": "face", "id": params.get("id", "")}
    if typ == "reply":
        return {"type": "reply", "id": params.get("id", ""), "user": "", "text": ""}
    if typ == "record":
        return {"type": "text", "text": "[语音]"}
    if typ == "video":
        return {"type": "text", "text": "[视频]"}
    return {"type": "text", "text": f"[{typ}]"}


def parse(s: str) -> list[dict]:
    """把含 [CQ:...] 的字符串解析成段数组(纯文本则单个 text 段)。"""
    if not s:
        return []
    segs: list[dict] = []
    pos = 0
    for m in _CQ.finditer(s):
        if m.start() > pos:
            segs.append({"type": "text", "text": _unescape(s[pos:m.start()])})
        params: dict[str, str] = {}
        for kv in m.group(2).split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                params[k.strip()] = _unescape(v)
        segs.append(_cq_to_seg(m.group(1), params))
        pos = m.end()
    if pos < len(s):
        segs.append({"type": "text", "text": _unescape(s[pos:])})
    return [x for x in segs if x.get("type") != "text" or x.get("text")]
