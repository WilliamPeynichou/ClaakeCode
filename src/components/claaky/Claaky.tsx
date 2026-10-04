import { memo, useEffect, useId, useRef, type CSSProperties } from "react";
import { observeClaaky } from "./claakyVisibility";

export type ClaakyState =
  | "idle"
  | "thinking"
  | "working"
  | "planning"
  | "done"
  | "error"
  | "sleeping";

const LABELS: Record<ClaakyState, string> = {
  idle: "Claaky attend",
  thinking: "Claaky réfléchit",
  working: "Claaky code",
  planning: "Claaky planifie",
  done: "Claaky a terminé",
  error: "Claaky a rencontré une erreur",
  sleeping: "Claaky dort",
};

/** Below this width the clay lighting filters are skipped (cost) and the speech bubbles hidden (noise). */
const CLAY_MIN = 48;
const TINY_MAX = 40;

/**
 * Lighting filter turning a flat shape into a soft, puffy, matte clay volume: the shape's alpha is
 * blurred into a height map, lit (diffuse = volume, specular = satin sheen), then a faint grain is added.
 */
function ClayFilter({ id, depth, sheen, grain }: { id: string; depth: number; sheen: number; grain: number }) {
  const scale = depth * 1.1;
  return (
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation={depth} result="h" />
      <feDiffuseLighting in="h" surfaceScale={scale} diffuseConstant={1} lightingColor="#fff" result="d">
        <feDistantLight azimuth={235} elevation={58} />
      </feDiffuseLighting>
      <feComposite in="SourceGraphic" in2="d" operator="arithmetic" k1={0.42} k2={0.62} k3={0} k4={0} result="lit" />
      <feSpecularLighting in="h" surfaceScale={scale} specularConstant={0.3} specularExponent={sheen} lightingColor="#fffdf2" result="sp">
        <feDistantLight azimuth={235} elevation={48} />
      </feSpecularLighting>
      <feComposite in="sp" in2="SourceAlpha" operator="in" result="sp2" />
      <feTurbulence type="fractalNoise" baseFrequency={0.9} numOctaves={2} seed={7} result="n" />
      <feColorMatrix in="n" type="matrix" values={`0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .45  0 0 0 ${grain} 0`} result="g" />
      <feComposite in="g" in2="SourceAlpha" operator="in" result="g2" />
      <feComposite in="lit" in2="sp2" operator="arithmetic" k2={1} k3={0.22} result="ls" />
      <feBlend in="g2" in2="ls" mode="soft-light" result="out" />
      <feComposite in="out" in2="SourceAlpha" operator="in" />
    </filter>
  );
}

/** One anime-style eye (drawn for the left side, mirrored for the right): dark oval, green iris glowing low, lash, three highlights. */
function Eye({ uid, cx, cy, mirror }: { uid: string; cx: number; cy: number; mirror?: boolean }) {
  return (
    <g transform={`translate(${cx} ${cy}) ${mirror ? "scale(-1 1) " : ""}rotate(9)`}>
      <path
        className="claaky__lash"
        d="M-1.5 -11.6 C-8.6 -11.4 -11.8 -4 -10.9 3.2 C-10.5 5.6 -9.6 7.4 -8.6 8.4 C-9.6 4 -9.6 -1.6 -7.6 -6 C-6 -9.4 -3.8 -11 -1.5 -11.6 Z"
      />
      <ellipse rx="7.9" ry="10.2" fill={`url(#${uid}eb)`} />
      <ellipse cy="3.2" rx="6.6" ry="6.4" fill={`url(#${uid}ei)`} />
      <path className="claaky__iris-lt" d="M-5.6 2.6 C-5.6 6.6 -3.4 8.6 -0.6 8.8 C-1.6 6.6 -1.8 4.2 -1.2 2 C-2.6 1 -4.4 1.2 -5.6 2.6 Z" />
      <circle className="claaky__hl" cx="1.2" cy="-5.4" r="3.4" />
      <circle className="claaky__hl" cx="4.6" cy="-0.8" r="1.5" />
      <circle className="claaky__hl claaky__hl--s" cx="-4.2" cy="-2.6" r="1" />
    </g>
  );
}

/**
 * Claaky, the companion: a 2D SVG drawn from the reference illustration
 * (films/claaky/assets/image_6e11fda6-…webp) — cream-mint body, green leaf ears, green ball on top,
 * green swirl on the belly. Matte clay texture from SVG lighting filters at readable sizes; flat
 * gradients below CLAY_MIN. Poses are pure CSS on transform/opacity, driven by data-state, and stop
 * under prefers-reduced-motion. Used for the loaders, the chat header, the empty editor and Settings.
 */
export const Claaky = memo(function Claaky({
  state = "idle",
  size = 24,
  className,
  decorative = false,
  animated = true,
  textured = true,
}: {
  state?: ClaakyState;
  size?: number;
  className?: string;
  /** When another element already carries the label (e.g. "Thinking"). */
  decorative?: boolean;
  /** Static pose thumbnails do not need any animation or visibility observer. */
  animated?: boolean;
  /** Keep expensive lighting for the main character, not every Settings thumbnail. */
  textured?: boolean;
}) {
  const uid = `ck${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (animated && ref.current) return observeClaaky(ref.current);
  }, [animated]);
  const clay = textured && size >= CLAY_MIN;
  const tiny = size < TINY_MAX;
  const skin = `url(#${uid}s)`;
  const green = `url(#${uid}g)`;
  const f = (k: string) => (clay ? `url(#${uid}${k})` : undefined);
  const blur = tiny ? undefined : `url(#${uid}b)`;
  const classes = ["claaky", tiny ? "claaky--tiny" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <svg
      ref={ref}
      className={classes}
      data-static={!animated ? "true" : undefined}
      data-state={state}
      viewBox="0 0 120 128"
      width={size}
      height={(size * 128) / 120}
      style={{ "--claaky-size": `${size}px` } as CSSProperties}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : LABELS[state]}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <defs>
        <radialGradient id={`${uid}s`} cx="42%" cy="34%" r="70%">
          <stop offset="0" stopColor="#ebf6dc" />
          <stop offset=".55" stopColor="#dcecc8" />
          <stop offset=".85" stopColor="#cddcb4" />
          <stop offset="1" stopColor="#b9c89a" />
        </radialGradient>
        <radialGradient id={`${uid}g`} cx="40%" cy="35%" r="75%">
          <stop offset="0" stopColor="#3b8e5c" />
          <stop offset=".55" stopColor="#2a7a4a" />
          <stop offset="1" stopColor="#175331" />
        </radialGradient>
        <linearGradient id={`${uid}l`} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#155030" />
          <stop offset=".45" stopColor="#2a7a4a" />
          <stop offset="1" stopColor="#358a57" />
        </linearGradient>
        <linearGradient id={`${uid}r`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#155030" />
          <stop offset=".45" stopColor="#2a7a4a" />
          <stop offset="1" stopColor="#3a8f5e" />
        </linearGradient>
        <radialGradient id={`${uid}eb`} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#10231a" />
          <stop offset="1" stopColor="#08130d" />
        </radialGradient>
        <radialGradient id={`${uid}ei`} cx="45%" cy="78%" r="70%">
          <stop offset="0" stopColor="#3fa25c" />
          <stop offset=".45" stopColor="#22743f" />
          <stop offset=".85" stopColor="#134a28" stopOpacity=".7" />
          <stop offset="1" stopColor="#0c2a17" stopOpacity="0" />
        </radialGradient>
        {clay && (
          <>
            <ClayFilter id={`${uid}cs`} depth={6.5} sheen={10} grain={0.07} />
            <ClayFilter id={`${uid}cg`} depth={4} sheen={8} grain={0.08} />
            <ClayFilter id={`${uid}ct`} depth={3} sheen={8} grain={0.07} />
          </>
        )}
        {!tiny && <>
        <filter id={`${uid}b`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
        <filter id={`${uid}b2`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        </>}
      </defs>

      <ellipse className="claaky__shadow" cx="60" cy="121" rx="26" ry="4" filter={blur} />

      <g className="claaky__fx">
        <g className="claaky__bubble claaky__bubble--code">
          <rect x="92" y="64" width="28" height="18" rx="9" />
          <text x="106" y="76.5">&lt;/&gt;</text>
        </g>
        <g className="claaky__bubble claaky__bubble--plan">
          <rect x="0" y="62" width="24" height="24" rx="7" />
          <path d="M5 69h3M10 69h9M5 74h3M10 74h9M5 79h3M10 79h6" />
        </g>
      </g>

      <g className="claaky__body">
        <g className="claaky__squash">
          <ellipse cx="48.5" cy="113.5" rx="9" ry="7.5" fill={skin} filter={f("ct")} />
          <ellipse cx="71.5" cy="113.5" rx="9" ry="7.5" fill={skin} filter={f("ct")} />
          <ellipse className="claaky__ao" cx="60" cy="112" rx="5" ry="6" filter={blur} />
          <path fill={skin} filter={f("cs")} d="M35 77 C25 94 30 117 60 117 C90 117 95 94 85 77 Z" />
          <path
            fill={green}
            filter={f("cg")}
            d="M49 79 C34 88 35 114 58.5 114.5 C73 115 78.5 103 72 95.5 C66.5 89.5 56.5 91.5 57 100 C49.5 99 44 90 49 79 Z"
          />
          <ellipse className="claaky__ao" cx="60" cy="80" rx="25" ry="5" filter={tiny ? undefined : `url(#${uid}b2)`} />

          <g className="claaky__head">
            <g transform="translate(38 38)">
              <g className="claaky__ear claaky__ear--l">
                <path
                  fill={`url(#${uid}l)`}
                  filter={f("cg")}
                  d="M9 7 C-6 15 -31 8 -35 -27 C-34 -31 -30 -32 -26 -31 C-10 -26 1 -14 5 -6 C8 0 10 3 9 7 Z"
                />
              </g>
            </g>
            <g transform="translate(82 38)">
              <g className="claaky__ear claaky__ear--r">
                <path
                  fill={`url(#${uid}r)`}
                  filter={f("cg")}
                  d="M-9 7 C6 15 31 8 35 -27 C34 -31 30 -32 26 -31 C10 -26 -1 -14 -5 -6 C-8 0 -10 3 -9 7 Z"
                />
              </g>
            </g>
            <g className="claaky__ball">
              <circle cx="60" cy="15.5" r="9.5" fill={green} filter={f("cg")} />
              <ellipse className="claaky__ao" cx="60" cy="24.5" rx="7" ry="1.8" filter={blur} />
            </g>
            <ellipse cx="60" cy="51" rx="35" ry="31.5" fill={skin} filter={f("cs")} />
            <g className="claaky__brows">
              <path d="M41.5 38.5 Q45.5 36.2 49.5 38" />
              <path d="M70.5 38 Q74.5 36.2 78.5 38.5" />
            </g>
            <g className="claaky__cheeks" filter={blur}>
              <ellipse cx="37" cy="63.5" rx="6" ry="4" />
              <ellipse cx="83" cy="63.5" rx="6" ry="4" />
            </g>
            <g className="claaky__eyes claaky__eyes--open">
              <g className="claaky__look">
                <Eye uid={uid} cx={46} cy={54} />
                <Eye uid={uid} cx={74} cy={54} mirror />
              </g>
            </g>
            <g className="claaky__eyes claaky__eyes--happy">
              <path d="M40 56 Q46 48 52 56" />
              <path d="M68 56 Q74 48 80 56" />
            </g>
            <g className="claaky__eyes claaky__eyes--closed">
              <path d="M40 55 Q46 59 52 55" />
              <path d="M68 55 Q74 59 80 55" />
            </g>
            <g className="claaky__mouth claaky__mouth--open">
              <path className="claaky__mouth-in" d="M53.6 65 Q60 63.8 66.4 65 Q66 74.4 60 74.4 Q54 74.4 53.6 65 Z" />
              <ellipse className="claaky__tongue" cx="60" cy="71.8" rx="4" ry="2.5" />
            </g>
            <path className="claaky__mouth claaky__mouth--smile" d="M55 66 Q60 70.5 65 66" />
            <ellipse className="claaky__mouth claaky__mouth--o claaky__mouth-in" cx="60" cy="68" rx="3.2" ry="3.8" />
            <path className="claaky__mouth claaky__mouth--flat" d="M56.5 67.5 Q60 69 63.5 67.5" />
          </g>

          {/* Stubby arms (origin = shoulder), drawn over the head so poses can reach the face. */}
          <g transform="translate(40 84)">
            <g className="claaky__arm claaky__arm--l">
              <ellipse cx="0" cy="-9" rx="7" ry="11.5" fill={skin} filter={f("ct")} />
            </g>
          </g>
          <g transform="translate(80 84)">
            <g className="claaky__arm claaky__arm--r">
              <ellipse cx="0" cy="-9" rx="7" ry="11.5" fill={skin} filter={f("ct")} />
            </g>
          </g>
        </g>
      </g>

      <g className="claaky__fx">
        <g className="claaky__dots">
          <circle cx="100" cy="40" r="2.4" />
          <circle cx="108" cy="32" r="3" />
          <circle cx="114" cy="22" r="3.6" />
        </g>
        <g className="claaky__sparks">
          <path d="M14 22 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" />
          <path d="M104 18 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 z" />
          <path d="M100 66 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2 z" />
        </g>
        <path className="claaky__sweat" d="M92 34 q5 7 0 10 q-5 -3 0 -10 z" />
        <g className="claaky__zz">
          <text x="92" y="30">z</text>
          <text x="101" y="18">z</text>
        </g>
      </g>
    </svg>
  );
});
