#!/usr/bin/env python3
"""Generate the Welcome screen pixel-mosaic art: a scene composed around Claaky.

The scene is painted procedurally at high resolution, downsampled to a coarse
grid (one pixel = one mosaic cell) and ordered-dithered, which gives the
"LED screen / 3D render seen through a grid" look. It is split in layers so
the Welcome canvas (src/components/WelcomeArt.tsx) can animate them:

  sky.png       2× wide, horizontally tileable → clouds drift
  back.png      boulder, autumn bushes, golden spikes, leaf floor, shadows
  sparkle.png   golden flower cells (mask)     → twinkle
  claaky0/1.png Claaky relit and baked into the scene before the mosaic
                (edges blended), resting / one cell up → gentle bob
  front.png     leaves, flowers and bushes in front of Claaky

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

# Claaky is the subject: big, right of centre, standing in the leaves.
CLAAKY_FEET = (CELLS_W * SCALE * 0.60, CELLS_H * SCALE * 0.885)
CLAAKY_H = CELLS_H * SCALE * 0.37

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
# Vivid, high-contrast palette (same punch as the reference render).
SKY_TOP = np.array(hex_rgb("#1286e6"), float)
SKY_MID = np.array(hex_rgb("#2eaef7"), float)
SKY_LOW = np.array(hex_rgb("#8fd9ff"), float)

AUTUMN_DEEP = [hex_rgb(c) for c in ("#3f0b02", "#5a1203", "#6e1904", "#4a1405")]
AUTUMN_MID = [hex_rgb(c) for c in ("#b8260a", "#d23a0b", "#e2500e", "#c41d0a", "#d94a12")]
AUTUMN_HI = [hex_rgb(c) for c in ("#ff7410", "#ff8a14", "#ff9e1c", "#ff6614", "#ffad24")]
AUTUMN_SPARK = [hex_rgb(c) for c in ("#ffc414", "#ffd632", "#ffe45c")]
GOLD = [hex_rgb(c) for c in ("#ffd21a", "#ffe23c", "#ffc80f", "#fff07a")]


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



def branch(d, x, y, ang, length, width, depth, tips):
    x2 = x + math.cos(ang) * length
    y2 = y + math.sin(ang) * length
    d.line((x, y, x2, y2), fill=(48, 26, 16, 255), width=max(1, int(width)))
    if depth == 0:
        tips.append((x2, y2))
        return
    for _ in range(rng.choice((2, 2, 3))):
        branch(d, x2, y2, ang + rng.uniform(-0.62, 0.62), length * rng.uniform(0.66, 0.8), width * 0.66, depth - 1, tips)




# ---------------------------------------------------------------- scene
def X(f: float) -> float:
    return f * W


def Y(f: float) -> float:
    return f * H


def paint_sky():
    """Vivid sky, horizontally tileable (2× wide) with two big cumulus
    masses so one always sits behind the upper right of the frame."""
    sw = W * 2
    y = np.linspace(0, 1, H)[:, None, None]
    grad = np.where(
        y < 0.35,
        SKY_TOP + (SKY_MID - SKY_TOP) * (y / 0.35),
        SKY_MID + (SKY_LOW - SKY_MID) * np.clip((y - 0.35) / 0.35, 0, 1),
    )
    sky = np.repeat(grad, sw, axis=1)
    xx = np.linspace(0, 1, sw, endpoint=False)[None, :]
    yy = np.linspace(0, 1, H)[:, None]
    # Cumulus masses centred at x≈0.37 and 0.87 of the 2× strip (= upper right of the frame).
    mass = np.zeros((H, sw))
    # Cumulus = a few rounded towers on a flat base (offsets in 2×-strip units).
    lobes = ((0.0, 0.0, 0.085, 0.13), (-0.06, 0.05, 0.06, 0.09), (0.07, 0.03, 0.065, 0.1),
             (0.02, -0.09, 0.05, 0.08), (-0.035, -0.05, 0.045, 0.07), (0.11, 0.08, 0.05, 0.07),
             (0.05, -0.04, 0.04, 0.06))
    for cx in (0.37, 0.87):
        for ox, oy, sx, sy in lobes:
            dx = np.minimum(np.abs(xx - cx - ox), 1 - np.abs(xx - cx - ox)) / sx
            dy = (yy - 0.27 - oy) / sy
            mass = np.maximum(mass, np.exp(-(dx**2 + dy**2) * 1.2))
    mass = mass * (1 - smoothstep(0.36, 0.42, yy))  # flat-ish base
    wisps = np.exp(-(((yy - 0.12) / 0.07) ** 2)) * 0.45
    dens = fbm(sw, H, 8, 8, 5, 11)
    bumps = fbm(sw, H, 28, 26, 3, 23)
    c = mass * (0.45 + 0.6 * dens + 0.35 * bumps) + wisps * dens - 0.22
    alpha = smoothstep(0.32, 0.35, c)
    shifted = np.roll(np.roll(c, 10, axis=0), -8, axis=1)  # sun from upper left
    lit = np.clip((c - shifted) * 9 + 0.6 + (bumps - 0.5) * 0.5, 0, 1)
    white = np.array([255, 255, 255], float)
    mid = np.array(hex_rgb("#e6f1fb"), float)
    shadow = np.array(hex_rgb("#93aed0"), float)
    cloud = np.where(
        lit[..., None] > 0.5,
        mid + (white - mid) * ((lit[..., None] - 0.5) * 2),
        shadow + (mid - shadow) * (lit[..., None] * 2),
    )
    out = sky * (1 - alpha[..., None]) + cloud * alpha[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def goldenrod(d, x, ybase, h, lean, sparkle):
    """Golden flower plume (feathery spray, like the yellow flowers in the reference)."""
    d.line([(x + lean * (i / 10) ** 2, ybase - h * i / 10) for i in range(11)], fill=(110, 60, 12, 255), width=2)
    for _ in range(int(h * 1.6)):
        t = 0.3 + 0.7 * rng.random() ** 0.8
        spread = 11 * (1 - t) + 4
        px = x + lean * t * t + rng.gauss(0, spread * 0.5)
        py = ybase - h * t + rng.uniform(-4, 4)
        r = rng.uniform(1.8, 3.2)
        light = 0.5 - (px - x) / 30 + rng.uniform(-0.25, 0.35)
        col = rng.choice(GOLD) if light > 0.4 else rng.choice(AUTUMN_HI + AUTUMN_SPARK)
        d.ellipse((px - r, py - r, px + r, py + r), fill=col + (255,))
        if rng.random() < 0.2:
            sparkle.append((px, py))


def leaf_litter(d, x0, x1, y0, y1, n):
    for _ in range(n):
        x = rng.uniform(x0, x1)
        y = rng.uniform(y0, y1)
        depth = (y - y0) / max(1, (y1 - y0))
        r = rng.uniform(2, 4.5) * (0.7 + depth * 0.6)
        col = autumn_color(rng.uniform(0.15, 1.0))
        d.ellipse((x - r * 1.3, y - r * 0.7, x + r * 1.3, y + r * 0.7), fill=col + (255,))


def paint_back():
    """Everything behind Claaky, composed around him (he stands at CLAAKY_FEET)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sparkle: list[tuple[float, float]] = []

    # Far hedge line, low on the horizon, so the sky dominates the top half.
    for i in range(30):
        cx = -20 + i * 26 + rng.uniform(-8, 8)
        canopy(d, cx, Y(0.60) + rng.uniform(-14, 14), rng.uniform(34, 52), rng.uniform(26, 40), 260, 3, 6,
               haze=0.18, haze_col=(255, 200, 150))
    # Deep red crown behind Claaky's right shoulder (the dark bush of the reference).
    canopy(d, X(0.96), Y(0.56), X(0.21), Y(0.13), 2200, 4, 8)
    # Ground: warm leaf-strewn floor.
    d.rectangle((0, Y(0.61), W, H), fill=hex_rgb("#8a2a06") + (255,))
    canopy(d, X(0.72), Y(0.64), X(0.16), Y(0.07), 1200, 3, 7)  # low bushes behind Claaky
    leaf_litter(d, -10, W + 10, Y(0.66), H, 5200)

    # Big blue boulder behind Claaky (left), lit from the upper left.
    img = rock(img, X(0.30), Y(0.68), X(0.20), Y(0.15), 3, tone="#7d97c4")
    img = rock(img, X(0.08), Y(0.80), X(0.12), Y(0.07), 7, tone="#8aa0c8")
    d = ImageDraw.Draw(img)

    # Golden flowering bush on the left with spikes rising into the sky.
    canopy(d, X(0.02), Y(0.66), X(0.20), Y(0.22), 2600, 4, 9)
    for _ in range(9):
        goldenrod(d, rng.uniform(X(0.0), X(0.22)), Y(0.56) + rng.uniform(0, 30),
                  rng.uniform(Y(0.12), Y(0.22)), rng.uniform(-6, 30), sparkle)
    # A couple of spikes on the right, behind Claaky.
    for _ in range(4):
        goldenrod(d, rng.uniform(X(0.86), X(1.0)), Y(0.62), rng.uniform(Y(0.1), Y(0.16)), rng.uniform(-20, 4), sparkle)

    # Claaky's shadows on the ground: contact + soft cast to the right.
    fx, fy = CLAAKY_FEET
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.polygon([(fx - X(0.08), fy - Y(0.006)), (fx + X(0.10), fy - Y(0.018)),
                (fx + X(0.30), fy + Y(0.004)), (fx + X(0.24), fy + Y(0.03)),
                (fx - X(0.06), fy + Y(0.02))], fill=(40, 8, 0, 150))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10)))
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((fx - X(0.13), fy - Y(0.012), fx + X(0.13), fy + Y(0.016)), fill=(30, 6, 0, 190))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))

    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    for px, py in sparkle:
        md.ellipse((px - 2, py - 2, px + 2, py + 2), fill=255)
    return img, mask


def paint_front():
    """Foreground in front of Claaky: bushes framing the bottom corners,
    leaves and flowers hiding his feet, a spike crossing in front."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fx, fy = CLAAKY_FEET
    # Low bushes at the bottom corners.
    canopy(d, X(0.05), Y(1.0), X(0.2), Y(0.1), 1400, 4, 9)
    canopy(d, X(1.0), Y(0.98), X(0.18), Y(0.1), 1200, 4, 9)
    # Leaf mound around Claaky's feet.
    for _ in range(1300):
        x = fx + rng.gauss(0, X(0.11))
        y = fy + rng.uniform(-Y(0.035), Y(0.05)) * (1 if abs(x - fx) < X(0.1) else 0.6)
        r = rng.uniform(2.2, 4.6)
        col = autumn_color(rng.uniform(0.2, 1.0))
        d.ellipse((x - r * 1.3, y - r * 0.75, x + r * 1.3, y + r * 0.75), fill=col + (255,))
    # Small rocks at the bottom.
    img = rock(img, X(0.62), Y(0.975), X(0.09), Y(0.035), 12, tone="#8aa0c8")
    img = rock(img, X(0.30), Y(0.99), X(0.07), Y(0.03), 14, tone="#7d97c4")
    d = ImageDraw.Draw(img)
    # Low golden flower clusters in front of Claaky's feet.
    for cx, cy in ((fx - X(0.17), fy + Y(0.035)), (fx + X(0.19), fy + Y(0.03)), (fx + X(0.02), fy + Y(0.07))):
        for _ in range(160):
            px = cx + rng.gauss(0, X(0.035))
            py = cy + rng.gauss(0, Y(0.012))
            r = rng.uniform(1.8, 3.2)
            d.ellipse((px - r, py - r, px + r, py + r), fill=rng.choice(GOLD + AUTUMN_SPARK) + (255,))
    return img


def claaky_sprite() -> Image.Image:
    """Claaky lit by the same sun as the scene, kept vivid: warm key from the
    upper left, cool sky fill on top, orange bounce from the leaves below,
    rounded volume, and two fallen leaves resting on him."""
    sprite = Image.open(os.path.join(HERE, "claaky-idle.png")).convert("RGBA")
    sprite = sprite.crop(sprite.split()[-1].getbbox())
    sprite = sprite.resize((round(sprite.width * CLAAKY_H / sprite.height), int(CLAAKY_H)), Image.LANCZOS)
    arr = np.array(sprite, float)
    h, w = arr.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    nx = (xs / max(w - 1, 1)) * 2 - 1
    ny = ys / max(h - 1, 1)
    rgb = arr[..., :3]
    # Saturate a touch so he matches the scene's punch.
    lum = rgb.mean(axis=2, keepdims=True)
    rgb = lum + (rgb - lum) * 1.25
    key = np.clip(1.06 - 0.22 * nx - 0.06 * ny, 0.76, 1.1)[..., None]
    rgb = rgb * key * (np.array([255, 246, 228], float) / 255)
    sky_fill = (np.clip(0.35 - ny, 0, 0.35) / 0.35 * 0.10)[..., None]
    rgb = rgb * (1 - sky_fill) + np.array(hex_rgb("#bfe6ff"), float) * sky_fill
    bounce = (smoothstep(0.55, 1.0, ny) * 0.22)[..., None]
    rgb = rgb * (1 - bounce) + np.array(hex_rgb("#ff7a1a"), float) * bounce
    alpha = arr[..., 3] / 255
    dist = ndimage.distance_transform_edt(alpha > 0.5)
    roundness = np.clip(dist / (0.15 * w), 0, 1)
    rgb = rgb * (0.82 + 0.18 * np.sqrt(roundness))[..., None]
    eroded = ndimage.grey_erosion(alpha, size=(7, 7))
    rim = np.clip(alpha - eroded, 0, 1) * np.clip(-nx + 0.1, 0, 1) * (1 - ny * 0.5)
    rgb = rgb + rim[..., None] * np.array([70, 50, 10], float)
    arr[..., :3] = np.clip(rgb, 0, 255)
    sprite = Image.fromarray(arr.astype(np.uint8), "RGBA")
    # Fallen leaves resting on his left ear and his shoulder.
    d = ImageDraw.Draw(sprite)
    for (lx, ly, rot, col) in ((0.2, 0.17, 0.5, "#ff7a10"), (0.78, 0.66, -0.4, "#e2400c")):
        cx, cy = lx * w, ly * h
        rr = w * 0.045
        pts = []
        for k in range(16):
            t = k / 16 * 2 * math.pi
            px = math.cos(t) * rr * 1.5
            py = math.sin(t) * rr * 0.75
            pts.append((cx + px * math.cos(rot) - py * math.sin(rot), cy + px * math.sin(rot) + py * math.cos(rot)))
        d.polygon(pts, fill=hex_rgb(col) + (255,))
        d.line((cx - rr * 1.4 * math.cos(rot), cy - rr * 1.4 * math.sin(rot),
                cx + rr * 1.4 * math.cos(rot), cy + rr * 1.4 * math.sin(rot)), fill=(120, 30, 4, 255), width=2)
    return sprite


def bake_claaky_frames(back_hi: Image.Image, sky: Image.Image):
    """Claaky composited into the hi-res scene *before* the mosaic, so his
    edges blend with what's behind him. Frame 1 is one cell higher (bob).
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
        cells[..., :3] = np.where(m[..., None], cells[..., :3], 0)
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
    back, sparkle = paint_back()
    to_cells(sky, CELLS_W * 2, CELLS_H, levels=12).save(os.path.join(OUT, "sky.png"), optimize=True)
    to_cells(back, CELLS_W, CELLS_H, levels=9).save(os.path.join(OUT, "back.png"), optimize=True)
    sparkle.resize((CELLS_W, CELLS_H), Image.BOX).point(lambda v: 255 if v > 60 else 0).save(
        os.path.join(OUT, "sparkle.png"), optimize=True
    )
    for i, frame in enumerate(bake_claaky_frames(back, sky)):
        frame.save(os.path.join(OUT, f"claaky{i}.png"), optimize=True)
    to_cells(paint_front(), CELLS_W, CELLS_H, levels=9).save(os.path.join(OUT, "front.png"), optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
