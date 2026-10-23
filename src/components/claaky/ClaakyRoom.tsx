import { useEffect, useRef, useState } from "react";
import { Claaky } from "./Claaky";
import { subscribeClaakyActivity, useClaakyAgentState } from "./claakyAgentState";
import { RoomDirector, type ClipManifest } from "./roomDirector";

/** Exported by sinew/docs/Claaky3D/export_ide.sh (Blender). */
const BASE = "/claaky3d/bureau/";

type Assets = { manifest: ClipManifest; decor: HTMLImageElement; testDecor: HTMLImageElement | null; sheets: Map<string, HTMLImageElement> };

let assetsPromise: Promise<Assets> | null = null;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Claaky 3D : image introuvable ${src}`));
    img.src = src;
  });
}

/** Loaded once for the whole app; sprite sheets are shared by every room on screen. */
function loadAssets(): Promise<Assets> {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const res = await fetch(BASE + "clips.json");
      if (!res.ok) throw new Error("Claaky 3D : clips.json introuvable");
      const manifest = (await res.json()) as ClipManifest;
      const decor = await loadImage(BASE + manifest.decor);
      const sheets = new Map<string, HTMLImageElement>();
      await Promise.all(
        Object.entries(manifest.clips).map(async ([name, clip]) => {
          sheets.set(name, await loadImage(BASE + clip.planche));
        }),
      );
      const testDecor = manifest.machine?.decor
        ? await loadImage(BASE + manifest.machine.decor).catch(() => null)
        : null;
      return { manifest, decor, testDecor, sheets };
    })();
    assetsPromise.catch(() => {
      assetsPromise = null;
    });
  }
  return assetsPromise;
}

/**
 * Claaky's room rendered from Blender: a fixed background plus one sprite sheet per clip.
 * The RoomDirector picks the clips from the agent activity; the canvas only draws.
 * Falls back to the 2D Claaky while loading or if the exported images are missing.
 */
export function ClaakyRoom({ size = 420 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [failed, setFailed] = useState(false);
  const [label, setLabel] = useState("");
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
    const { manifest, decor, testDecor, sheets } = assets;
    const director = new RoomDirector(manifest, performance.now());
    const unsubscribe = subscribeClaakyActivity((a) => director.update(a, performance.now()));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const scale = canvas.width / manifest.taille;
    const background = document.createElement("canvas");
    background.width = canvas.width;
    background.height = canvas.height;
    const backgroundContext = background.getContext("2d");
    if (!backgroundContext) return unsubscribe;
    // These are softly shaded Blender renders, not pixel art. Filter when resizing on Retina.
    backgroundContext.imageSmoothingEnabled = true;
    backgroundContext.imageSmoothingQuality = "high";
    backgroundContext.drawImage(decor, 0, 0, background.width, background.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const draw = () => {
      const clip = manifest.clips[director.clip];
      const sheet = sheets.get(director.clip);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(background, 0, 0);
      const light = manifest.machine ? director.machineLight(performance.now(), manifest.machine) : null;
      if (light && testDecor) {
        ctx.save();
        ctx.globalAlpha = light.alpha;
        ctx.drawImage(testDecor, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      if (clip && sheet) {
        const i = Math.min(director.frame, clip.images - 1);
        const sx = (i % clip.colonnes) * clip.l;
        const sy = Math.floor(i / clip.colonnes) * clip.h;
        ctx.drawImage(sheet, sx, sy, clip.l, clip.h, clip.x * scale, clip.y * scale, clip.l * scale, clip.h * scale);
      }
      // Test machine glow: additive halo over the decor, only while a real test run lights it.
      if (light && manifest.machine && !testDecor) {
        const m = manifest.machine;
        const cx = m.x * scale;
        const cy = m.y * scale;
        const radius = m.r * scale;
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        glow.addColorStop(0, light.color);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.max(0, Math.min(1, light.alpha));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    // Frame loop at the export rate; stops when the room is off-screen or the window is hidden.
    let raf = 0;
    let timer = 0;
    let disposed = false;
    let last = performance.now();
    let visible = true;
    const period = 1000 / manifest.fps;
    let shown = "";
    const tick = (now: number) => {
      raf = 0;
      if (disposed || !visible || document.hidden) return;
      let steps = 0;
      while (now - last >= period && steps < 4) {
        director.step(now);
        last += period;
        steps += 1;
      }
      if (now - last > period * 4) last = now; // after a pause: no fast-forward
      if (steps) {
        draw();
        if (director.label !== shown) {
          shown = director.label;
          setLabel(shown);
        }
      }
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
    draw();
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
        aria-label={label ? `Claaky : ${label}` : "Claaky"}
      />
      <span className="claaky-room__label" aria-live="polite">
        {label}
      </span>
    </div>
  );
}
