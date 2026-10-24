import { useEffect, useRef, useState } from "react";
import { Claaky } from "./Claaky";
import { subscribeClaakyActivity, useClaakyAgentState } from "./claakyAgentState";
import { FADE_MS, RoomDirector, type ClipManifest, type MachineAnchor } from "./roomDirector";

/** Exported by sinew/docs/Claaky3D/export_ide.sh (Blender). */
const BASE = "/claaky3d/bureau/";

type Rect = { x: number; y: number; w: number; h: number };
/** Lit test machine: only the part of decor_tests.png that differs from decor.png. */
type MachinePatch = { image: HTMLCanvasElement; rect: Rect };
type Assets = { manifest: ClipManifest; decor: HTMLImageElement; machine: MachinePatch | null };

let assetsPromise: Promise<Assets> | null = null;
/** Sprite sheets, loaded on demand and shared by every room on screen. */
const sheets = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<void>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      // Decode off the frame loop so the first draw never stalls.
      img.decode().then(
        () => resolve(img),
        () => resolve(img),
      );
    };
    img.onerror = () => reject(new Error(`Claaky 3D : image introuvable ${src}`));
    img.src = src;
  });
}

function loadSheet(manifest: ClipManifest, name: string): Promise<void> {
  const clip = manifest.clips[name];
  if (!clip || sheets.has(name)) return Promise.resolve();
  let p = pending.get(name);
  if (!p) {
    p = loadImage(BASE + clip.planche).then(
      (img) => {
        sheets.set(name, img);
      },
      (err) => console.warn(err),
    );
    p.finally(() => pending.delete(name));
    pending.set(name, p);
  }
  return p;
}

/** Crops the lit machine to the pixels that change, so its glow redraws a tiny area only. */
function machinePatch(decor: HTMLImageElement, lit: HTMLImageElement, anchor: MachineAnchor): MachinePatch | null {
  const w = decor.naturalWidth;
  const h = decor.naturalHeight;
  const read = (img: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  const a = read(decor);
  const b = read(lit);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  if (a && b) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) {
    // No visible difference: fall back to a box around the screen.
    const r = anchor.r * 3;
    x0 = Math.max(0, Math.floor(anchor.x - r));
    y0 = Math.max(0, Math.floor(anchor.y - r));
    x1 = Math.min(w - 1, Math.ceil(anchor.x + r));
    y1 = Math.min(h - 1, Math.ceil(anchor.y + r));
  }
  const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const image = document.createElement("canvas");
  image.width = rect.w;
  image.height = rect.h;
  image.getContext("2d")?.drawImage(lit, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return { image, rect };
}

/** Manifest and background only; sprite sheets come later, one by one. */
function loadAssets(): Promise<Assets> {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const res = await fetch(BASE + "clips.json");
      if (!res.ok) throw new Error("Claaky 3D : clips.json introuvable");
      const manifest = (await res.json()) as ClipManifest;
      const decor = await loadImage(BASE + manifest.decor);
      const first = "attente" in manifest.clips ? "attente" : Object.keys(manifest.clips)[0];
      await loadSheet(manifest, first);
      return { manifest, decor, machine: null };
    })();
    assetsPromise.catch(() => {
      assetsPromise = null;
    });
  }
  return assetsPromise;
}

const union = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * Claaky's room rendered from Blender: a fixed background plus one sprite sheet per clip.
 * The RoomDirector picks the clips from the agent activity; the canvas only redraws the area
 * that changed (the sprite, the fading sprite after a teleport and the test machine glow).
 * Falls back to the 2D Claaky while loading or if the exported images are missing.
 */
export function ClaakyRoom({ size = 420 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [failed, setFailed] = useState(false);
  const fallbackState = useClaakyAgentState();

  useEffect(() => {
    let alive = true;
    loadAssets().then(
      (a) => alive && setAssets(a),
      (err) => {
        console.warn(err);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!assets || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { manifest, decor } = assets;
    const director = new RoomDirector(manifest, performance.now());
    const unsubscribe = subscribeClaakyActivity((a) => director.update(a, performance.now()));
    let disposed = false;

    // Background loading, in the order clips are likely to be needed; never blocks the loop.
    let machine: MachinePatch | null = assets.machine;
    const prefetch = async () => {
      for (const name of director.likelyClips()) {
        if (disposed) return;
        await loadSheet(manifest, name);
      }
      if (!machine && manifest.machine?.decor && !disposed) {
        const lit = await loadImage(BASE + manifest.machine.decor).catch(() => null);
        if (lit && !disposed) {
          machine = machinePatch(decor, lit, manifest.machine);
          assets.machine = machine;
        }
      }
    };
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    idle(() => void prefetch());

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const scale = canvas.width / manifest.taille;
    const background = document.createElement("canvas");
    background.width = canvas.width;
    background.height = canvas.height;
    const bg = background.getContext("2d");
    if (!bg) return unsubscribe;
    // These are softly shaded Blender renders, not pixel art. Filter when resizing on Retina.
    bg.imageSmoothingEnabled = true;
    bg.imageSmoothingQuality = "high";
    bg.drawImage(decor, 0, 0, background.width, background.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";

    /** Canvas-pixel box of a clip, rounded outwards. */
    const box = (x: number, y: number, w: number, h: number): Rect => {
      const x0 = Math.floor(x * scale) - 1;
      const y0 = Math.floor(y * scale) - 1;
      return { x: x0, y: y0, w: Math.ceil((x + w) * scale) + 1 - x0, h: Math.ceil((y + h) * scale) + 1 - y0 };
    };
    const spriteBox = (name: string) => {
      const c = manifest.clips[name];
      return c && sheets.has(name) ? box(c.x, c.y, c.l, c.h) : null;
    };
    const drawSprite = (name: string, frame: number, alpha: number) => {
      const clip = manifest.clips[name];
      const sheet = sheets.get(name);
      if (!clip || !sheet || alpha <= 0) return;
      const i = Math.min(frame, clip.images - 1);
      const sx = (i % clip.colonnes) * clip.l;
      const sy = Math.floor(i / clip.colonnes) * clip.h;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sheet, sx, sy, clip.l, clip.h, clip.x * scale, clip.y * scale, clip.l * scale, clip.h * scale);
      ctx.globalAlpha = 1;
    };

    let previous: Rect | null = null;
    let lastKey = "";
    let wasLit = false;
    const draw = (now: number, full = false) => {
      const light = manifest.machine ? director.machineLight(now, manifest.machine) : null;
      const fade = director.fade;
      const fadeLeft = fade ? 1 - (now - fade.start) / FADE_MS : 0;
      const key = `${director.clip}:${director.frame}:${fade ? fadeLeft.toFixed(2) : ""}:${light ? light.alpha.toFixed(2) : ""}`;
      if (!full && key === lastKey) return; // nothing moved
      lastKey = key;
      const machineRect = machine ? box(machine.rect.x, machine.rect.y, machine.rect.w, machine.rect.h) : null;
      let current = spriteBox(director.clip);
      if (fade && fadeLeft > 0) current = union(current, spriteBox(fade.clip));
      // Repaint the old sprite area, the new one and the machine (its glow and anything over it).
      let dirty = full ? { x: 0, y: 0, w: canvas.width, h: canvas.height } : union(previous, current);
      if (machineRect && (light || wasLit || full || (dirty && overlaps(dirty, machineRect)))) dirty = union(dirty, machineRect);
      wasLit = !!light;
      previous = current;
      if (!dirty) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
      ctx.clip();
      ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
      ctx.drawImage(background, dirty.x, dirty.y, dirty.w, dirty.h, dirty.x, dirty.y, dirty.w, dirty.h);
      if (light && machine) {
        const m = machine.rect;
        ctx.globalAlpha = Math.max(0, Math.min(1, light.alpha));
        ctx.drawImage(machine.image, m.x * scale, m.y * scale, m.w * scale, m.h * scale);
        ctx.globalAlpha = 1;
      }
      if (fade && fadeLeft > 0) {
        drawSprite(fade.clip, fade.frame, fadeLeft);
        drawSprite(director.clip, director.frame, 1 - fadeLeft);
      } else {
        drawSprite(director.clip, director.frame, 1);
      }
      ctx.restore();
    };

    // Frame loop at the export rate; stops when the room is off-screen or the window is hidden.
    let raf = 0;
    let timer = 0;
    let last = performance.now();
    let visible = true;
    const period = 1000 / manifest.fps;
    const ready = (name: string) => {
      if (sheets.has(name)) return true;
      void loadSheet(manifest, name);
      return false;
    };
    const tick = (now: number) => {
      raf = 0;
      if (disposed || !visible || document.hidden) return;
      let steps = 0;
      while (now - last >= period && steps < 4) {
        director.step(now, ready);
        last += period;
        steps += 1;
      }
      if (now - last > period * 4) last = now; // after a pause: no fast-forward
      if (steps) draw(now);
      schedule();
    };
    const schedule = () => {
      if (!disposed && !raf && !timer && visible && !document.hidden) {
        timer = window.setTimeout(() => {
          timer = 0;
          if (!disposed && visible && !document.hidden) raf = requestAnimationFrame(tick);
        }, Math.max(0, period - (performance.now() - last) - 4));
      }
    };
    const onVisibility = () => {
      last = performance.now();
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      raf = timer = 0;
      schedule();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      onVisibility();
    });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    draw(performance.now(), true);
    schedule();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [assets, size]);

  if (failed) return <Claaky state={fallbackState} size={168} />;
  return (
    <div className="claaky-room" style={{ width: size }}>
      <canvas
        ref={canvasRef}
        className="claaky-room__canvas"
        style={{ width: size, height: size, opacity: assets ? 1 : 0 }}
        role="img"
        aria-label="Claaky"
      />
    </div>
  );
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
