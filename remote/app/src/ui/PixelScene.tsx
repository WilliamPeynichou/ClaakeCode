import { useEffect, useRef } from "react";

// The desktop Welcome art (src/assets/welcome), copied to public/art.
const ART = ["sky", "back", "claaky0", "claaky1", "front", "sparkle"].map((name) => `/art/${name}.png`);

/**
 * PixelScene — the desktop WelcomeArt ported to the phone, plus an exit
 * dissolve and an "excited" Claaky. Original notes: the pixel-mosaic panel: a vivid autumn
 * scene composed around Claaky (boulder, golden sprays, red bushes, cumulus),
 * drawn like an LED screen (one art pixel = one cell, with a
 * thin light grid between cells).
 *
 * Art layers are 144×180 PNGs baked by scripts/welcome-art/generate_welcome_art.py.
 * Each frame is composed on a tiny offscreen canvas (one pixel per cell), then
 * scaled up with nearest-neighbour and covered by a grid pattern. That's two
 * draw calls per frame, so the motion stays cheap:
 *   - dithered reveal when the screen opens (Bayer order, top → bottom)
 *   - clouds drifting one cell at a time
 *   - Claaky bobbing by one cell (two frames baked into the scene, so his
 *     edges, lighting and shadow already blend with the meadow)
 *   - golden flowers twinkling (sparkle.png mask)
 *   - autumn leaves falling across the scene (click = gust of leaves)
 * Everything stops on the first full frame under prefers-reduced-motion.
 */

const CW = 144;
const CH = 180;
const GLINT_MS = 420;
const FPS = 24;
const REVEAL_MS = 1100;
const EXIT_MS = 620;
const EXCITED_MS = 760;
/** Top centre of Claaky's head, in art cells. */
const CLAAKY_HEAD = { x: 86, y: 88 };

export type SceneAnchor = { x: number; y: number };

const LEAF_COLORS: Array<[number, number, number]> = [
  [255, 181, 46],
  [244, 134, 31],
  [224, 82, 26],
  [255, 210, 74],
  [178, 60, 16],
];

type Leaf = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  color: [number, number, number];
  life: number; // gust leaves fade out; ambient leaves are Infinity
};

function bayer8(): Float32Array {
  // Recursive Bayer matrix, normalised to [0, 1).
  let m = [[0]];
  while (m.length < 8) {
    const n = m.length;
    const next: number[][] = Array.from({ length: n * 2 }, () => new Array(n * 2).fill(0));
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
  }
  const out = new Float32Array(64);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) out[y * 8 + x] = m[y][x] / 64;
  return out;
}

function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0);
      resolve({ data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function ambientLeaf(random = Math.random, scatter = false): Leaf {
  return {
    x: random() * (CW + 40) - 20,
    y: scatter ? random() * CH : -2 - random() * 30,
    vx: 2 + random() * 3, // cells / second (wind from the left)
    vy: 4 + random() * 5,
    phase: random() * Math.PI * 2,
    color: LEAF_COLORS[Math.floor(random() * LEAF_COLORS.length)],
    life: Infinity,
  };
}

export function PixelScene({ leaving, excited, headroom, onAnchor, children }: {
  /** Dissolves the scene, bottom to top. */
  leaving: boolean;
  /** Bump to make Claaky bounce and throw leaves. */
  excited: number;
  /** Space to keep above Claaky's head, in CSS pixels: on short screens the meadow slides down (up to 20 rows). */
  headroom: number;
  /** Where Claaky's head is, in CSS pixels from the scene's top-left corner. */
  onAnchor(anchor: SceneAnchor): void;
  children?: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ leaving, excited, headroom, onAnchor, exitAt: -1, excitedAt: -1, burst: null as null | (() => void) });
  live.current.onAnchor = onAnchor;
  live.current.headroom = headroom;
  useEffect(() => {
    const l = live.current;
    if (leaving && !l.leaving) l.exitAt = performance.now();
    l.leaving = leaving;
  }, [leaving]);
  useEffect(() => {
    const l = live.current;
    if (excited !== l.excited) {
      l.excitedAt = performance.now();
      l.burst?.();
    }
    l.excited = excited;
  }, [excited]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let disposed = false;
    let raf = 0;
    let layers: Awaited<ReturnType<typeof loadPixels>>[] | null = null;

    const low = document.createElement("canvas");
    low.width = CW;
    low.height = CH;
    const lowCtx = low.getContext("2d");
    const frame = lowCtx ? lowCtx.createImageData(CW, CH) : null;
    const threshold = bayer8();

    const leaves: Leaf[] = Array.from({ length: 18 }, () => ambientLeaf(Math.random, true));
    let sparkleCells: number[] = [];
    const glints: Array<{ i: number; born: number }> = [];

    // Canvas geometry (device pixels).
    let cell = 1;
    let ox = 0;
    let oy = 0;
    let grid: CanvasPattern | null = null;

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(host.clientWidth * dpr));
      const h = Math.max(1, Math.round(host.clientHeight * dpr));
      canvas.width = w;
      canvas.height = h;
      // Integer cell size so the grid lines stay crisp; "cover" fit.
      cell = Math.max(2, Math.ceil(Math.max(w / CW, h / CH)));
      // Centered horizontally, anchored to the bottom: the ground and
      // Claaky's feet stay in frame, extra crop comes out of the sky,
      // unless Claaky's speech bubble needs the room.
      ox = Math.floor((w - CW * cell) / 2);
      oy = Math.min(h - (CH - 20) * cell, Math.max(h - CH * cell, Math.round(live.current.headroom * dpr) - CLAAKY_HEAD.y * cell));
      live.current.onAnchor({ x: (ox + CLAAKY_HEAD.x * cell) / dpr, y: (oy + CLAAKY_HEAD.y * cell) / dpr });
      const tile = document.createElement("canvas");
      tile.width = cell;
      tile.height = cell;
      const t = tile.getContext("2d");
      if (t) {
        const line = Math.max(1, Math.round(dpr * 0.75));
        t.fillStyle = "rgba(255, 255, 255, 0.24)";
        t.fillRect(0, 0, cell, line);
        t.fillRect(0, line, line, cell - line);
        t.fillStyle = "rgba(0, 0, 0, 0.06)";
        t.fillRect(cell - line, line, line, cell - line);
        grid = ctx.createPattern(tile, "repeat");
      }
      draw(performance.now());
    };

    let start = -1;
    let last = 0;

    const compose = (now: number) => {
      if (!layers || !frame) return;
      const [sky, back, claakyRest, claakyUp, front] = layers;
      const t = start < 0 ? 0 : now - start;
      const l = live.current;
      const exit = l.exitAt < 0 ? 2 : 1 - (now - l.exitAt) / EXIT_MS;
      const reveal = reduced ? 2 : Math.min(2, t / REVEAL_MS, exit);
      const skyShift = reduced ? 0 : Math.floor(t / 1100) % sky.w;
      const sinceExcited = now - l.excitedAt;
      const bob = reduced
        ? 0
        : l.excitedAt >= 0 && sinceExcited < EXCITED_MS
          ? Math.floor(sinceExcited / 95) % 2
          : Math.sin(t / 520) > 0.35
            ? 1
            : 0;
      const out = frame.data;

      for (let y = 0; y < CH; y += 1) {
        for (let x = 0; x < CW; x += 1) {
          const o = (y * CW + x) * 4;
          // Dithered reveal: Bayer threshold biased top → bottom.
          const gate = threshold[(y & 7) * 8 + (x & 7)] * 0.55 + (y / CH) * 0.45;
          if (reveal < 1 && gate > reveal) {
            out[o + 3] = 0;
            continue;
          }
          const so = (y * sky.w + ((x + skyShift) % sky.w)) * 4;
          let r = sky.data[so];
          let g = sky.data[so + 1];
          let b = sky.data[so + 2];
          const bo = o;
          if (back.data[bo + 3] > 0) {
            r = back.data[bo];
            g = back.data[bo + 1];
            b = back.data[bo + 2];
          }
          const claaky = bob ? claakyUp : claakyRest;
          if (claaky.data[bo + 3] > 0) {
            r = claaky.data[bo];
            g = claaky.data[bo + 1];
            b = claaky.data[bo + 2];
          }
          if (front.data[bo + 3] > 0) {
            r = front.data[bo];
            g = front.data[bo + 1];
            b = front.data[bo + 2];
          }
          // Freshly revealed (or vanishing) cells flash a touch brighter.
          if (reveal < (l.exitAt < 0 ? 1.35 : 1.1) && gate > reveal - 0.12) {
            r = Math.min(255, r + 70);
            g = Math.min(255, g + 70);
            b = Math.min(255, b + 70);
          }
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = 255;
        }
      }

      // Golden flowers twinkle: a few flower cells flare and fade.
      if (reveal >= 1 && reveal <= 2) {
        for (let k = glints.length - 1; k >= 0; k -= 1) {
          const age = (now - glints[k].born) / GLINT_MS;
          if (age >= 1) {
            glints.splice(k, 1);
            continue;
          }
          const o = glints[k].i * 4;
          const boost = Math.sin(age * Math.PI) * 150;
          out[o] = Math.min(255, out[o] + boost);
          out[o + 1] = Math.min(255, out[o + 1] + boost);
          out[o + 2] = Math.min(255, out[o + 2] + boost * 0.9);
        }
      }

      if (reveal >= 0.6) {
        for (const leaf of leaves) {
          const lx = Math.round(leaf.x);
          const ly = Math.round(leaf.y);
          if (lx < 0 || lx >= CW || ly < 0 || ly >= CH) continue;
          const o = (ly * CW + lx) * 4;
          const fade = Number.isFinite(leaf.life) ? Math.min(1, leaf.life) : 1;
          out[o] = out[o] + (leaf.color[0] - out[o]) * fade;
          out[o + 1] = out[o + 1] + (leaf.color[1] - out[o + 1]) * fade;
          out[o + 2] = out[o + 2] + (leaf.color[2] - out[o + 2]) * fade;
          out[o + 3] = 255;
        }
      }
      lowCtx?.putImageData(frame, 0, 0);
    };

    const draw = (now: number) => {
      compose(now);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(low, ox, oy, CW * cell, CH * cell);
      if (grid) {
        ctx.save();
        ctx.translate(ox, oy);
        ctx.fillStyle = grid;
        ctx.fillRect(-ox, -oy, canvas.width, canvas.height);
        ctx.restore();
      }
    };

    const step = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(step);
      if (now - last < 1000 / FPS) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      if (sparkleCells.length && glints.length < 10 && Math.random() < 0.45) {
        glints.push({ i: sparkleCells[Math.floor(Math.random() * sparkleCells.length)], born: now });
      }
      for (let i = leaves.length - 1; i >= 0; i -= 1) {
        const leaf = leaves[i];
        leaf.phase += dt * 2.4;
        leaf.x += (leaf.vx + Math.sin(leaf.phase) * 3) * dt;
        leaf.y += (leaf.vy + Math.cos(leaf.phase * 0.7) * 1.5) * dt;
        if (Number.isFinite(leaf.life)) {
          leaf.life -= dt * 0.45;
          leaf.vy += dt * 6; // gravity on gust leaves
          if (leaf.life <= 0 || leaf.y > CH + 2) leaves.splice(i, 1);
        } else if (leaf.y > CH + 2 || leaf.x > CW + 22) {
          leaves[i] = ambientLeaf();
        }
      }
      draw(now);
    };

    const gust = (px: number, py: number, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 8 + Math.random() * 16;
        leaves.push({
          x: px,
          y: py,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 8,
          phase: Math.random() * 6,
          color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
          life: 1.6 + Math.random() * 0.8,
        });
      }
    };
    live.current.burst = () => {
      if (!reduced) gust(CLAAKY_HEAD.x, CLAAKY_HEAD.y + 6, 26);
    };

    // Tap → a gust of leaves bursts from the finger; tapping Claaky makes him bounce.
    const onPointerDown = (event: PointerEvent) => {
      if (reduced) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, rect.width);
      const px = ((event.clientX - rect.left) * dpr - ox) / cell;
      const py = ((event.clientY - rect.top) * dpr - oy) / cell;
      gust(px, py, 18);
      if (Math.abs(px - CLAAKY_HEAD.x) < 20 && py > CLAAKY_HEAD.y - 6 && py < 160) live.current.excitedAt = performance.now();
    };

    const observer = new ResizeObserver(resize);
    canvas.addEventListener("pointerdown", onPointerDown);

    void Promise.all(ART.map(loadPixels))
      .then((loaded) => {
        if (disposed) return;
        const sparkle = loaded[5];
        sparkleCells = [];
        for (let i = 0; i < CW * CH; i += 1) if (sparkle.data[i * 4] > 127) sparkleCells.push(i);
        layers = loaded.slice(0, 5);
        start = performance.now();
        observer.observe(host);
        resize();
        if (!reduced) raf = requestAnimationFrame(step);
      })
      .catch(() => {
        // Art is decorative: on failure the panel keeps its plain background.
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      live.current.burst = null;
    };
  }, []);

  return (
    <div ref={hostRef} className="scene">
      <canvas ref={canvasRef} className="scene__canvas" aria-hidden="true" />
      {children}
    </div>
  );
}
