import { useEffect, useRef } from "react";
import type { BufferGeometry, Group, Material, Mesh, NormalBufferAttributes } from "three";
import type { ClaakyState } from "./Claaky";

type Geo = BufferGeometry<NormalBufferAttributes>;

/**
 * Claaky in 3D, built from the Claake logo: a round head floating above a bowl made of two
 * leaf-petals, with a round green core between them. No model file, only primitives.
 *
 * Feel: every motion goes through damped springs, so he squashes, stretches, overshoots and
 * jiggles back like a plush toy. Squash is volume-preserving (taller = thinner) and pivots on
 * his feet. Fluff comes from a velvet sheen and soft halo shells.
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
        camera.position.set(0, 0.12, 7.6);
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

        // Body: the logo's bowl, two leaf-petals (lower half-spheres with flat tops) and a gap.
        const R = 1.08;
        const cream = fur;
        // The channel between the petals shows the logo's green, not the inside of a shell.
        const channel = track(new THREE.MeshStandardMaterial({ color: 0x1f5a41, roughness: 0.8 }));
        const leafGroup = (side: -1 | 1) => {
          const pivot = new THREE.Group(); // flaps around the bottom centre, like opening petals
          pivot.position.set(0, -0.92, 0);
          const piece = new THREE.Group();
          piece.position.set(side * 0.022, 0.92, 0);
          piece.scale.set(1.0, 0.95, 1);
          const shell = mesh(
            new THREE.SphereGeometry(R, 40, 28, side === -1 ? -Math.PI / 2 : Math.PI / 2, Math.PI, Math.PI / 2, Math.PI / 2),
            cream,
          );
          const top = mesh(new THREE.CircleGeometry(R, 40, side === -1 ? Math.PI / 2 : -Math.PI / 2, Math.PI), cream);
          top.rotation.x = -Math.PI / 2;
          const inner = mesh(new THREE.CircleGeometry(R, 40, Math.PI, Math.PI), channel);
          inner.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
          [shell, top, inner].forEach((m) => piece.add(m));
          // soft halo shell so the edges look fluffy
          const halo = mesh(
            new THREE.SphereGeometry(R * 1.035, 32, 20, side === -1 ? -Math.PI / 2 : Math.PI / 2, Math.PI, Math.PI / 2, Math.PI / 2),
            track(new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.1, depthWrite: false })),
          );
          piece.add(halo);
          pivot.add(piece);
          root.add(pivot);
          return pivot;
        };
        const leafLg: Group = leafGroup(-1);
        const leafRg: Group = leafGroup(1);

        // Core: the logo's round belly, between the petals.
        const coreMat = track(
          new THREE.MeshStandardMaterial({ color: 0x2e7355, emissive: 0x2e7355, emissiveIntensity: 0.6, roughness: 0.45 }),
        );
        const core = mesh(new THREE.SphereGeometry(0.5, 36, 28), coreMat);
        core.position.set(0, -0.42, 0.78);
        root.add(core);

        // Head: the logo's round dot, floating above the bowl with its own springy bounce.
        const head = new THREE.Group();
        head.position.set(0, 1.04, 0.04);
        root.add(head);
        const skull = mesh(new THREE.SphereGeometry(0.66, 40, 30), fur);
        head.add(skull);
        [1.04, 1.09].forEach((k, i) => {
          const shell = mesh(
            new THREE.SphereGeometry(0.58 * k, 28, 20),
            track(new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: i ? 0.05 : 0.1, depthWrite: false })),
          );
          head.add(shell);
        });

        const eyeMat = track(new THREE.MeshStandardMaterial({ color: 0x1d1b16, roughness: 0.2 }));
        const sparkMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
        const eyeGeo = new THREE.SphereGeometry(0.075, 20, 16);
        const sparkGeo = new THREE.SphereGeometry(0.022, 10, 8);
        const eyes = [-0.23, 0.23].map((x) => {
          const group = new THREE.Group();
          group.position.set(x, 0.06, 0.6);
          const eye = mesh(eyeGeo, eyeMat);
          eye.scale.set(0.9, 1.3, 0.6);
          const spark = mesh(sparkGeo, sparkMat);
          spark.position.set(0.024, 0.045, 0.045);
          group.add(eye, spark);
          head.add(group);
          return { group, baseX: x };
        });

        const cheekMat = track(new THREE.MeshStandardMaterial({ color: 0xf0a9a0, roughness: 0.9, transparent: true, opacity: 0.85 }));
        const cheekGeo = new THREE.SphereGeometry(0.085, 16, 12);
        [-0.41, 0.41].forEach((x) => {
          const cheek = mesh(cheekGeo, cheekMat);
          cheek.scale.set(1.3, 0.8, 0.35);
          cheek.position.set(x, -0.1, 0.52);
          head.add(cheek);
        });

        const mouthMat = track(new THREE.MeshStandardMaterial({ color: 0x1d1b16, roughness: 0.4 }));
        const mouth = mesh(new THREE.TorusGeometry(0.11, 0.021, 8, 24, Math.PI), mouthMat);
        mouth.rotation.z = Math.PI;
        head.add(mouth);

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
        head.add(tear);

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
        const armL = spring(0.05); // left leaf opening (+ = leans outward)
        const armR = spring(0.05); // right leaf opening
        const headY = spring(0); // head bounce, lags behind the body
        const headTilt = spring(0);
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
          armL.target = 0.05 + Math.sin(t * 2.2) * 0.03;
          armR.target = 0.05 + Math.sin(t * 2.2 + 0.6) * 0.03;
          headY.target = -sq.x * 0.5;
          headTilt.target = 0;
          smile.target = 1;
          wow.target = 1;
          let bulb = 0.45 + Math.sin(t * 3.2) * 0.12;
          let bulbHex = 0x2e7355;
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
              armR.target = -0.4; // one petal folds in, like a hand at the chin
              headTilt.target = 0.12;
              bulb = 0.6 + Math.sin(t * 5) * 0.25;
              break;
            case "working":
              if (now > nextBeat) {
                impulse(sq, -4.2);
                impulse(wz, (Math.floor(now / 520) % 2 ? 1 : -1) * 1.6);
                nextBeat = now + 520;
              }
              armL.target = 0.2 + Math.sin(t * 22) * 0.2;
              armR.target = 0.2 + Math.sin(t * 22 + 1.6) * 0.2;
              lx = 0;
              ly = 0.45;
              bulb = 0.7 + Math.sin(t * 12) * 0.3;
              break;
            case "planning":
              wz.target = Math.sin(t * 0.9) * 0.14;
              lx = Math.sin(t * 0.9) * 0.7;
              ly = -0.3;
              armR.target = 0.45 + Math.sin(t * 1.8) * 0.1;
              headTilt.target = Math.sin(t * 0.9) * 0.14;
              break;
            case "done": {
              const u = clamp((now - doneAt) / 1400, 0, 1);
              const cheer = Math.sin(t * 16) * 0.2 * (1 - u);
              armL.target = 0.95 + cheer;
              armR.target = 0.95 + cheer;
              smile.target = 1;
              wow.target = 1.5;
              bulb = 1.0;
              break;
            }
            case "error":
              sq.target = -0.11;
              wz.target = 0.1;
              ly = 0.5;
              lx = -0.2;
              armL.target = -0.14;
              armR.target = -0.14;
              headTilt.target = -0.16;
              smile.target = -1;
              bulb = 0.3;
              bulbHex = 0xb9605a;
              break;
            case "sleeping":
              sq.target += -0.05;
              wz.target = 0.07;
              blinkClosed = true;
              smile.target = 0.55;
              bulb = 0.12;
              break;
          }
          if (waveUntil > now) armR.target = 0.75 + Math.sin(t * 18) * 0.3;

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
              headY.x = headY.target;
              headTilt.x = headTilt.target;
              smile.x = smile.target;
              wow.x = wow.target;
              continue;
            }
            stepSpring(sq, 150, 8, h);
            stepSpring(wz, 110, 5.5, h);
            stepSpring(wx, 110, 5.5, h);
            stepSpring(armL, 190, 11, h);
            stepSpring(armR, 190, 11, h);
            stepSpring(headY, 70, 3.2, h);
            stepSpring(headTilt, 90, 5, h);
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
            group.position.x = baseX + lookX * 0.05;
            group.position.y = 0.04 - lookY * 0.04;
          });
          head.position.y = 1.04 + headY.x + (asleep ? -0.1 : 0);
          head.rotation.z = headTilt.x - lookX * 0.1;
          head.rotation.y = asleep ? 0 : lookX * 0.45;
          head.rotation.x = asleep ? 0.3 : lookY * 0.3;

          leafLg.rotation.z = armL.x;
          leafRg.rotation.z = -armR.x;
          mouth.scale.set(wow.x, smile.x, 1);
          mouth.position.set(0, -0.2 - ((1 - smile.x) / 2) * 0.09, 0.63 + ((1 - smile.x) / 2) * 0.02);
          core.scale.setScalar(1 + (bulb - 0.5) * 0.06);

          coreMat.emissiveIntensity = bulb;
          coreMat.color.setHex(bulbHex);
          coreMat.emissive.setHex(bulbHex);
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
              m.position.set(Math.cos(a) * 1.5, 0.55 + Math.sin(a * 2) * 0.12, Math.sin(a) * 0.6);
            } else if (st === "done") {
              const u = clamp((now - doneAt) / 1300, 0, 1);
              const a = (i * Math.PI * 2) / 3 + 0.6;
              m.position.set(Math.cos(a) * (1.1 + u * 0.7), 0.9 + u * 0.9, Math.sin(a) * 0.5);
            } else {
              m.position.set((i - 1) * 0.34 + 0.7, 2.05 + Math.sin(t * 3 + i * 0.9) * 0.1, 0.2);
            }
            m.scale.setScalar(fxVis * (0.6 + 0.4 * Math.sin(t * 5 + i)));
          });

          tear.visible = st === "error";
          if (tear.visible) {
            const u = (t * 0.7) % 1;
            tear.position.set(0.3, -0.05 - u * 0.45, 0.5);
            tearMat.opacity = 0.9 * Math.sin(Math.PI * clamp(u * 1.1, 0, 1));
          }

          zs.forEach((sprite, i) => {
            sprite.visible = st === "sleeping";
            if (!sprite.visible) return;
            const u = (t * 0.35 + i * 0.5) % 1;
            sprite.position.set(0.8 + u * 0.35, 1.2 + u * 0.9, 0.2);
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
