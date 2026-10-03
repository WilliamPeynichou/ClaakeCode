import { useEffect, useRef } from "react";
import type { BufferGeometry, Group, Material, Mesh, NormalBufferAttributes } from "three";
import type { ClaakyState } from "./Claaky";

type Geo = BufferGeometry<NormalBufferAttributes>;

/**
 * Claaky in 3D: a soft, squishy little blob built from primitives (no model file).
 *
 * Feel: every motion goes through damped springs, so he squashes, stretches, overshoots and
 * jiggles back like a plush toy. Squash is volume-preserving (taller = thinner) and pivots on
 * his feet. Fluff comes from a velvet sheen, a soft halo of translucent shells and a few tufts.
 *
 * `three` is imported on demand. One canvas, ~30 fps, paused when hidden or off-screen.
 * `onUnavailable` fires if WebGL cannot start so the caller can fall back to the SVG sprite.
 */
const SLEEP_AFTER_MS = 90_000;
const FRAME_MS = 1000 / 30;
const FOOT_Y = -1.0;

type Spring = { x: number; v: number; target: number };
const spring = (x = 0): Spring => ({ x, v: 0, target: x });
const stepSpring = (s: Spring, k: number, c: number, dt: number) => {
  s.v += (k * (s.target - s.x) - c * s.v) * dt;
  s.x += s.v * dt;
};
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function ClaakyScene({
  size = 168,
  state = "idle",
  onUnavailable,
}: {
  size?: number;
  state?: ClaakyState;
  onUnavailable?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const failRef = useRef(onUnavailable);
  failRef.current = onUnavailable;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup = () => {};

    void import("three")
      .then((THREE) => {
        if (disposed) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        let renderer: InstanceType<typeof THREE.WebGLRenderer>;
        try {
          renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        } catch {
          failRef.current?.();
          return;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(size, size);
        renderer.domElement.className = "claaky-scene__canvas";
        renderer.domElement.setAttribute("aria-hidden", "true");
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
        camera.position.set(0, 0.45, 7.6);
        camera.lookAt(0, 0.1, 0);

        scene.add(new THREE.HemisphereLight(0xfff6e0, 0x4a4636, 1.2));
        const key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(2.5, 3.5, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0xe7c878, 1.2);
        rim.position.set(-3, 1.5, -2.5);
        scene.add(rim);

        const mats: Material[] = [];
        const geos: Geo[] = [];
        const track = <M extends Material>(m: M): M => {
          mats.push(m);
          return m;
        };
        const mesh = (geo: Geo, m: Material) => {
          geos.push(geo);
          return new THREE.Mesh(geo, m);
        };

        // Fluffy: velvet sheen on a matte cream body.
        const fur = track(
          new THREE.MeshPhysicalMaterial({
            color: 0xf6edd6,
            emissive: 0x4a4332,
            emissiveIntensity: 0.55,
            roughness: 0.92,
            metalness: 0,
            sheen: 1,
            sheenColor: new THREE.Color(0xfff1d2),
            sheenRoughness: 0.35,
          }),
        );
        const furLimb = track(
          new THREE.MeshPhysicalMaterial({
            color: 0xeee3c8,
            emissive: 0x4a4332,
            emissiveIntensity: 0.5,
            roughness: 0.95,
            sheen: 1,
            sheenColor: new THREE.Color(0xfff1d2),
            sheenRoughness: 0.4,
          }),
        );

        // squish pivots on the feet; root floats on top of it.
        const squish = new THREE.Group();
        squish.position.y = FOOT_Y;
        scene.add(squish);
        const root = new THREE.Group();
        root.position.y = -FOOT_Y;
        squish.add(root);

        const body = mesh(new THREE.SphereGeometry(1, 48, 36), fur);
        body.scale.set(1.05, 0.98, 0.95);
        root.add(body);
        // Soft halo: two translucent shells just outside the body fake fuzzy edges.
        [
          { s: 1.035, o: 0.1 },
          { s: 1.075, o: 0.05 },
        ].forEach(({ s, o }) => {
          const shell = mesh(
            new THREE.SphereGeometry(1, 32, 24),
            track(new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: o, depthWrite: false })),
          );
          shell.scale.set(1.05 * s, 0.98 * s, 0.95 * s);
          root.add(shell);
        });
        // A few small tufts along the top of the head (round, not pointy).
        const tuftGeo = new THREE.SphereGeometry(0.15, 16, 12);
        [
          { x: -0.3, y: 0.9, z: 0.1, s: 0.8 },
          { x: -0.1, y: 0.97, z: 0.12, s: 1 },
          { x: 0.12, y: 0.98, z: 0.1, s: 0.9 },
          { x: 0.3, y: 0.9, z: 0.08, s: 0.75 },
        ].forEach(({ x, y, z, s }) => {
          const tuft = mesh(tuftGeo, fur);
          tuft.scale.set(s, s * 0.85, s * 0.8);
          tuft.position.set(x, y, z);
          root.add(tuft);
        });

        // Eyes with a little sparkle each.
        const eyeMat = track(new THREE.MeshStandardMaterial({ color: 0x1d1b16, roughness: 0.2 }));
        const sparkMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
        const eyeGeo = new THREE.SphereGeometry(0.12, 20, 16);
        const sparkGeo = new THREE.SphereGeometry(0.035, 10, 8);
        const eyes = [-0.36, 0.36].map((x) => {
          const group = new THREE.Group();
          group.position.set(x, 0.12, 0.88);
          const eye = mesh(eyeGeo, eyeMat);
          eye.scale.set(0.9, 1.3, 0.6);
          const spark = mesh(sparkGeo, sparkMat);
          spark.position.set(0.035, 0.07, 0.07);
          group.add(eye, spark);
          root.add(group);
          return { group, baseX: x };
        });

        const cheekMat = track(new THREE.MeshStandardMaterial({ color: 0xf0a9a0, roughness: 0.9, transparent: true, opacity: 0.85 }));
        const cheekGeo = new THREE.SphereGeometry(0.14, 16, 12);
        [-0.64, 0.64].forEach((x) => {
          const cheek = mesh(cheekGeo, cheekMat);
          cheek.scale.set(1.3, 0.8, 0.35);
          cheek.position.set(x, -0.12, 0.8);
          root.add(cheek);
        });

        const mouthMat = track(new THREE.MeshStandardMaterial({ color: 0x1d1b16, roughness: 0.4 }));
        const mouth = mesh(new THREE.TorusGeometry(0.13, 0.026, 8, 24, Math.PI), mouthMat);
        mouth.rotation.z = Math.PI;
        root.add(mouth);

        const stem = mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 10), track(new THREE.MeshStandardMaterial({ color: 0x8a8470, roughness: 0.6 })));
        stem.position.set(0.05, 1.18, 0);
        stem.rotation.z = -0.18;
        root.add(stem);
        const bulbMat = track(new THREE.MeshStandardMaterial({ color: 0xe7c878, emissive: 0xe7c878, emissiveIntensity: 0.7, roughness: 0.3 }));
        const bulb = mesh(new THREE.SphereGeometry(0.1, 20, 16), bulbMat);
        bulb.position.set(0.13, 1.41, 0);
        root.add(bulb);

        const armGeo = new THREE.CapsuleGeometry(0.1, 0.28, 6, 12);
        const makeArm = (side: number) => {
          const pivot = new THREE.Group();
          pivot.position.set(side * 1.0, -0.02, 0.05);
          const arm = mesh(armGeo, furLimb);
          arm.position.set(side * 0.06, -0.2, 0);
          pivot.add(arm);
          root.add(pivot);
          return pivot;
        };
        const armLg: Group = makeArm(-1);
        const armRg: Group = makeArm(1);

        const footGeo = new THREE.SphereGeometry(0.2, 16, 12);
        [-0.42, 0.42].forEach((x) => {
          const foot = mesh(footGeo, furLimb);
          foot.scale.set(1.15, 0.6, 1);
          foot.position.set(x, -0.95, 0.15);
          root.add(foot);
        });

        const shadowMat = track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24, depthWrite: false }));
        const shadow = mesh(new THREE.CircleGeometry(0.9, 32), shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.set(0, FOOT_Y - 0.02, 0);
        scene.add(shadow);

        // Floating bits: gold dots (thinking / planning / done), tear (error), "z" (sleep).
        const fxMat = track(new THREE.MeshStandardMaterial({ color: 0xe7c878, emissive: 0xe7c878, emissiveIntensity: 0.8, roughness: 0.3 }));
        const fxGeo = new THREE.SphereGeometry(0.09, 14, 10);
        const fx: Mesh[] = [0, 1, 2].map(() => {
          const m = mesh(fxGeo, fxMat);
          m.visible = false;
          scene.add(m);
          return m;
        });
        const tearMat = track(new THREE.MeshStandardMaterial({ color: 0x7ab8e6, roughness: 0.2, transparent: true, opacity: 0.9 }));
        const tear = mesh(new THREE.SphereGeometry(0.07, 12, 10), tearMat);
        tear.scale.set(0.8, 1.3, 0.8);
        tear.visible = false;
        root.add(tear);

        const zCanvas = document.createElement("canvas");
        zCanvas.width = zCanvas.height = 64;
        const zctx = zCanvas.getContext("2d");
        if (zctx) {
          zctx.font = "700 46px sans-serif";
          zctx.fillStyle = "#cfc8ae";
          zctx.textAlign = "center";
          zctx.textBaseline = "middle";
          zctx.fillText("z", 32, 34);
        }
        const zTex = new THREE.CanvasTexture(zCanvas);
        const zs = [0, 1].map(() => {
          const mat = new THREE.SpriteMaterial({ map: zTex, transparent: true, depthWrite: false });
          mats.push(mat);
          const sprite = new THREE.Sprite(mat);
          sprite.visible = false;
          scene.add(sprite);
          return sprite;
        });

        // ── Physics ──────────────────────────────────────────────────────────────────────
        const sq = spring(0); // squash (+ = taller, - = squashed)
        const wz = spring(0); // jelly tilt around z
        const wx = spring(0); // jelly tilt around x
        const armL = spring(0.25);
        const armR = spring(-0.25);
        const smile = spring(1);
        const wow = spring(1);
        let py = 0; // height above ground while hopping
        let pv = 0;
        const impulse = (k: { v: number }, amount: number) => {
          if (!reduce) k.v += amount;
        };

        const queue: { at: number; fn: () => void }[] = [];
        const later = (at: number, fn: () => void) => {
          queue.push({ at, fn });
          queue.sort((a, b) => a.at - b.at);
        };
        const hop = (now: number, power = 5.4) => {
          if (reduce || py > 0.01) return;
          impulse(sq, -9); // anticipation: crouch
          later(now + 110, () => {
            pv = power;
            sq.v += 12; // launch: stretch
          });
        };

        let lastActivity = performance.now();
        let targetX = 0;
        let targetY = 0;
        let lookX = 0;
        let lookY = 0;
        let pressed = false;
        let pressedAt = 0;
        let waveUntil = 0;
        let doneAt = -1e9;
        let nextBeat = 0;
        let nextIdleHop = performance.now() + 6000;
        let prev: ClaakyState | "" = "";
        let fxVis = 0;

        const onMove = (event: PointerEvent) => {
          const rect = host.getBoundingClientRect();
          targetX = clamp((event.clientX - (rect.left + rect.width / 2)) / 360, -1, 1);
          targetY = clamp((event.clientY - (rect.top + rect.height / 2)) / 360, -1, 1);
          lastActivity = performance.now();
        };
        const onDown = () => {
          pressed = true;
          pressedAt = performance.now();
          lastActivity = pressedAt;
        };
        const onUp = () => {
          if (!pressed) return;
          pressed = false;
          const now = performance.now();
          lastActivity = now;
          impulse(sq, 8); // pop back with overshoot
          impulse(wz, (Math.random() < 0.5 ? -1 : 1) * 3);
          if (now - pressedAt < 260) {
            hop(now, 6.2);
            waveUntil = now + 1100;
          }
        };
        const onEnter = () => {
          impulse(wz, 3.5);
          impulse(sq, 2.5);
          lastActivity = performance.now();
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        host.addEventListener("pointerdown", onDown);
        window.addEventListener("pointerup", onUp);
        host.addEventListener("pointerenter", onEnter);

        const draw = (now: number, dtRaw: number) => {
          const t = now / 1000;
          const dt = Math.min(dtRaw, 0.05);
          let st: ClaakyState = stateRef.current;
          const asleep = st === "idle" && now - lastActivity > SLEEP_AFTER_MS;
          if (asleep) st = "sleeping";
          const active = st !== "idle" && st !== "sleeping";

          if (st !== prev) {
            if (st === "done") {
              doneAt = now;
              hop(now, 6.4);
              impulse(wz, 4);
            } else if (st === "error") {
              impulse(sq, -7);
              impulse(wz, 6);
            } else if (st === "working" || st === "thinking" || st === "planning") {
              impulse(sq, 5);
              impulse(wz, -3);
            } else if (prev === "sleeping") {
              hop(now, 4.6);
            }
            prev = st;
          }
          while (queue.length && queue[0].at <= now) queue.shift()!.fn();

          // ── Targets by state ──
          let lx = pressed ? 0 : targetX;
          let ly = pressed ? 0 : targetY;
          sq.target = 0.014 * Math.sin(t * (st === "sleeping" ? 1.1 : 2.2));
          wz.target = 0;
          wx.target = 0;
          armL.target = 0.25 + Math.sin(t * 2.2) * 0.05;
          armR.target = -0.25 - Math.sin(t * 2.2) * 0.05;
          smile.target = 1;
          wow.target = 1;
          let bulb = 0.55 + Math.sin(t * 3.2) * 0.3;
          let bulbHex = 0xe7c878;
          let blinkClosed = false;

          if (pressed) sq.target = -0.32;
          switch (st) {
            case "idle":
              if (now > nextIdleHop && !pressed) {
                hop(now, 4.2);
                nextIdleHop = now + 7000 + Math.random() * 6000;
              }
              break;
            case "thinking":
              wz.target = Math.sin(t * 1.5) * 0.09 + 0.05;
              lx = 0.6;
              ly = -0.7;
              armR.target = -1.15; // hand near the chin
              bulb = 0.5 + Math.sin(t * 5) * 0.4;
              break;
            case "working":
              if (now > nextBeat) {
                impulse(sq, -4.2);
                impulse(wz, (Math.floor(now / 520) % 2 ? 1 : -1) * 1.6);
                nextBeat = now + 520;
              }
              armL.target = 0.5 + Math.sin(t * 22) * 0.5;
              armR.target = -0.5 - Math.sin(t * 22 + 1.6) * 0.5;
              lx = 0;
              ly = 0.45;
              bulb = 0.6 + Math.sin(t * 12) * 0.4;
              break;
            case "planning":
              wz.target = Math.sin(t * 0.9) * 0.14;
              lx = Math.sin(t * 0.9) * 0.7;
              ly = -0.3;
              armR.target = -0.9 + Math.sin(t * 1.8) * 0.15;
              break;
            case "done": {
              const u = clamp((now - doneAt) / 1400, 0, 1);
              const cheer = Math.sin(t * 16) * 0.2 * (1 - u);
              armL.target = -(2.5 + cheer);
              armR.target = 2.5 + cheer;
              smile.target = 1;
              wow.target = 1.5;
              bulb = 1.2;
              break;
            }
            case "error":
              sq.target = -0.11;
              wz.target = 0.1;
              ly = 0.5;
              lx = -0.2;
              armL.target = 0.12;
              armR.target = -0.12;
              smile.target = -1;
              bulb = 0.25;
              bulbHex = 0xd97a6c;
              break;
            case "sleeping":
              sq.target += -0.05;
              wz.target = 0.07;
              blinkClosed = true;
              smile.target = 0.55;
              bulb = 0.1;
              break;
          }
          if (waveUntil > now) armR.target = 2.2 + Math.sin(t * 18) * 0.35;

          // ── Integrate (fixed substeps keep the springs stable) ──
          const n = Math.max(1, Math.ceil(dt / (1 / 90)));
          const h = dt / n;
          for (let i = 0; i < n; i++) {
            if (reduce) {
              sq.x = sq.target;
              wz.x = wz.target;
              wx.x = wx.target;
              armL.x = armL.target;
              armR.x = armR.target;
              smile.x = smile.target;
              wow.x = wow.target;
              continue;
            }
            stepSpring(sq, 150, 8, h);
            stepSpring(wz, 110, 5.5, h);
            stepSpring(wx, 110, 5.5, h);
            stepSpring(armL, 190, 11, h);
            stepSpring(armR, 190, 11, h);
            stepSpring(smile, 220, 14, h);
            stepSpring(wow, 220, 14, h);
            if (py > 0 || pv > 0) {
              pv -= 24 * h;
              py += pv * h;
              if (py <= 0) {
                const impact = Math.abs(pv);
                py = 0;
                pv = 0;
                sq.v -= Math.min(10, impact * 1.7); // landing squash
                wz.v += 1.5;
              }
            }
          }

          // ── Apply ──
          const sy = clamp(1 + sq.x, 0.55, 1.5);
          const sxz = clamp(1 - sq.x * 0.55, 0.75, 1.3);
          squish.scale.set(sxz, sy, sxz);
          squish.position.y = FOOT_Y + py;
          root.rotation.z = wz.x - lookX * 0.06;
          root.rotation.x = wx.x + (asleep ? 0.18 : lookY * 0.25);
          root.rotation.y = asleep ? 0 : lookX * 0.5;

          lookX += (lx - lookX) * 0.1;
          lookY += (ly - lookY) * 0.1;
          const blinkPhase = (t % 4.2) / 4.2;
          const lid = blinkClosed || (active ? false : blinkPhase > 0.965) ? 0.12 : 1;
          eyes.forEach(({ group, baseX }) => {
            group.scale.y = lerp(group.scale.y, lid, 0.5);
            group.position.x = baseX + lookX * 0.07;
            group.position.y = 0.12 - lookY * 0.06;
          });

          armLg.rotation.z = armL.x;
          armRg.rotation.z = armR.x;
          mouth.scale.set(wow.x, smile.x, 1);
          mouth.position.set(0, -0.14 - ((1 - smile.x) / 2) * 0.13, 0.92 + ((1 - smile.x) / 2) * 0.04);

          bulbMat.emissiveIntensity = bulb;
          bulbMat.color.setHex(bulbHex);
          bulbMat.emissive.setHex(bulbHex);
          shadow.scale.setScalar(clamp(1 - py * 0.35, 0.5, 1) * sxz);
          shadowMat.opacity = 0.24 * clamp(1 - py * 0.3, 0.4, 1);

          // Gold dots: thinking = bobbing row, planning = orbit, done = burst.
          const wantFx = st === "thinking" || st === "planning" || st === "done" ? 1 : 0;
          fxVis += (wantFx - fxVis) * 0.15;
          fx.forEach((m, i) => {
            m.visible = fxVis > 0.02;
            if (!m.visible) return;
            if (st === "planning") {
              const a = t * 1.3 + (i * Math.PI * 2) / 3;
              m.position.set(Math.cos(a) * 1.5, 0.35 + Math.sin(a * 2) * 0.12, Math.sin(a) * 0.6);
            } else if (st === "done") {
              const u = clamp((now - doneAt) / 1300, 0, 1);
              const a = (i * Math.PI * 2) / 3 + 0.6;
              m.position.set(Math.cos(a) * (1.1 + u * 0.7), 0.7 + u * 0.9, Math.sin(a) * 0.5);
            } else {
              m.position.set((i - 1) * 0.34 + 0.55, 1.75 + Math.sin(t * 3 + i * 0.9) * 0.1, 0.2);
            }
            m.scale.setScalar(fxVis * (0.6 + 0.4 * Math.sin(t * 5 + i)));
          });

          tear.visible = st === "error";
          if (tear.visible) {
            const u = (t * 0.7) % 1;
            tear.position.set(0.66, 0.0 - u * 0.65, 0.78);
            tearMat.opacity = 0.9 * Math.sin(Math.PI * clamp(u * 1.1, 0, 1));
          }

          zs.forEach((sprite, i) => {
            sprite.visible = st === "sleeping";
            if (!sprite.visible) return;
            const u = (t * 0.35 + i * 0.5) % 1;
            sprite.position.set(0.95 + u * 0.35, 0.9 + u * 0.9, 0.2);
            sprite.scale.setScalar(0.28 + u * 0.22);
            (sprite.material as InstanceType<typeof THREE.SpriteMaterial>).opacity = Math.sin(Math.PI * u) * 0.9;
          });

          renderer.render(scene, camera);
        };

        let raf = 0;
        let visible = true;
        let last = 0;
        const frameMs = reduce ? 250 : FRAME_MS;
        const loop = (now: number) => {
          raf = requestAnimationFrame(loop);
          if (!visible || document.hidden || now - last < frameMs) return;
          const dt = last ? (now - last) / 1000 : 1 / 30;
          last = now;
          const probe = (window as unknown as { __claakyPerf?: number[] }).__claakyPerf;
          const t0 = probe ? performance.now() : 0;
          draw(now, dt);
          if (probe) probe.push(performance.now() - t0);
        };
        const observer = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
        });
        observer.observe(host);
        raf = requestAnimationFrame(loop);

        cleanup = () => {
          cancelAnimationFrame(raf);
          observer.disconnect();
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          host.removeEventListener("pointerdown", onDown);
          host.removeEventListener("pointerenter", onEnter);
          geos.forEach((geo) => geo.dispose());
          mats.forEach((material) => material.dispose());
          zTex.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      })
      .catch(() => {
        if (!disposed) failRef.current?.();
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [size]);

  return (
    <div
      ref={hostRef}
      className="claaky-scene"
      style={{ width: size, height: size }}
      role="img"
      aria-label="Claaky, votre compagnon"
    />
  );
}
