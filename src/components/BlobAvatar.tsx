import { useMemo } from "react";

/**
 * BlobAvatar — little organic "blob" characters used as avatars for
 * conversations and recent workspaces (design system "Soft").
 *
 * Everything is derived deterministically from `seed` (a conversation id,
 * a workspace path…): the same seed always gives the same colour, shape and
 * face, so a conversation keeps its identity across launches.
 */

type Props = {
  seed: string;
  size?: number;
  className?: string;
  /** Force a palette colour instead of the seeded one. */
  tone?: BlobTone;
};

export type BlobTone =
  | "blue"
  | "sun"
  | "indigo"
  | "rose"
  | "leaf"
  | "coral"
  | "lilac";

const TONES: BlobTone[] = ["blue", "sun", "indigo", "rose", "leaf", "coral", "lilac"];

/** Polar shape families: lobes × amplitude. */
const SHAPES: Array<{ lobes: number; amp: number }> = [
  { lobes: 0, amp: 0 }, // pebble (wobble only)
  { lobes: 5, amp: 0.13 }, // puffy star
  { lobes: 2, amp: 0.09 }, // bean
  { lobes: 3, amp: 0.07 }, // soft triangle
  { lobes: 6, amp: 0.08 }, // flower
  { lobes: 4, amp: 0.06 }, // squircle-ish
];

type Face = "sleepy" | "content" | "dots" | "grumpy" | "wink";
const FACES: Face[] = ["sleepy", "content", "dots", "grumpy", "wink"];

/** FNV-1a — small, stable, good enough for picking variants. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Smooth closed path through points sampled from a polar function. */
function blobPath(seed: number, lobes: number, amp: number): string {
  const cx = 20;
  const cy = 20.5;
  const radius = 16.2;
  const phase = ((seed % 360) * Math.PI) / 180;
  const wobblePhase = (((seed >>> 9) % 360) * Math.PI) / 180;
  const steps = 48;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const r =
      radius *
      (1 +
        amp * Math.cos(lobes * t + phase) +
        0.035 * Math.cos(2 * t + wobblePhase) +
        0.02 * Math.sin(3 * t + wobblePhase));
    // Slightly wider than tall: reads friendlier.
    pts.push([cx + r * Math.cos(t) * 1.04, cy + r * Math.sin(t) * 0.96]);
  }
  // Catmull-Rom → cubic Bézier for a smooth outline.
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

function FaceMarks({ face }: { face: Face }) {
  const common = {
    fill: "none",
    stroke: "var(--blob-face)",
    strokeWidth: 2.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (face) {
    case "sleepy":
      return (
        <g {...common}>
          <path d="M12.5 15.6h5.6M22 15.6h5.6" strokeWidth={2.6} />
          <path d="M13 19.2q2.6 3.6 5.2 0M22.2 19.2q2.6 3.6 5.2 0" />
        </g>
      );
    case "content":
      return (
        <g {...common}>
          <path d="M13 20.4q2.6-3.4 5.2 0M22.2 20.4q2.6-3.4 5.2 0" />
          <path d="M18.4 24.6q1.8 1.4 3.6 0" strokeWidth={2} />
        </g>
      );
    case "dots":
      return (
        <g>
          <circle cx="15.6" cy="19.4" r="1.9" fill="var(--blob-face)" />
          <circle cx="24.8" cy="19.4" r="1.9" fill="var(--blob-face)" />
          <path
            d="M18.3 24q1.9 1.6 3.8 0"
            {...common}
            strokeWidth={2}
          />
        </g>
      );
    case "grumpy":
      return (
        <g {...common}>
          <path d="M12.6 16.6l5.4 1.4M27.8 16.6l-5.4 1.4" strokeWidth={2.6} />
          <path d="M13.4 20.6h4.6M22.4 20.6h4.6" />
        </g>
      );
    case "wink":
    default:
      return (
        <g {...common}>
          <path d="M13 20.4q2.6-3.4 5.2 0" />
          <circle cx="25" cy="19.4" r="1.9" fill="var(--blob-face)" stroke="none" />
          <path d="M18 24.2q2.2 1.8 4.4 0" strokeWidth={2} />
        </g>
      );
  }
}

export function BlobAvatar({ seed, size = 32, className, tone }: Props) {
  const variant = useMemo(() => {
    const h = hash(seed || "claake");
    const shape = SHAPES[(h >>> 3) % SHAPES.length];
    return {
      tone: tone ?? TONES[h % TONES.length],
      face: FACES[(h >>> 7) % FACES.length],
      path: blobPath(h, shape.lobes, shape.amp),
      tilt: ((h >>> 13) % 17) - 8,
    };
  }, [seed, tone]);

  return (
    <svg
      className={className ? `blob-avatar ${className}` : "blob-avatar"}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
      data-tone={variant.tone}
    >
      <g transform={`rotate(${variant.tilt} 20 20)`}>
        <path d={variant.path} fill={`var(--blob-${variant.tone})`} />
        <FaceMarks face={variant.face} />
      </g>
    </svg>
  );
}

/** Short French relative time, iOS-list style: "maintenant", "5 min", "19 h", "hier", "3 j", "12 mars". */
export function shortRelativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "maintenant";
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "hier";
  if (days < 7) return `${days} j`;
  return new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
