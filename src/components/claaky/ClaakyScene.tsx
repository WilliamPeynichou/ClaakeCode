import { useEffect, useRef } from "react";
import type { BufferGeometry, Material, NormalBufferAttributes } from "three";

type Geo = BufferGeometry<NormalBufferAttributes>;

/**
 * Claaky in 3D, built from primitives (no model file). `three` is imported on demand so it never
 * weighs on startup. One canvas, rendered only while visible, capped at ~30 fps, and paused when
 * the window is hidden. `onUnavailable` fires when WebGL cannot start so the caller can fall
 * back to the SVG sprite.
 */
const SLEEP_AFTER_MS = 90_000;
const FRAME_MS = 1000 / 30;

export function ClaakyScene({
  size = 168,
  onUnavailable,
}: {
  size?: number;
  onUnavailable?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const failRef = useRef(onUnavailable);
  failRef.current = onUnavailable;

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
        camera.position.set(0, 0.25, 7.2);
        camera.lookAt(0, 0.05, 0);

        scene.add(new THREE.HemisphereLight(0xfff6e0, 0x3a3a2a, 1.15));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(2.5, 3.5, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0xe7c878, 1.1);
        rim.position.set(-3, 1.5, -2.5);
        scene.add(rim);

        const mats: Material[] = [];
        const geos: Geo[] = [];
        const mat = (color: number, extra: Record<string, unknown> = {}) => {
          const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.02, ...extra });
          mats.push(m);
          return m;
        };
        const mesh = (geo: Geo, m: Material) => {
          geos.push(geo);
          return new THREE.Mesh(geo, m);
        };

        const root = new THREE.Group();
        scene.add(root);
        const body = mesh(new THREE.SphereGeometry(1, 40, 32), mat(0xf3e9d0));
        body.scale.set(1.05, 0.98, 0.95);
        root.add(body);

        const eyeMat = mat(0x1d1b16, { roughness: 0.25 });
        const eyeGeo = new THREE.SphereGeometry(0.11, 20, 16);
        const eyes = [-0.36, 0.36].map((x) => {
          const eye = mesh(eyeGeo, eyeMat);
          eye.scale.set(0.9, 1.25, 0.6);
          eye.position.set(x, 0.12, 0.89);
          root.add(eye);
          return eye;
        });

        const cheekMat = mat(0xf0a9a0, { roughness: 0.9 });
        const cheekGeo = new THREE.SphereGeometry(0.13, 16, 12);
        [-0.62, 0.62].forEach((x) => {
          const cheek = mesh(cheekGeo, cheekMat);
          cheek.scale.set(1.3, 0.8, 0.35);
          cheek.position.set(x, -0.12, 0.8);
          root.add(cheek);
        });

        const mouth = mesh(new THREE.TorusGeometry(0.13, 0.026, 8, 24, Math.PI), mat(0x1d1b16));
        mouth.rotation.z = Math.PI;
        mouth.position.set(0, -0.14, 0.9);
        root.add(mouth);

        const stem = mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 10), mat(0x8a8470));
        stem.position.set(0.05, 1.12, 0);
        stem.rotation.z = -0.18;
        root.add(stem);
        const bulbMat = mat(0xe7c878, { emissive: 0xe7c878, emissiveIntensity: 0.7, roughness: 0.3 });
        const bulb = mesh(new THREE.SphereGeometry(0.1, 20, 16), bulbMat);
        bulb.position.set(0.13, 1.35, 0);
        root.add(bulb);

        const armGeo = new THREE.CapsuleGeometry(0.1, 0.28, 6, 12);
        const armMat = mat(0xeadfc2);
        const makeArm = (side: number) => {
          const pivot = new THREE.Group();
          pivot.position.set(side * 1.0, -0.02, 0.05);
          const arm = mesh(armGeo, armMat);
          arm.position.set(side * 0.06, -0.2, 0);
          pivot.add(arm);
          root.add(pivot);
          return pivot;
        };
        const armL = makeArm(-1);
        const armR = makeArm(1);

        const footGeo = new THREE.SphereGeometry(0.2, 16, 12);
        const footMat = mat(0xeadfc2);
        [-0.42, 0.42].forEach((x) => {
          const foot = mesh(footGeo, footMat);
          foot.scale.set(1.15, 0.6, 1);
          foot.position.set(x, -0.95, 0.15);
          root.add(foot);
        });

        const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
        mats.push(shadowMat);
        const shadow = mesh(new THREE.CircleGeometry(0.85, 32), shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.set(0, -1.12, 0);
        scene.add(shadow);

        // ── State driven by the pointer and by time ───────────────────────────────────────
        let targetX = 0;
        let targetY = 0;
        let lookX = 0;
        let lookY = 0;
        let lastActivity = performance.now();
        let waveAt = -1e9;
        let sleeping = false;
        const wake = () => {
          lastActivity = performance.now();
          sleeping = false;
        };
        const onMove = (event: PointerEvent) => {
          const rect = host.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          targetX = Math.max(-1, Math.min(1, (event.clientX - cx) / 360));
          targetY = Math.max(-1, Math.min(1, (event.clientY - cy) / 360));
          wake();
        };
        const onClick = () => {
          waveAt = performance.now();
          wake();
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        host.addEventListener("click", onClick);

        const draw = (now: number) => {
          if (!sleeping && now - lastActivity > SLEEP_AFTER_MS) sleeping = true;
          const t = now / 1000;
          lookX += (targetX - lookX) * 0.08;
          lookY += (targetY - lookY) * 0.08;

          const breathe = Math.sin(t * (sleeping ? 1.1 : 2.2));
          body.scale.set(1.05 - breathe * 0.012, 0.98 + breathe * 0.02, 0.95);
          root.position.y = sleeping ? -0.05 : Math.sin(t * 2.2) * 0.04;
          const wave = Math.max(0, 1 - (now - waveAt) / 900);
          root.position.y += Math.sin(Math.min(1, (now - waveAt) / 450) * Math.PI) * (wave > 0 ? 0.22 : 0);

          root.rotation.y = sleeping ? 0 : lookX * 0.55;
          root.rotation.x = sleeping ? 0.18 : lookY * 0.3;
          root.rotation.z = sleeping ? 0.08 : -lookX * 0.06;

          const blinkPhase = (t % 4.2) / 4.2;
          const blink = sleeping || blinkPhase > 0.965 ? 0.12 : 1;
          eyes.forEach((eye) => {
            eye.scale.y = 1.25 * blink;
            eye.position.x = (eye.position.x < 0 ? -0.36 : 0.36) + (sleeping ? 0 : lookX * 0.06);
            eye.position.y = 0.12 + (sleeping ? 0 : -lookY * 0.05);
          });

          armL.rotation.z = 0.25 + Math.sin(t * 2.2) * 0.05;
          armR.rotation.z = -0.25 - Math.sin(t * 2.2) * 0.05 - wave * (1.5 + Math.sin(t * 18) * 0.35);

          bulbMat.emissiveIntensity = sleeping ? 0.12 : 0.55 + Math.sin(t * 3.2) * 0.3;
          shadow.scale.setScalar(1 - (root.position.y > 0 ? root.position.y * 0.5 : 0));
          renderer.render(scene, camera);
        };

        let raf = 0;
        let visible = true;
        let last = 0;
        const loop = (now: number) => {
          raf = requestAnimationFrame(loop);
          if (!visible || document.hidden || now - last < FRAME_MS) return;
          last = now;
          draw(now);
        };
        const observer = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
        });
        observer.observe(host);
        if (reduce) draw(performance.now());
        else raf = requestAnimationFrame(loop);

        cleanup = () => {
          cancelAnimationFrame(raf);
          observer.disconnect();
          window.removeEventListener("pointermove", onMove);
          host.removeEventListener("click", onClick);
          geos.forEach((geo) => geo.dispose());
          mats.forEach((material) => material.dispose());
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
