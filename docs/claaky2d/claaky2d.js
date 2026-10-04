// Claaky 2D — drawn from films/claaky/assets/image_6e11fda6-…webp only.
// Matte "clay" look: no outlines, no glossy highlights on the body, soft gradients + soft occlusion.
// Colours sampled from the reference. Same markup will become Claaky.tsx; poses are pure CSS (data-state).
export const STATES = ["idle", "thinking", "working", "planning", "done", "error", "sleeping"];

let uid = 0;

/**
 * One anime-style eye, drawn for the LEFT side at the origin and mirrored for the right:
 * near-black oval, green iris glowing in the lower half, a lighter green patch, a dark lash
 * crescent on the outer side, and three highlights (big top, two small dots). Slight inward tilt.
 */
function eye(id, cx, cy, mirror) {
  const t = `translate(${cx} ${cy}) ${mirror ? "scale(-1 1) " : ""}rotate(9)`;
  return `<g transform="${t}">
    <path class="ck__lash" d="M-1.5 -11.6 C-8.6 -11.4 -11.8 -4 -10.9 3.2 C-10.5 5.6 -9.6 7.4 -8.6 8.4 C-9.6 4 -9.6 -1.6 -7.6 -6 C-6 -9.4 -3.8 -11 -1.5 -11.6 Z"/>
    <ellipse rx="7.9" ry="10.2" fill="url(#${id}eb)"/>
    <ellipse cy="3.2" rx="6.6" ry="6.4" fill="url(#${id}ei)"/>
    <path class="ck__iris-lt" d="M-5.6 2.6 C-5.6 6.6 -3.4 8.6 -0.6 8.8 C-1.6 6.6 -1.8 4.2 -1.2 2 C-2.6 1 -4.4 1.2 -5.6 2.6 Z"/>
    <circle class="ck__hl" cx="1.2" cy="-5.4" r="3.4"/>
    <circle class="ck__hl" cx="4.6" cy="-0.8" r="1.5"/>
    <circle class="ck__hl ck__hl--s" cx="-4.2" cy="-2.6" r="1"/>
  </g>`;
}
/** Lighting filter that turns a flat shape into a soft, puffy, matte clay volume. */
function clayFilter(fid, depth, sheenExp, grain) {
  return `<filter id="${fid}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${depth}" result="h"/>
      <feDiffuseLighting in="h" surfaceScale="${depth * 1.1}" diffuseConstant="1" lighting-color="#fff" result="d">
        <feDistantLight azimuth="235" elevation="58"/></feDiffuseLighting>
      <feComposite in="SourceGraphic" in2="d" operator="arithmetic" k1=".42" k2=".62" k3="0" k4="0" result="lit"/>
      <feSpecularLighting in="h" surfaceScale="${depth * 1.1}" specularConstant=".3" specularExponent="${sheenExp}" lighting-color="#fffdf2" result="sp">
        <feDistantLight azimuth="235" elevation="48"/></feSpecularLighting>
      <feComposite in="sp" in2="SourceAlpha" operator="in" result="sp2"/>
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .45  0 0 0 ${grain} 0" result="g"/>
      <feComposite in="g" in2="SourceAlpha" operator="in" result="g2"/>
      <feComposite in="lit" in2="sp2" operator="arithmetic" k2="1" k3=".22" result="ls"/>
      <feBlend in="g2" in2="ls" mode="soft-light" result="out"/>
      <feComposite in="out" in2="SourceAlpha" operator="in"/>
    </filter>`;
}
export function claakySvg(state = "idle", size = 160, { clay = size >= 48 } = {}) {
  const id = `ck${uid++}`;
  const skin = `url(#${id}s)`, green = `url(#${id}g)`;
  // Clay texture: per-part lighting filter (only at readable sizes — filters cost GPU time).
  const c = (k) => (clay ? ` filter="url(#${id}${k})"` : "");
  return `
<svg class="ck" data-state="${state}" viewBox="0 0 120 128" width="${size}" height="${size * 128 / 120}" role="img" aria-label="Claaky ${state}">
  <defs>
    <!-- matte cream-mint skin: light top-left, olive shade on the far edge -->
    <radialGradient id="${id}s" cx="42%" cy="34%" r="70%">
      <stop offset="0" stop-color="#ebf6dc"/><stop offset=".55" stop-color="#dcecc8"/>
      <stop offset=".85" stop-color="#cddcb4"/><stop offset="1" stop-color="#b9c89a"/>
    </radialGradient>
    <!-- matte deep green -->
    <radialGradient id="${id}g" cx="40%" cy="35%" r="75%">
      <stop offset="0" stop-color="#3b8e5c"/><stop offset=".55" stop-color="#2a7a4a"/>
      <stop offset="1" stop-color="#175331"/>
    </radialGradient>
    <linearGradient id="${id}l" x1="1" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#155030"/><stop offset=".45" stop-color="#2a7a4a"/><stop offset="1" stop-color="#358a57"/>
    </linearGradient>
    <linearGradient id="${id}r" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#155030"/><stop offset=".45" stop-color="#2a7a4a"/><stop offset="1" stop-color="#3a8f5e"/>
    </linearGradient>
    <!-- eye: near-black green oval, green iris glowing from the bottom -->
    <radialGradient id="${id}eb" cx="50%" cy="40%" r="60%">
      <stop offset="0" stop-color="#10231a"/><stop offset="1" stop-color="#08130d"/>
    </radialGradient>
    <radialGradient id="${id}ei" cx="45%" cy="78%" r="70%">
      <stop offset="0" stop-color="#3fa25c"/><stop offset=".45" stop-color="#22743f"/>
      <stop offset=".85" stop-color="#134a28" stop-opacity=".7"/><stop offset="1" stop-color="#0c2a17" stop-opacity="0"/>
    </radialGradient>
    <!-- CLAY: blur the shape's alpha into a height map, light it (diffuse = soft volume, specular =
         satin sheen), then layer a faint noise grain. One filter per material (skin is thicker than leaves). -->
    ${clayFilter(id + "cs", 6.5, 10, 0.07)}
    ${clayFilter(id + "cg", 4, 8, 0.08)}
    ${clayFilter(id + "ct", 3, 8, 0.07)}
    <filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="${id}b2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.6"/></filter>
  </defs>

  <ellipse class="ck__shadow" cx="60" cy="121" rx="26" ry="4" filter="url(#${id}b)"/>

  <g class="ck__fx ck__fx--back">
    <g class="ck__bubble ck__bubble--code"><rect x="92" y="64" width="28" height="18" rx="9"/><text x="106" y="76.5">&lt;/&gt;</text></g>
    <g class="ck__bubble ck__bubble--plan"><rect x="0" y="62" width="24" height="24" rx="7"/>
      <path d="M5 69h3M10 69h9M5 74h3M10 74h9M5 79h3M10 79h6"/></g>
  </g>

  <g class="ck__body">
    <g class="ck__squash">
      <!-- legs -->
      <ellipse cx="48.5" cy="113.5" rx="9" ry="7.5" fill="${skin}"${c("ct")}/>
      <ellipse cx="71.5" cy="113.5" rx="9" ry="7.5" fill="${skin}"${c("ct")}/>
      <ellipse class="ck__ao" cx="60" cy="112" rx="5" ry="6" filter="url(#${id}b)"/>
      <!-- torso (narrower than the head, pear-shaped) -->
      <path fill="${skin}" d="M35 77 C25 94 30 117 60 117 C90 117 95 94 85 77 Z"${c("cs")}/>
      <!-- belly swirl (comma sweeping from the left shoulder to a round end) -->
      <path fill="${green}" d="M49 79 C34 88 35 114 58.5 114.5 C73 115 78.5 103 72 95.5 C66.5 89.5 56.5 91.5 57 100 C49.5 99 44 90 49 79 Z"${c("cg")}/>
      <!-- soft occlusion under the head -->
      <ellipse class="ck__ao" cx="60" cy="80" rx="25" ry="5" filter="url(#${id}b2)"/>

      <g class="ck__head">
        <!-- big leaf ears (origin = base, tucked behind the head) -->
        <g transform="translate(38 38)"><g class="ck__ear ck__ear--l">
          <path fill="url(#${id}l)" d="M9 7 C-6 15 -31 8 -35 -27 C-34 -31 -30 -32 -26 -31 C-10 -26 1 -14 5 -6 C8 0 10 3 9 7 Z"${c("cg")}/></g></g>
        <g transform="translate(82 38)"><g class="ck__ear ck__ear--r">
          <path fill="url(#${id}r)" d="M-9 7 C6 15 31 8 35 -27 C34 -31 30 -32 26 -31 C10 -26 -1 -14 -5 -6 C-8 0 -10 3 -9 7 Z"${c("cg")}/></g></g>
        <!-- top ball, matte -->
        <g class="ck__ball"><circle cx="60" cy="15.5" r="9.5" fill="${green}"${c("cg")}/>
          <ellipse class="ck__ao" cx="60" cy="24.5" rx="7" ry="1.8" filter="url(#${id}b)"/></g>
        <!-- head -->
        <ellipse cx="60" cy="51" rx="35" ry="31.5" fill="${skin}"${c("cs")}/>
        <!-- brows: thin, low-contrast -->
        <g class="ck__brows"><path d="M41.5 38.5 Q45.5 36.2 49.5 38"/><path d="M70.5 38 Q74.5 36.2 78.5 38.5"/></g>
        <!-- cheeks: blurred blush -->
        <g class="ck__cheeks" filter="url(#${id}b)">
          <ellipse cx="37" cy="63.5" rx="6" ry="4"/><ellipse cx="83" cy="63.5" rx="6" ry="4"/></g>
        <!-- eyes: open (the eyes are the only glossy part, like the reference) -->
        <g class="ck__eyes ck__eyes--open"><g class="ck__look">
          ${eye(id, 46, 54, false)}
          ${eye(id, 74, 54, true)}
        </g></g>
        <!-- eyes: happy ^^ / closed -->
        <g class="ck__eyes ck__eyes--happy"><path d="M40 56 Q46 48 52 56"/><path d="M68 56 Q74 48 80 56"/></g>
        <g class="ck__eyes ck__eyes--closed"><path d="M40 55 Q46 59 52 55"/><path d="M68 55 Q74 59 80 55"/></g>
        <!-- mouths -->
        <g class="ck__mouth ck__mouth--open">
          <path class="ck__mouth-in" d="M53.6 65 Q60 63.8 66.4 65 Q66 74.4 60 74.4 Q54 74.4 53.6 65 Z"/>
          <ellipse class="ck__tongue" cx="60" cy="71.8" rx="4" ry="2.5"/></g>
        <path class="ck__mouth ck__mouth--smile" d="M55 66 Q60 70.5 65 66"/>
        <ellipse class="ck__mouth ck__mouth--o ck__mouth-in" cx="60" cy="68" rx="3.2" ry="3.8"/>
        <path class="ck__mouth ck__mouth--flat" d="M56.5 67.5 Q60 69 63.5 67.5"/>
      </g>
      <!-- stubby arms (origin = shoulder), drawn over the head so poses can reach the face -->
      <g transform="translate(40 84)"><g class="ck__arm ck__arm--l">
        <ellipse cx="0" cy="-9" rx="7" ry="11.5" fill="${skin}"${c("ct")}/></g></g>
      <g transform="translate(80 84)"><g class="ck__arm ck__arm--r">
        <ellipse cx="0" cy="-9" rx="7" ry="11.5" fill="${skin}"${c("ct")}/></g></g>
    </g>
  </g>

  <g class="ck__fx">
    <g class="ck__dots"><circle cx="100" cy="40" r="2.4"/><circle cx="108" cy="32" r="3"/><circle cx="114" cy="22" r="3.6"/></g>
    <g class="ck__sparks">
      <path d="M14 22 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z"/><path d="M104 18 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 z"/>
      <path d="M100 66 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2 z"/></g>
    <path class="ck__sweat" d="M92 34 q5 7 0 10 q-5 -3 0 -10 z"/>
    <g class="ck__zz"><text x="92" y="30">z</text><text x="101" y="18">z</text></g>
  </g>
</svg>`;
}
