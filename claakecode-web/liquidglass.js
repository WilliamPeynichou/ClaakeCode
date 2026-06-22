/* Liquid Glass — full-screen WebGL fluid-refraction background.
   Drives the whole site's art direction. Scroll + mouse animate it,
   themes recolor it live via window.setLiquidTheme(theme).

   Perf optimisations:
     · precision mediump  — suffisant pour le bruit fractal
     · 5 appels fbm (était 8) — suppression du calcul de normales (hx/hy)
                                 et du fbm vein remplacé par r.xy existants
     · 30 fps cap          — background fluide, imperceptible vs 60 fps
     · 50 % fill-rate      — canvas rendu à 50 % logique, étiré par CSS
                              → 4× moins de pixels par frame
     · dpr=1               — pas de surcharge HiDPI
     · Page Visibility API — pause RAF onglet caché
     · debounce resize 150 ms
     · Adaptive quality    — mobile/low-end : 25 % fill-rate + 24 fps      */

(function () {
  const canvas = document.getElementById('bg');
  if (!canvas || typeof THREE === 'undefined') return;

  /* ── Adaptive quality ─────────────────────────────────────────────── */
  const isLowEnd = (
    navigator.hardwareConcurrency <= 4 ||
    (navigator.deviceMemory && navigator.deviceMemory < 4)
  );
  const FILL      = isLowEnd ? 0.25 : 0.5;   // fraction of viewport pixels
  const TARGET_FPS = isLowEnd ? 24 : 30;
  const FRAME_MS   = 1000 / TARGET_FPS;

  /* ── Renderer ─────────────────────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  const scene  = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const C = (hex) => new THREE.Color(hex);

  /* ── Uniforms ─────────────────────────────────────────────────────── */
  const uniforms = {
    uTime:   { value: 0 },
    uScroll: { value: 0 },
    uRes:    { value: new THREE.Vector2(1, 1) },
    uMouse:  { value: new THREE.Vector2(0.5, 0.5) },
    cDeep:   { value: C('#0c1f17') },
    cMid:    { value: C('#1f6b48') },
    cLight:  { value: C('#cfe9b0') },
    cAccent: { value: C('#e8c87a') },
  };

  /* ── Shader material ─────────────────────────────────────────────── */
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
    `,
    fragmentShader: `
      precision mediump float;
      uniform float uTime, uScroll;
      uniform vec2  uRes, uMouse;
      uniform vec3  cDeep, cMid, cLight, cAccent;
      varying vec2  vUv;

      float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
        vec2 u=f*f*(3.-2.*f);
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      /* 4 octaves — équilibre qualité/perf */
      float fbm(vec2 p){
        float v=0., a=0.5;
        mat2 m=mat2(1.6,1.2,-1.2,1.6);
        for(int i=0;i<4;i++){ v+=a*noise(p); p=m*p; a*=0.5; }
        return v;
      }

      void main(){
        vec2 uv = vUv;
        vec2 p  = uv;
        p.x *= uRes.x/uRes.y;
        float t  = uTime*0.05;
        float sc = uScroll;

        /* domain-warped flow field — 5 fbm (était 8) */
        vec2 q = vec2(fbm(p*1.5 + vec2(0.0,t)),
                      fbm(p*1.5 + vec2(5.2,1.3) - t));
        vec2 r = vec2(fbm(p*1.5 + 2.0*q + vec2(1.7,9.2) + 0.15*t + sc*0.5),
                      fbm(p*1.5 + 2.0*q + vec2(8.3,2.8) - 0.12*t));
        float h = fbm(p*1.4 + 2.5*r + sc*0.6);

        /* palette height + scroll */
        float m1  = smoothstep(0.05, 0.62, h);
        float m2  = smoothstep(0.42, 0.96, h + 0.2*sin(sc*3.14159));
        vec3  col = mix(cDeep, cMid,  m1);
        col       = mix(col,  cLight, m2*0.9);

        /* veines accent — dérivées de r.xy (pas de fbm supplémentaire) */
        float vein = smoothstep(0.54, 0.72, r.x*0.6 + r.y*0.4);
        col = mix(col, cAccent, vein*0.38);

        /* highlight height (remplace specular/fresnel à base de normales) */
        col += smoothstep(0.72, 1.0, h) * 0.38 * mix(cLight, vec3(1.0), 0.45);

        /* mouse glow */
        vec2  mp = uMouse; mp.x *= uRes.x/uRes.y;
        col += exp(-length(p-mp)*2.2) * 0.08 * cLight;

        /* vignette + grain */
        float vig = smoothstep(1.35, 0.25, length(uv-0.5));
        col *= mix(0.86, 1.08, vig);
        col += (hash(uv*(uTime+1.0))-0.5)*0.018;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  /* ── Resize — 50 % fill-rate, debounce 150 ms ───────────────────── */
  let resizeTimer;
  function applyResize() {
    const w = window.innerWidth, h = window.innerHeight;
    // Rendu à FILL × taille logique, CSS étire le canvas → 4× moins de pixels
    renderer.setSize(Math.round(w * FILL), Math.round(h * FILL), false);
    uniforms.uRes.value.set(w, h); // passer la résolution réelle pour l'aspect ratio
  }
  function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyResize, 150); }
  window.addEventListener('resize', onResize);
  applyResize();

  /* ── Scroll — smoothed ───────────────────────────────────────────── */
  let scrollTarget = 0, scrollSmooth = 0;
  function onScroll() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollTarget = max > 0 ? window.scrollY / max : 0;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ── Mouse — smoothed ────────────────────────────────────────────── */
  let mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5;
  window.addEventListener('pointermove', (e) => {
    tmx = e.clientX / window.innerWidth;
    tmy = 1.0 - e.clientY / window.innerHeight;
  });

  /* ── Theme transition — lerp colors ─────────────────────────────── */
  const cur = { cDeep: C('#0c1f17'), cMid: C('#1f6b48'), cLight: C('#cfe9b0'), cAccent: C('#e8c87a') };
  const tgt = { cDeep: C('#0c1f17'), cMid: C('#1f6b48'), cLight: C('#cfe9b0'), cAccent: C('#e8c87a') };
  window.setLiquidTheme = function (theme) {
    tgt.cDeep.set(theme.deep);
    tgt.cMid.set(theme.mid);
    tgt.cLight.set(theme.light);
    tgt.cAccent.set(theme.accent);
  };

  /* ── Page Visibility — pause RAF quand onglet caché ─────────────── */
  let paused = false;
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) requestAnimationFrame(tick);
  });

  /* ── Render loop — capé à TARGET_FPS ────────────────────────────── */
  const clock = new THREE.Clock();
  let lastFrame = 0;

  function tick(now) {
    if (paused) return;
    requestAnimationFrame(tick);

    // Skip frame si en-dessous du budget temps cible
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    uniforms.uTime.value   = clock.getElapsedTime();
    scrollSmooth          += (scrollTarget - scrollSmooth) * 0.06;
    uniforms.uScroll.value = scrollSmooth;
    mx += (tmx - mx) * 0.05;
    my += (tmy - my) * 0.05;
    uniforms.uMouse.value.set(mx, my);

    ['cDeep', 'cMid', 'cLight', 'cAccent'].forEach((k) => {
      cur[k].lerp(tgt[k], 0.05);
      uniforms[k].value.copy(cur[k]);
    });

    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
})();
