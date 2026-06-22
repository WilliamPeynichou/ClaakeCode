/* Liquid Glass — full-screen WebGL fluid-refraction background.
   Drives the whole site's art direction. Scroll + mouse animate it,
   themes recolor it live via window.setLiquidTheme(theme).

   Perf (plan 1782119065100):
     · precision mediump  — sufficient for fractal noise, faster on mobile
     · 4 fbm octaves      — was 6; ~33 % fewer shader instructions, imperceptible on slow motion
     · dpr capped at 1    — shader is intrinsically blurry, no benefit from HiDPI fill-rate
     · no preserveDrawingBuffer — lets GPU free the framebuffer after each present
     · Page Visibility API — pauses RAF when the tab is hidden
     · debounced resize (150 ms) — avoids renderer reconstruction on every pixel           */
(function () {
  const canvas = document.getElementById('bg');
  if (!canvas || typeof THREE === 'undefined') return;

  /* ── Renderer ─────────────────────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1); // cap at 1 — HiDPI fill-rate costs more than it adds
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
      /* 4 octaves instead of 6 — ~33 % fewer texture fetches per fragment */
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

        /* domain-warped flow field → liquid motion */
        vec2 q = vec2(fbm(p*1.5 + vec2(0.0,t)),  fbm(p*1.5 + vec2(5.2,1.3) - t));
        vec2 r = vec2(fbm(p*1.5 + 2.0*q + vec2(1.7,9.2) + 0.15*t + sc*0.5),
                      fbm(p*1.5 + 2.0*q + vec2(8.3,2.8) - 0.12*t));
        float h = fbm(p*1.4 + 2.5*r + sc*0.6);

        /* height → surface normal (glass-refraction look) */
        float e  = 0.0025;
        float hx = fbm((p+vec2(e,0.0))*1.4 + 2.5*r + sc*0.6) - h;
        float hy = fbm((p+vec2(0.0,e))*1.4 + 2.5*r + sc*0.6) - h;
        vec3  n  = normalize(vec3(-hx, -hy, e*1.2));

        /* palette by height + scroll */
        float m1  = smoothstep(0.05, 0.62, h);
        float m2  = smoothstep(0.42, 0.96, h + 0.2*sin(sc*3.14159));
        vec3  col = mix(cDeep, cMid,  m1);
        col       = mix(col,  cLight, m2*0.9);

        /* accent veins */
        float vein = smoothstep(0.78, 0.95, fbm(p*3.0 + r*2.0 + t*2.0));
        col = mix(col, cAccent, vein*0.45);

        /* specular + fresnel rim = glass highlights */
        vec3  L    = normalize(vec3(0.4, 0.8, 0.6));
        float spec = pow(max(dot(n,L), 0.0), 28.0);
        float fres = pow(1.0 - n.z, 2.5);
        col += spec * 0.75 * mix(cLight, vec3(1.0), 0.5);
        col += fres * 0.16 * cLight;

        /* mouse glow */
        vec2  mp = uMouse; mp.x *= uRes.x/uRes.y;
        float md = exp(-length(p-mp)*2.2);
        col += md * 0.10 * cLight;

        /* vignette + grain */
        float vig = smoothstep(1.35, 0.25, length(uv-0.5));
        col *= mix(0.86, 1.08, vig);
        col += (hash(uv*(uTime+1.0))-0.5)*0.018;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  /* ── Resize — debounced 150 ms ───────────────────────────────────── */
  let resizeTimer;
  function applyResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    uniforms.uRes.value.set(w, h);
  }
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyResize, 150);
  }
  window.addEventListener('resize', resize);
  applyResize(); // immediate on init, no debounce needed

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

  /* ── Page Visibility — pause RAF when tab is hidden ─────────────── */
  let paused = false;
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) tick(); // resume immediately on return
  });

  /* ── Render loop ─────────────────────────────────────────────────── */
  const clock = new THREE.Clock();
  function tick() {
    if (paused) return;

    uniforms.uTime.value = clock.getElapsedTime();
    scrollSmooth += (scrollTarget - scrollSmooth) * 0.06;
    uniforms.uScroll.value = scrollSmooth;
    mx += (tmx - mx) * 0.05;
    my += (tmy - my) * 0.05;
    uniforms.uMouse.value.set(mx, my);

    ['cDeep', 'cMid', 'cLight', 'cAccent'].forEach((k) => {
      cur[k].lerp(tgt[k], 0.05);
      uniforms[k].value.copy(cur[k]);
    });

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
})();
