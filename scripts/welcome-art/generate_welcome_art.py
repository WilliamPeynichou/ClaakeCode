#!/usr/bin/env python3
"""Generate the Welcome screen pixel-mosaic art (autumn forest + Claaky).

The scene is painted procedurally at high resolution, downsampled to a coarse
grid (one pixel = one mosaic cell) and ordered-dithered, which gives the
"LED screen / 3D render seen through a grid" look. It is split in layers so
the Welcome canvas (src/components/WelcomeArt.tsx) can animate them:

  sky.png     2× wide, horizontally tileable  → clouds drift
  back.png    forest, rocks, ground, shadow   → static
  claaky.png  Claaky sprite                   → gentle bob
  front.png   foreground foliage              → static, over Claaky

Usage:  python3 scripts/welcome-art/generate_welcome_art.py
Needs:  numpy, Pillow. Source sprite: scripts/welcome-art/claaky-idle.png
        (Claaky 2D SVG rendered at 6× on a transparent background).
"""

from __future__ import annotations

import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "src", "assets", "welcome"))

CELLS_W, CELLS_H = 128, 160  # mosaic grid
SCALE = 5                    # hi-res painting scale
W, H = CELLS_W * SCALE, CELLS_H * SCALE

rng = random.Random(7)
nrng = np.random.default_rng(7)


# ---------------------------------------------------------------- helpers
def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def shade(c, f):
    return tuple(max(0, min(255, int(round(v * f)))) for v in c)


def periodic_value_noise(w, h, cells_x, cells_y, seed):
    """Smooth value noise, periodic along x (for a tileable sky)."""
    g = np.random.default_rng(seed).random((cells_y + 2, cells_x))
    xs = np.linspace(0, cells_x, w, endpoint=False)
    ys = np.linspace(0, cells_y, h, endpoint=False)
    x0 = np.floor(xs).astype(int)
    y0 = np.floor(ys).astype(int)
    fx = xs - x0
    fy = ys - y0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    x1 = (x0 + 1) % cells_x
    x0 = x0 % cells_x
    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x1)]
    c = g[np.ix_(y0 + 1, x0)]
    d = g[np.ix_(y0 + 1, x1)]
    top = a + (b - a) * fx[None, :]
    bot = c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def fbm(w, h, base_x, base_y, octaves, seed):
    total = np.zeros((h, w))
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        total += amp * periodic_value_noise(w, h, base_x * 2**o, base_y * 2**o, seed + o * 31)
        norm += amp
        amp *= 0.5
    return total / norm


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- palettes
SKY_TOP = np.array(hex_rgb("#1f86dc"), float)
SKY_MID = np.array(hex_rgb("#48a8ec"), float)
SKY_LOW = np.array(hex_rgb("#a7dcf7"), float)

AUTUMN_DEEP = [hex_rgb(c) for c in ("#3e0f05", "#561507", "#6a1c08", "#4c1a0a")]
AUTUMN_MID = [hex_rgb(c) for c in ("#9c2e0c", "#b23c10", "#c64c14", "#d25a16", "#a8240e")]
AUTUMN_HI = [hex_rgb(c) for c in ("#e2601a", "#ec721c", "#f4861f", "#fb9a26", "#e0521a")]
AUTUMN_SPARK = [hex_rgb(c) for c in ("#ffb52e", "#ffc93f", "#ffa51f")]


def autumn_color(light: float):
    """light ∈ [0,1]: 0 = shadowed underside, 1 = sunlit top."""
    r = rng.random()
    if light < 0.28:
        base = rng.choice(AUTUMN_DEEP)
    elif light < 0.62:
        base = rng.choice(AUTUMN_MID if r > 0.2 else AUTUMN_DEEP)
    elif light < 0.88:
        base = rng.choice(AUTUMN_HI if r > 0.3 else AUTUMN_MID)
    else:
        base = rng.choice(AUTUMN_SPARK if r > 0.4 else AUTUMN_HI)
    return shade(base, 0.9 + rng.random() * 0.2)


# ---------------------------------------------------------------- painters
def paint_sky():
    sw = W * 2
    y = np.linspace(0, 1, H)[:, None, None]  # (H,1,1)
    grad = np.where(
        y < 0.45,
        SKY_TOP + (SKY_MID - SKY_TOP) * (y / 0.45),
        SKY_MID + (SKY_LOW - SKY_MID) * ((y - 0.45) / 0.55),
    )  # (H,1,3)
    sky = np.repeat(grad, sw, axis=1)

    dens = fbm(sw, H, 4, 4, 5, 11)
    detail = fbm(sw, H, 14, 12, 4, 91)
    yy = np.linspace(0, 1, H)[:, None]
    # Clouds live in the upper ~60%, thicker in a band, with puffy bulges.
    band = smoothstep(0.02, 0.22, yy) * (1 - smoothstep(0.42, 0.66, yy))
    xx = np.linspace(0, 1, sw, endpoint=False)[None, :]
    bulge = 0.5 + 0.5 * np.cos((xx - 0.7) * 2 * np.pi * 2)  # two cloud banks around
    c = dens * (0.5 + 0.5 * bulge) * band + 0.20 * detail - 0.06
    alpha = smoothstep(0.325, 0.35, c)

    # Lighting: sun from upper-left → brighter where density rises downward.
    shifted = np.roll(np.roll(c, -14, axis=0), 10, axis=1)
    lit = np.clip((c - shifted) * 7 + 0.62, 0, 1)
    white = np.array([255, 255, 255], float)
    shadow = np.array(hex_rgb("#9db4cc"), float)
    mid = np.array(hex_rgb("#dfe9f3"), float)
    cloud = np.where(
        lit[..., None] > 0.55,
        mid + (white - mid) * ((lit[..., None] - 0.55) / 0.45),
        shadow + (mid - shadow) * (lit[..., None] / 0.55),
    )
    out = sky * (1 - alpha[..., None]) + cloud * alpha[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def canopy(draw, cx, cy, rx, ry, n, rmin, rmax, haze=0.0, haze_col=(160, 210, 240)):
    """Cauliflower-like foliage: a dark undercoat, then sub-clumps each lit
    from the top-left, leaves sorted dark → bright so highlights sit on top."""
    def hz(col):
        return mix(col, haze_col, haze) if haze else col

    under = hz(rng.choice(AUTUMN_DEEP))
    draw.ellipse((cx - rx * 0.92, cy - ry * 0.85, cx + rx * 0.92, cy + ry * 0.95), fill=under + (255,))
    clumps = max(3, n // 90)
    leaves = []
    for _ in range(clumps):
        a = rng.random() * 2 * math.pi
        d = math.sqrt(rng.random()) * 0.78
        kx = cx + math.cos(a) * rx * d
        ky = cy + math.sin(a) * ry * d
        kr = rng.uniform(0.28, 0.45) * min(rx, ry) + 6
        # clumps higher in the crown catch more sun
        base_light = 0.48 - ((ky - cy) / (ry + 1)) * 0.36 - ((kx - cx) / (rx + 1)) * 0.12
        for _ in range(n // clumps):
            aa = rng.random() * 2 * math.pi
            dd = math.sqrt(rng.random())
            x = kx + math.cos(aa) * kr * dd
            y = ky + math.sin(aa) * kr * dd * 0.9
            local = -((y - ky) / kr) * 0.5 - ((x - kx) / kr) * 0.18  # lit top-left
            light = base_light + local + rng.uniform(-0.12, 0.12)
            leaves.append((max(0.0, min(1.0, light)), x, y, rng.uniform(rmin, rmax)))
    leaves.sort(key=lambda l: l[0])
    for light, x, y, r in leaves:
        col = hz(autumn_color(light))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=col + (255,))


def trunk(draw, x, y0, y1, w, col=(58, 30, 20)):
    draw.line((x, y0, x + rng.uniform(-6, 6), y1), fill=col + (255,), width=int(w))


def rock(img, cx, cy, rx, ry, seed, tone="#8f9db3"):
    """Irregular shaded boulder with speckle, painted into img (RGBA)."""
    r_ = random.Random(seed)
    pts = []
    k = 22
    for i in range(k):
        a = i / k * 2 * math.pi
        rr = 1 + r_.uniform(-0.16, 0.12)
        flat = 0.82 if math.sin(a) > 0.3 else 1.0  # flatter base
        pts.append((cx + math.cos(a) * rx * rr, cy + math.sin(a) * ry * rr * flat))
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    m = np.array(mask, float) / 255
    ys, xs = np.mgrid[0:H, 0:W]
    nx = (xs - cx) / rx
    ny = (ys - cy) / ry
    light = np.clip(0.62 - nx * 0.35 - ny * 0.55, 0, 1)
    speck = periodic_value_noise(W, H, 90, 110, seed) * 0.35 + periodic_value_noise(W, H, 30, 36, seed + 3) * 0.3
    light = np.clip(light * 0.8 + speck - 0.25, 0, 1)
    base = np.array(hex_rgb(tone), float)
    hi = np.array(hex_rgb("#dfe6f0"), float)
    lo = np.array(hex_rgb("#3d4556"), float)
    col = np.where(
        light[..., None] > 0.5,
        base + (hi - base) * ((light[..., None] - 0.5) * 2),
        lo + (base - lo) * (light[..., None] * 2),
    )
    arr = np.array(img, float)
    a = m[..., None]
    arr[..., :3] = arr[..., :3] * (1 - a) + col * a
    arr[..., 3] = np.maximum(arr[..., 3], m * 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def flower_stalks(draw, x0, x1, ybase, n):
    for _ in range(n):
        x = rng.uniform(x0, x1)
        top = ybase - rng.uniform(40, 110)
        draw.line((x, ybase, x + rng.uniform(-10, 10), top), fill=(120, 70, 25, 255), width=2)
        for _ in range(rng.randint(5, 10)):
            fx = x + rng.uniform(-9, 9)
            fy = top + rng.uniform(-6, 40)
            r = rng.uniform(2.5, 5)
            col = rng.choice(AUTUMN_SPARK + [hex_rgb("#ffcc33")])
            draw.ellipse((fx - r, fy - r, fx + r, fy + r), fill=col + (255,))


def meadow(draw, y0, y1, n):
    for _ in range(n):
        x = rng.uniform(-10, W + 10)
        y = rng.uniform(y0, y1)
        depth = (y - y0) / (y1 - y0)
        h = rng.uniform(8, 20) * (0.6 + depth)
        light = rng.random() * 0.7 + 0.3 * (1 - depth)
        col = autumn_color(light)
        draw.line((x, y, x + rng.uniform(-5, 5), y - h), fill=col + (255,), width=rng.choice([2, 3]))
        if rng.random() < 0.08:
            r = rng.uniform(2, 4)
            fc = rng.choice(AUTUMN_SPARK + [(255, 255, 240)])
            draw.ellipse((x - r, y - h - r, x + r, y - h + r), fill=fc + (255,))


# ---------------------------------------------------------------- scene
def paint_back():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    horizon = 430
    # Far hazy crowns against the sky.
    for i in range(24):
        cx = -20 + i * 29 + rng.uniform(-8, 8)
        cy = horizon - 10 + rng.uniform(-22, 16)
        canopy(d, cx, cy, rng.uniform(28, 42), rng.uniform(24, 36), 180, 4, 7,
               haze=0.4, haze_col=(246, 196, 160))
    # Forest interior: deep shaded wall with trunks — makes Claaky pop.
    wall = np.zeros((H, W, 4), np.uint8)
    top = horizon + 8
    for y in range(top, H):
        t = (y - top) / (H - top)
        col = mix(hex_rgb("#5a1d0c"), hex_rgb("#2c0d05"), min(1, t * 1.6))
        wall[y, :, :3] = col
        wall[y, :, 3] = 255
    img.alpha_composite(Image.fromarray(wall, "RGBA"))
    d = ImageDraw.Draw(img)
    for _ in range(28):
        x = rng.uniform(0, W)
        trunk(d, x, H, horizon + rng.uniform(0, 60), rng.uniform(3, 7), col=(34, 14, 8))
    for _ in range(12):  # dappled light in the undergrowth
        cx, cy = rng.uniform(150, 520), rng.uniform(480, 640)
        canopy(d, cx, cy, rng.uniform(20, 40), rng.uniform(14, 24), 120, 3, 6, haze=0.0)
    # Mid trees.
    for cx in (60, 170, 500, 610):
        trunk(d, cx, 620, 440, 8)
    for cx, cy, rx, ry in ((40, 430, 120, 100), (210, 470, 80, 60), (480, 450, 90, 75), (620, 410, 100, 120)):
        canopy(d, cx, cy, rx, ry, 900, 4, 9, haze=0.06)
    # Big side masses framing the scene.
    canopy(d, 40, 610, 170, 200, 2600, 5, 11)
    canopy(d, 610, 610, 130, 140, 1800, 5, 11)
    flower_stalks(d, 10, 150, 500, 9)
    flower_stalks(d, 560, 640, 540, 5)
    # Ground.
    d.rectangle((0, 700, W, H), fill=hex_rgb("#7a2a0e") + (255,))
    meadow(d, 650, 800, 3200)
    # Rocks.
    img = rock(img, 200, 650, 95, 82, 3)
    img = rock(img, 575, 765, 120, 46, 5, tone="#7f8ea6")
    img = rock(img, 30, 775, 70, 40, 9, tone="#8a95a8")
    d = ImageDraw.Draw(img)
    meadow(d, 740, 800, 1000)
    # Contact shadow under Claaky.
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((280, 712, 476, 750), fill=(30, 8, 2, 170))
    sh = sh.filter(ImageFilter.GaussianBlur(8))
    img.alpha_composite(sh)
    return img


def paint_front():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    meadow(d, 735, 800, 700)
    canopy(d, 300, 790, 70, 26, 260, 4, 8)
    canopy(d, 470, 795, 60, 22, 200, 4, 8)
    return img


def claaky_layer():
    sprite = Image.open(os.path.join(HERE, "claaky-idle.png")).convert("RGBA")
    sprite = sprite.crop(sprite.split()[-1].getbbox())
    target_h = 270
    sprite = sprite.resize((round(sprite.width * target_h / sprite.height), target_h), Image.LANCZOS)
    # Warm autumn light on Claaky: slight orange rim from the forest.
    arr = np.array(sprite, float)
    arr[..., 0] = np.clip(arr[..., 0] * 1.04 + 6, 0, 255)
    arr[..., 2] = np.clip(arr[..., 2] * 0.94, 0, 255)
    sprite = Image.fromarray(arr.astype(np.uint8), "RGBA")
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x = 378 - sprite.width // 2
    y = 735 - sprite.height
    img.alpha_composite(sprite, (x, y))
    return img


# ---------------------------------------------------------------- mosaic
BAYER4 = (
    np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], float) + 0.5
) / 16 - 0.5


def to_cells(img: Image.Image, cells_w: int, cells_h: int, levels: int = 7) -> Image.Image:
    rgba = img.mode == "RGBA"
    if rgba:
        small = img.convert("RGBa").resize((cells_w, cells_h), Image.BOX).convert("RGBA")
    else:
        small = img.resize((cells_w, cells_h), Image.BOX)
    arr = np.array(small, float)
    step = 255 / (levels - 1)
    th = np.tile(BAYER4, (cells_h // 4 + 1, cells_w // 4 + 1))[:cells_h, :cells_w]
    rgb = arr[..., :3] + th[..., None] * step
    rgb = np.clip(np.round(rgb / step) * step, 0, 255)
    if rgba:
        a = np.where(arr[..., 3] > 110, 255, 0)
        out = np.dstack([rgb, a]).astype(np.uint8)
        return Image.fromarray(out, "RGBA")
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    to_cells(paint_sky(), CELLS_W * 2, CELLS_H, levels=12).save(os.path.join(OUT, "sky.png"), optimize=True)
    to_cells(paint_back(), CELLS_W, CELLS_H).save(os.path.join(OUT, "back.png"), optimize=True)
    to_cells(claaky_layer(), CELLS_W, CELLS_H, levels=9).save(os.path.join(OUT, "claaky.png"), optimize=True)
    to_cells(paint_front(), CELLS_W, CELLS_H).save(os.path.join(OUT, "front.png"), optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
