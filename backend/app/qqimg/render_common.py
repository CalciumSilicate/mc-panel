"""渲染通用件:Theme / 字体 / 圆形头像 / 阴影 / 文本截断。

照搬自 asPanel(backend/services/qq_stats_image.py 的共享部分),只保留排行榜
出图需要的东西(不含 matplotlib / 地图 / 图表),依赖仅 Pillow + httpx。

字体:优先用仓库内置字体(backend/resources/fonts/),不存在则回退到系统字体
(Windows 微软雅黑 / macOS 苹方 / Linux Noto·WQY),最后 PIL 默认字体。永不抛错。
"""
from __future__ import annotations

import functools
import io
import os
import platform
from pathlib import Path
from typing import Any, Tuple

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# backend/app/qqimg/render_common.py -> backend/
_BACKEND_DIR = Path(__file__).resolve().parents[2]
FONT_REGULAR_PATH = _BACKEND_DIR / "resources" / "fonts" / "MapleMono-NF-CN-Regular.ttf"
FONT_BOLD_PATH = _BACKEND_DIR / "resources" / "fonts" / "MapleMono-NF-CN-Bold.ttf"


class Theme:
    BG_COLOR = (248, 249, 252)
    CARD_BG = (255, 255, 255)
    SHADOW_COLOR = (20, 30, 60, 20)

    TEXT_PRIMARY = (30, 35, 50)
    TEXT_SECONDARY = (130, 140, 160)
    TEXT_ACCENT = (100, 100, 255)
    ONLINE_COLOR = (34, 197, 94)
    POSITIVE = (16, 185, 129)
    NEGATIVE = (239, 68, 68)

    CHART_LINE_COLOR = "#6366f1"
    CHART_FILL_COLOR = "#818cf8"

    CARD_RADIUS = 24


# ========= 字体 =========

def get_default_font_path(font_type: str = "regular") -> str | None:
    system = platform.system()
    if system == "Windows":
        if font_type == "bold":
            candidates = ["msyhbd.ttc", "arialbd.ttf", "simhei.ttf"]
        else:
            candidates = ["msyh.ttc", "arial.ttf", "simsun.ttc"]
        font_dir = "C:\\Windows\\Fonts"
        for font in candidates:
            path = os.path.join(font_dir, font)
            if os.path.exists(path):
                return path
    elif system == "Darwin":
        for path in ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"):
            if os.path.exists(path):
                return path
    elif system == "Linux":
        candidates = [
            "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
    return None


@functools.lru_cache(maxsize=128)
def load_font(size: int, is_bold: bool = False) -> ImageFont.FreeTypeFont:
    preferred_path = FONT_BOLD_PATH if is_bold else FONT_REGULAR_PATH
    try:
        if preferred_path and os.path.exists(preferred_path):
            return ImageFont.truetype(str(preferred_path), size)
    except Exception:
        pass
    font_path = get_default_font_path("bold" if is_bold else "regular")
    try:
        if font_path and os.path.exists(font_path):
            return ImageFont.truetype(font_path, size)
    except Exception:
        pass
    return ImageFont.load_default()


# ========= 文本 =========

def truncate_text(draw: ImageDraw.ImageDraw, text: str, font: Any, max_width: float) -> str:
    """超过 max_width 则截断并加省略号。"""
    if not text:
        return ""
    text_w = draw.textlength(text, font=font)
    if text_w <= max_width:
        return text
    ellipsis_w = draw.textlength("...", font=font)
    avail_w = max_width - ellipsis_w
    if avail_w <= 0:
        return "..."
    avg_char_w = text_w / len(text)
    approx_len = int(avail_w / avg_char_w) + 2
    current_text = text[:approx_len]
    while len(current_text) > 0:
        if draw.textlength(current_text, font=font) <= avail_w:
            return current_text + "..."
        current_text = current_text[:-1]
    return "..."


# ========= 阴影 / 圆形头像 =========

def draw_shadow(img: Image.Image, bbox: Tuple[int, int, int, int], radius: int, blur: int = 20, offset=(0, 8)) -> None:
    x0, y0, x1, y1 = map(int, bbox)
    w, h = x1 - x0, y1 - y0
    shadow_w = w + blur * 4
    shadow_h = h + blur * 4
    shadow_img = Image.new("RGBA", (shadow_w, shadow_h), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_img)
    sx0 = blur * 2 + offset[0]
    sy0 = blur * 2 + offset[1]
    shadow_draw.rounded_rectangle((sx0, sy0, sx0 + w, sy0 + h), radius=radius, fill=Theme.SHADOW_COLOR)
    shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(shadow_img, (x0 - blur * 2, y0 - blur * 2))


@functools.lru_cache(maxsize=64)
def _cached_circle_avatar(img_path: str, size: int) -> Image.Image:
    try:
        if img_path and (img_path.startswith("http://") or img_path.startswith("https://")):
            resp = httpx.get(img_path, timeout=5.0, follow_redirects=True)
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGBA")
        elif not img_path or not os.path.exists(img_path):
            raise FileNotFoundError
        else:
            img = Image.open(img_path).convert("RGBA")
    except Exception:
        img = Image.new("RGBA", (size, size), (220, 220, 220))
        d = ImageDraw.Draw(img)
        font = load_font(max(8, size // 2), is_bold=True)
        d.text((size / 2, size / 2), "?", fill=(150, 150, 150), font=font, anchor="mm")
    img = img.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    output.paste(img, (0, 0), mask)
    return output


def crop_circle_avatar(img_path: str, size: int) -> Image.Image:
    return _cached_circle_avatar(img_path or "", size).copy()
