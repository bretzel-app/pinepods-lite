#!/usr/bin/env python3
"""Generate the Android launcher icons and splash images from the web app's icons.

The web icons in public/ are the single source. Run this after changing them:

    python3 scripts/android-icons.py

Requires Pillow (pip install Pillow). Output goes to android/app/src/main/res/.

- Adaptive icon (Android 8+): the maskable icon, scaled the way Chrome does it for
  an installed web app, so its 80% safe zone lands on Android's 66dp safe zone.
  The background layer is the maskable icon's own background colour.
- Legacy icons (Android 7): the maskable icon, clipped to a rounded square / circle.
- Splash: the pine cone on the web manifest's background colour.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android/app/src/main/res"
MASKABLE = Image.open(ROOT / "public/icon-maskable.png").convert("RGBA")
CONE = Image.open(ROOT / "public/icon-512.png").convert("RGBA")
SPLASH_BG = "#f0e6d3"  # background_color in vite.config.ts

DENSITIES = {"ldpi": 0.75, "mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
# Chrome maps a maskable icon's 80% safe zone onto the adaptive icon's 66/108 safe zone.
MASKABLE_SCALE = (66 / 108) / 0.8


def resized(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.Resampling.BOX)


def adaptive_foreground(px: int) -> Image.Image:
    layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    inner = round(px * MASKABLE_SCALE)
    off = (px - inner) // 2
    layer.paste(resized(MASKABLE, inner), (off, off))
    return layer


def masked(img: Image.Image, round_icon: bool) -> Image.Image:
    size = img.size[0]
    scale = 4  # draw the mask large, then shrink it, for smooth edges
    mask = Image.new("L", (size * scale, size * scale), 0)
    box = (0, 0, size * scale - 1, size * scale - 1)
    if round_icon:
        ImageDraw.Draw(mask).ellipse(box, fill=255)
    else:
        ImageDraw.Draw(mask).rounded_rectangle(box, radius=size * scale // 6, fill=255)
    out = img.copy()
    out.putalpha(mask.resize(img.size, Image.Resampling.LANCZOS))
    return out


def splash(path: Path) -> None:
    w, h = Image.open(path).size
    img = Image.new("RGB", (w, h), SPLASH_BG)
    cone = CONE.crop(CONE.getbbox())
    target_h = round(min(w, h) * 0.3)
    target_w = round(cone.width * target_h / cone.height)
    cone = cone.resize((target_w, target_h), Image.Resampling.BOX)
    img.paste(cone, ((w - target_w) // 2, (h - target_h) // 2), cone)
    img.save(path)


def main() -> None:
    bg = MASKABLE.getpixel((0, 0))
    for name, factor in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        legacy = resized(MASKABLE, round(48 * factor))
        masked(legacy, round_icon=False).save(folder / "ic_launcher.png")
        masked(legacy, round_icon=True).save(folder / "ic_launcher_round.png")
        if name != "ldpi":
            adaptive_foreground(round(108 * factor)).save(folder / "ic_launcher_foreground.png")

    (RES / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">#{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}</color>\n'
        "</resources>\n"
    )

    for path in sorted(RES.glob("drawable*/splash.png")):
        splash(path)


if __name__ == "__main__":
    main()
