#!/usr/bin/env python3
"""Generate the Welcome screen pixel-mosaic art (autumn alpine lake + Claaky).

The scene is painted procedurally at high resolution, downsampled to a coarse
grid (one pixel = one mosaic cell) and ordered-dithered, which gives the
"LED screen / 3D render seen through a grid" look. It is split in layers so
the Welcome canvas (src/components/WelcomeArt.tsx) can animate them:

  sky.png     2× wide, horizontally tileable        → clouds drift
  back.png    mountains, lake, forest, meadow, path → static
  water.png   lake mask (L)                         → sun glints
  claaky0.png / claaky1.png
              Claaky relit by the scene and baked into it (edges blended
              before the mosaic), resting / one cell up  → gentle bob
  front.png   foreground grass                      → static, over Claaky

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
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "src", "assets", "welcome"))

CELLS_W, CELLS_H = 144, 180  # mosaic grid
SCALE = 5                    # hi-res painting scale
W, H = CELLS_W * SCALE, CELLS_H * SCALE

# Claaky stands on the path, mid-distance (feet position, height in px).
CLAAKY_FEET = (CELLS_W * SCALE * 0.535, CELLS_H * SCALE * 0.865)
CLAAKY_H = CELLS_H * SCALE * 0.27

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


def autumn_color(light: float, warm: float = 0.0):
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


def meadow(draw, y0, y1, n):
    for _ in range(n):
        x = rng.uniform(-10, W + 10)
        y = rng.uniform(y0, y1)
        depth = (y - y0) / (y1 - y0)
        h = rng.uniform(8, 20) * (0.6 + depth)
        light = rng.random() * 0.6 + 0.4 * (1 - depth) + 0.1
        col = autumn_color(light)
        draw.line((x, y, x + rng.uniform(-5, 5), y - h), fill=col + (255,), width=rng.choice([2, 3]))
        if rng.random() < 0.08:
            r = rng.uniform(2, 4)
            fc = rng.choice(AUTUMN_SPARK + [(255, 255, 240)])
            draw.ellipse((x - r, y - h - r, x + r, y - h + r), fill=fc + (255,))


# ---------------------------------------------------------------- scene
def X(f: float) -> float:
    return f * W


def Y(f: float) -> float:
    return f * H


def paint_sky():
    sw = W * 2
    y = np.linspace(0, 1, H)[:, None, None]
    grad = np.where(
        y < 0.4,
        SKY_TOP + (SKY_MID - SKY_TOP) * (y / 0.4),
        SKY_MID + (SKY_LOW - SKY_MID) * np.clip((y - 0.4) / 0.2, 0, 1),
    )
    sky = np.repeat(grad, sw, axis=1)
    dens = fbm(sw, H, 6, 6, 5, 11)
    detail = fbm(sw, H, 18, 16, 4, 91)
    yy = np.linspace(0, 1, H)[:, None]
    band = smoothstep(0.0, 0.08, yy) * (1 - smoothstep(0.22, 0.36, yy))
    c = dens * band + 0.22 * detail * band - 0.02
    alpha = smoothstep(0.37, 0.40, c)
    shifted = np.roll(np.roll(c, -12, axis=0), 9, axis=1)
    lit = np.clip((c - shifted) * 8 + 0.6, 0, 1)
    white = np.array([255, 255, 255], float)
    shadow = np.array(hex_rgb("#a3b8cf"), float)
    mid = np.array(hex_rgb("#e3ecf5"), float)
    cloud = np.where(
        lit[..., None] > 0.55,
        mid + (white - mid) * ((lit[..., None] - 0.55) / 0.45),
        shadow + (mid - shadow) * (lit[..., None] / 0.55),
    )
    out = sky * (1 - alpha[..., None]) + cloud * alpha[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def ridge(n: int, y_lo: float, y_hi: float, rough: float, seed: int, peaks=()):
    """1-D midpoint displacement → ridge heights (pixel y) for every column."""
    r = random.Random(seed)
    size = 1
    while size < n:
        size *= 2
    pts = np.zeros(size + 1)
    pts[0] = r.uniform(0.4, 0.8)
    pts[-1] = r.uniform(0.4, 0.8)
    step, amp = size, 0.5
    while step > 1:
        half = step // 2
        for i in range(half, size, step):
            pts[i] = (pts[i - half] + pts[i + half]) / 2 + r.uniform(-amp, amp)
        amp *= rough
        step = half
    h = pts[:n]
    for (px, height, width) in peaks:  # sculpt recognisable summits
        xs = np.arange(n) / n
        h = h + height * np.exp(-((xs - px) ** 2) / (2 * width**2))
    h = (h - h.min()) / (h.max() - h.min() + 1e-9)
    return y_hi + (1 - h) * (y_lo - y_hi)  # high value → small y


def paint_range(arr, top, base_y, lit_col, mid_col, dark_col, snow_line=None, seed=1):
    """Shade a mountain range into arr (H×W×4 float) below the ridge `top`."""
    ys = np.arange(H)[:, None]
    mask = (ys >= top[None, :]) & (ys < base_y)
    slope = np.gradient(top)  # dy/dx: negative → faces left (lit)
    face = np.clip(-slope * 0.9, -1, 1)[None, :]
    depth = np.clip((ys - top[None, :]) / 140.0, 0, 1)
    streaks = periodic_value_noise(W, H, 60, 8, seed) * 0.5 + periodic_value_noise(W, H, 140, 20, seed + 1) * 0.3
    light = np.clip(0.5 + face * 0.55 * (1 - depth * 0.6) + (streaks - 0.4) * 0.5 - depth * 0.25, 0, 1)
    lit = np.array(lit_col, float)
    mid = np.array(mid_col, float)
    dark = np.array(dark_col, float)
    col = np.where(
        light[..., None] > 0.5,
        mid + (lit - mid) * ((light[..., None] - 0.5) * 2),
        dark + (mid - dark) * (light[..., None] * 2),
    )
    if snow_line is not None:
        snow_depth = 26 + periodic_value_noise(W, H, 40, 6, seed + 5)[0][None, :] * 46
        snowy = (ys < np.minimum(top[None, :] + snow_depth, snow_line + streaks * 30)) & mask
        snow_lit = np.array(hex_rgb("#f7f9fc"), float)
        snow_sh = np.array(hex_rgb("#b7c6dc"), float)
        scol = snow_sh + (snow_lit - snow_sh) * np.clip(0.35 + face * 0.8 + (streaks - 0.4) * 0.6, 0, 1)[..., None]
        col = np.where(snowy[..., None], scol, col)
    m = mask[..., None]
    arr[..., :3] = np.where(m, col, arr[..., :3])
    arr[..., 3] = np.where(mask, 255, arr[..., 3])


def larch(d, x, ybase, h, haze=0.0, haze_col=(160, 200, 230)):
    """Golden autumn larch: a cone of leaf dabs on a thin trunk."""
    w = h * rng.uniform(0.32, 0.42)
    d.line((x, ybase, x, ybase - h), fill=(50, 28, 18, 255), width=max(1, int(h / 18)))
    layers = max(4, int(h / 3.2))
    dabs = []
    for i in range(layers):
        t = i / layers
        yy = ybase - h * 0.12 - (h * 0.88) * t
        half = w * (1 - t) * 0.5 + 1
        for _ in range(int(2 + half / 1.6)):
            xx = x + rng.uniform(-half, half)
            light = 0.55 - (xx - x) / (half + 1) * 0.3 + t * 0.25 + rng.uniform(-0.15, 0.15)
            dabs.append((light, xx, yy + rng.uniform(-1.5, 1.5), rng.uniform(1.6, 2.8)))
    dabs.sort(key=lambda a: a[0])
    for light, xx, yy, r in dabs:
        col = autumn_color(max(0, min(1, light)))
        if haze:
            col = mix(col, haze_col, haze)
        d.ellipse((xx - r, yy - r, xx + r, yy + r), fill=col + (255,))


def round_tree(d, x, ybase, h, haze=0.0, haze_col=(160, 200, 230)):
    d.line((x, ybase, x, ybase - h * 0.5), fill=(50, 28, 18, 255), width=max(1, int(h / 12)))
    canopy(d, x, ybase - h * 0.62, h * 0.36, h * 0.34, int(30 + h * 3), 1.5, max(2.2, h / 14), haze=haze, haze_col=haze_col)


def pine(d, x, ybase, h, haze=0.0, haze_col=(160, 200, 230)):
    """Dark evergreen spire — a few of them make the forest read as real."""
    w = h * 0.3
    tiers = max(3, int(h / 6))
    for i in range(tiers):
        t = i / tiers
        top = ybase - h * (0.15 + 0.85 * (i + 1) / tiers)
        bot = ybase - h * (0.1 + 0.85 * i / tiers)
        half = w * (1 - t) * 0.5 + 1
        col = mix(hex_rgb("#1f3a2c") if rng.random() < 0.7 else hex_rgb("#2c4a33"), haze_col, haze)
        d.polygon([(x - half, bot), (x + half, bot), (x, top)], fill=col + (255,))
        lit = mix(hex_rgb("#3d6047"), haze_col, haze)
        d.polygon([(x - half, bot), (x - half * 0.2, bot), (x, top)], fill=lit + (255,))


def forest_band(d, y_of_x, depth, count, scale, haze, seed):
    """Fill a hillside with individual trees, painted back → front."""
    r = random.Random(seed)
    trees = []
    for _ in range(count):
        x = r.uniform(-10, W + 10)
        yb = y_of_x(x) + r.uniform(0, depth)
        k = r.random()
        h = scale * (0.7 + (yb - y_of_x(x)) / max(depth, 1) * 0.6) * r.uniform(0.8, 1.25)
        trees.append((yb, x, h, k))
    trees.sort()
    for yb, x, h, k in trees:
        if k < 0.42:
            larch(d, x, yb, h, haze=haze)
        elif k < 0.58:
            pine(d, x, yb, h * 0.9, haze=haze)
        else:
            round_tree(d, x, yb, h * 0.9, haze=haze)


def branch(d, x, y, ang, length, width, depth, tips):
    x2 = x + math.cos(ang) * length
    y2 = y + math.sin(ang) * length
    d.line((x, y, x2, y2), fill=(48, 26, 16, 255), width=max(1, int(width)))
    if depth == 0:
        tips.append((x2, y2))
        return
    for _ in range(rng.choice((2, 2, 3))):
        branch(d, x2, y2, ang + rng.uniform(-0.62, 0.62), length * rng.uniform(0.66, 0.8), width * 0.66, depth - 1, tips)


def hero_tree(d, x, ybase, h):
    """Big framing tree: tapered trunk, visible branches, clumped crown."""
    tw = h * 0.042
    d.polygon([(x - tw, ybase), (x + tw, ybase), (x + tw * 0.45, ybase - h * 0.5), (x - tw * 0.4, ybase - h * 0.5)], fill=(52, 28, 16, 255))
    d.polygon([(x - tw, ybase), (x - tw * 0.2, ybase), (x - tw * 0.1, ybase - h * 0.5), (x - tw * 0.4, ybase - h * 0.5)], fill=(96, 58, 32, 255))
    tips: list[tuple[float, float]] = []
    for ang in (-2.05, -1.7, -1.35, -1.0, -0.65):
        branch(d, x, ybase - h * 0.46, ang + rng.uniform(-0.08, 0.08), h * 0.15, tw * 0.75, 4, tips)
    # Shaded inner crown first, so the tree reads as one lush mass.
    xs_ = [t[0] for t in tips]
    ys_ = [t[1] for t in tips]
    cx_, cy_ = (min(xs_) + max(xs_)) / 2, (min(ys_) + max(ys_)) / 2 + 20
    canopy(d, cx_, cy_, (max(xs_) - min(xs_)) / 2 * 0.85, (max(ys_) - min(ys_)) / 2 * 0.8, 1400, 3, 6)
    clumps = []
    for tx, ty in tips:
        light = 0.62 - (ty - (ybase - h)) / h * 0.5 + rng.uniform(-0.1, 0.1)
        clumps.append((light, tx, ty))
    clumps.sort()
    for light, tx, ty in clumps:
        r = rng.uniform(18, 28)
        # a clump: dark core then lit dabs, leaving gaps where branches show
        leaves = []
        for _ in range(60):
            a = rng.random() * 2 * math.pi
            dd = math.sqrt(rng.random())
            lx = tx + math.cos(a) * r * dd
            ly = ty + math.sin(a) * r * dd * 0.85
            local = light - ((ly - ty) / r) * 0.42 - ((lx - tx) / r) * 0.14 + rng.uniform(-0.12, 0.12)
            leaves.append((max(0, min(1, local)), lx, ly, rng.uniform(3, 5.5)))
        leaves.sort()
        for l, lx, ly, lr in leaves:
            col = autumn_color(l)
            d.ellipse((lx - lr, ly - lr, lx + lr, ly + lr), fill=col + (255,))


def birch(d, x, ybase, h):
    tw = max(3, h * 0.035)
    d.polygon([(x - tw, ybase), (x + tw, ybase), (x + tw * 0.5, ybase - h * 0.8), (x - tw * 0.5, ybase - h * 0.8)], fill=(236, 230, 216, 255))
    for i in range(10):  # birch bark marks
        yy = ybase - rng.uniform(0.05, 0.75) * h
        d.line((x - tw * 0.8, yy, x + tw * rng.uniform(-0.2, 0.6), yy + rng.uniform(-1, 1)), fill=(40, 34, 30, 255), width=2)
    tips: list[tuple[float, float]] = []
    for ang in (-1.9, -1.45, -1.05):
        branch(d, x, ybase - h * 0.6, ang, h * 0.16, tw * 0.6, 2, tips)
    for tx, ty in sorted(tips, key=lambda t: -t[1]):
        canopy(d, tx, ty, rng.uniform(16, 24), rng.uniform(14, 20), 120, 2.5, 4.2)


def path(img):
    """Winding dirt path through the meadow towards Claaky."""
    d = ImageDraw.Draw(img)
    pts_l, pts_r = [], []
    for i in range(40):
        t = i / 39
        cx = X(0.36) + (X(0.55) - X(0.36)) * (t**1.3) + math.sin(t * 3.4) * X(0.05)
        y = Y(1.02) - (Y(1.02) - Y(0.80)) * t
        half = X(0.11) * (1 - t) + X(0.025)
        pts_l.append((cx - half, y))
        pts_r.append((cx + half, y))
    d.polygon(pts_l + pts_r[::-1], fill=hex_rgb("#dcb07a") + (255,))
    for _ in range(900):  # pebbles & ruts
        t = rng.random()
        cx = X(0.36) + (X(0.55) - X(0.36)) * (t**1.3) + math.sin(t * 3.4) * X(0.05)
        y = Y(1.02) - (Y(1.02) - Y(0.80)) * t
        half = X(0.11) * (1 - t) + X(0.025)
        px = cx + rng.uniform(-half, half) * 0.9
        r = rng.uniform(1.2, 2.6) * (1.2 - t)
        col = rng.choice([hex_rgb("#f0cd98"), hex_rgb("#b98549"), hex_rgb("#9c6a3a"), hex_rgb("#e6bd84")])
        d.ellipse((px - r, y - r, px + r, y + r), fill=col + (255,))


def paint_back(sky_img: Image.Image):
    arr = np.zeros((H, W, 4), float)
    lake_top = int(Y(0.535))

    # Far range: hazy blue with snowy summits (recognisable silhouette).
    far = ridge(W, Y(0.40), Y(0.24), 0.55, 21, peaks=((0.30, 1.1, 0.07), (0.62, 1.5, 0.06), (0.86, 0.8, 0.05)))
    paint_range(arr, far, lake_top, hex_rgb("#c3cfe6"), hex_rgb("#93a5c9"), hex_rgb("#61709a"), snow_line=Y(0.37), seed=4)
    # Near range: darker, its lower slopes will be covered by forest.
    near = ridge(W, Y(0.47), Y(0.38), 0.6, 33, peaks=((0.12, 0.6, 0.09), (0.9, 0.7, 0.08)))
    paint_range(arr, near, lake_top, hex_rgb("#8a8fa6"), hex_rgb("#5e6582"), hex_rgb("#383d55"), seed=8)
    img = Image.fromarray(arr.astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(img)

    # Forested hills down to the lake shore: far (hazy) then near.
    hill_far = lambda x: near[int(min(W - 1, max(0, x)))] + 18
    forest_band(d, hill_far, lake_top - hill_far(W / 2) - 10, 520, 18, 0.22, 5)
    hill_near = lambda x: Y(0.47) + math.sin(x / W * math.pi * 2.2 + 1) * 10
    forest_band(d, hill_near, Y(0.535) - Y(0.47), 420, 26, 0.08, 6)

    # Lake: mirrored scene (incl. sky) with ripples and a cool tint.
    full = sky_img.crop((0, 0, W, H)).convert("RGBA")
    full.alpha_composite(img)
    src = np.array(full, float)
    out = np.array(img, float)
    shore = lambda x: Y(0.655) + math.sin(x / W * 5.0) * Y(0.016) + (x / W) * Y(0.02)
    water = np.zeros((H, W), np.uint8)
    tint = np.array(hex_rgb("#2a6fa8"), float)
    for y in range(lake_top, int(Y(0.71))):
        ry = 2 * lake_top - y - 2
        if ry < 0:
            continue
        depth = (y - lake_top) / (Y(0.16))
        shift = int(round(math.sin(y * 0.9) * (1 + depth * 3)))
        row = np.roll(src[ry, :, :3], shift, axis=0)
        row = row * (0.70 - depth * 0.12) + tint * (0.34 + depth * 0.15)
        if (y - lake_top) % 7 == 0:  # ripple highlights
            row = row * 0.85 + 255 * 0.15 * (np.random.default_rng(y).random(W)[:, None] > 0.6)
        xs = np.arange(W)
        inside = y < np.array([shore(x) for x in xs])
        out[y, inside, :3] = row[inside]
        out[y, inside, 3] = 255
        water[y, inside] = 255
    img = Image.fromarray(out.astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(img)

    # Meadow from the shore down.
    meadow_poly = [(0, shore(0) - 2)] + [(x, shore(x) - 2) for x in range(0, W + 1, 8)] + [(W, H), (0, H)]
    d.polygon(meadow_poly, fill=hex_rgb("#c27424") + (255,))
    # Reeds / bank along the shore.
    for x in range(0, W, 3):
        sy = shore(x)
        hgt = rng.uniform(4, 12)
        d.line((x, sy + 2, x + rng.uniform(-2, 2), sy - hgt), fill=autumn_color(rng.uniform(0.2, 0.8)) + (255,), width=2)
    meadow(d, Y(0.67), Y(1.0), 3400)
    path(img)
    d = ImageDraw.Draw(img)

    # Shore rocks.
    img = rock(img, X(0.27), Y(0.69), X(0.085), Y(0.04), 3)
    img = rock(img, X(0.74), Y(0.685), X(0.05), Y(0.024), 12, tone="#9aa6b8")
    d = ImageDraw.Draw(img)

    # Framing trees.
    hero_tree(d, X(0.07), Y(1.02), Y(0.92))
    birch(d, X(0.92), Y(0.86), Y(0.46))
    canopy(d, X(0.96), Y(0.86), X(0.14), Y(0.08), 900, 3, 7)  # bush at the birch foot
    img = rock(img, X(0.17), Y(0.95), X(0.09), Y(0.045), 9, tone="#8a95a8")
    d = ImageDraw.Draw(img)

    # Claaky's shadows: soft cast shadow (sun from the upper left) + contact.
    fx, fy = CLAAKY_FEET
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.polygon([(fx - X(0.05), fy - Y(0.004)), (fx + X(0.05), fy - Y(0.012)),
                (fx + X(0.20), fy + Y(0.004)), (fx + X(0.16), fy + Y(0.022)),
                (fx - X(0.04), fy + Y(0.014))], fill=(52, 18, 4, 150))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(9)))
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((fx - X(0.075), fy - Y(0.008), fx + X(0.075), fy + Y(0.012)), fill=(36, 12, 2, 170))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(4)))
    return img, Image.fromarray(water, "L")


def paint_front():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fx, fy = CLAAKY_FEET
    for _ in range(420):  # tufts hiding Claaky's feet in the grass
        x = fx + rng.gauss(0, X(0.06))
        y = fy + rng.uniform(-Y(0.004), Y(0.02))
        h = rng.uniform(7, 18)
        d.line((x, y, x + rng.uniform(-4, 4), y - h), fill=autumn_color(rng.uniform(0.25, 0.9)) + (255,), width=2)
    return img


def claaky_sprite() -> Image.Image:
    """Claaky relit for the scene: warm key light from the upper left,
    shade on the right, orange bounce from the meadow, warm rim, feet AO."""
    sprite = Image.open(os.path.join(HERE, "claaky-idle.png")).convert("RGBA")
    sprite = sprite.crop(sprite.split()[-1].getbbox())
    sprite = sprite.resize((round(sprite.width * CLAAKY_H / sprite.height), int(CLAAKY_H)), Image.LANCZOS)
    arr = np.array(sprite, float)
    h, w = arr.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    nx = (xs / max(w - 1, 1)) * 2 - 1
    ny = ys / max(h - 1, 1)
    rgb = arr[..., :3]
    key = np.clip(1.04 - 0.16 * nx - 0.08 * ny, 0.74, 1.06)[..., None]
    sun = np.array([255, 243, 224], float) / 255
    rgb = rgb * key * sun
    bounce = (smoothstep(0.6, 1.0, ny) * 0.13)[..., None]
    rgb = rgb * (1 - bounce) + np.array(hex_rgb("#e07a2c"), float) * bounce
    alpha = arr[..., 3] / 255
    eroded = ndimage.grey_erosion(alpha, size=(7, 7))
    rim = np.clip(alpha - eroded, 0, 1) * np.clip(-nx + 0.2, 0, 1) * (1 - ny * 0.6)
    rgb = rgb + rim[..., None] * np.array([90, 60, 20], float)
    ao = (1 - smoothstep(0.9, 1.0, ny) * 0.35)[..., None]
    rgb = rgb * ao
    rgb = rgb * 0.96 + np.array(hex_rgb("#c27424"), float) * 0.04  # share the scene's air
    arr[..., :3] = np.clip(rgb, 0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def bake_claaky_frames(back_hi: Image.Image, sky: Image.Image):
    """Claaky composited into the hi-res scene *before* the mosaic, so his
    edges blend with the meadow cells. Frame 1 is one cell higher (bob).
    Each frame keeps only the cells around Claaky (alpha elsewhere = 0)."""
    sprite = claaky_sprite()
    fx, fy = CLAAKY_FEET
    x0 = int(fx - sprite.width / 2)
    y0 = int(fy - sprite.height)
    scene = sky.crop((0, 0, W, H)).convert("RGBA")
    scene.alpha_composite(back_hi)
    union = np.zeros((H, W), float)
    frames = []
    for lift in (0, SCALE):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        layer.alpha_composite(sprite, (x0, y0 - lift))
        union = np.maximum(union, np.array(layer.split()[-1], float))
        comp = scene.copy()
        comp.alpha_composite(layer)
        frames.append(comp)
    mask = Image.fromarray(union.astype(np.uint8), "L").resize((CELLS_W, CELLS_H), Image.BOX)
    m = ndimage.binary_dilation(np.array(mask) > 8, iterations=1)
    out = []
    for comp in frames:
        cells = np.array(to_cells(comp, CELLS_W, CELLS_H, levels=9).convert("RGBA"))
        cells[..., 3] = np.where(m, 255, 0)
        out.append(Image.fromarray(cells, "RGBA"))
    return out


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
        return Image.fromarray(np.dstack([rgb, a]).astype(np.uint8), "RGBA")
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    sky = paint_sky()
    back, water = paint_back(sky)
    to_cells(sky, CELLS_W * 2, CELLS_H, levels=12).save(os.path.join(OUT, "sky.png"), optimize=True)
    to_cells(back, CELLS_W, CELLS_H, levels=9).save(os.path.join(OUT, "back.png"), optimize=True)
    water.resize((CELLS_W, CELLS_H), Image.BOX).point(lambda v: 255 if v > 140 else 0).save(
        os.path.join(OUT, "water.png"), optimize=True
    )
    for i, frame in enumerate(bake_claaky_frames(back, sky)):
        frame.save(os.path.join(OUT, f"claaky{i}.png"), optimize=True)
    to_cells(paint_front(), CELLS_W, CELLS_H, levels=9).save(os.path.join(OUT, "front.png"), optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
