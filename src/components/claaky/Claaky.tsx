import type { CSSProperties } from "react";

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

/**
 * Claaky as a small SVG sprite, drawn from the Claake logo (round head, two leaf-petals, round core). Used where a loader used to be (and as the fallback when WebGL
 * is unavailable). Motion is pure CSS on transform/opacity, so it stays cheap in long
 * histories, and it stops entirely under prefers-reduced-motion.
 */
export function Claaky({
  state = "idle",
  size = 24,
  className,
  decorative = false,
}: {
  state?: ClaakyState;
  size?: number;
  className?: string;
  /** When another element already carries the label (e.g. "Thinking"). */
  decorative?: boolean;
}) {
  return (
    <svg
      className={`claaky${className ? ` ${className}` : ""}`}
      data-state={state}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ "--claaky-size": `${size}px` } as CSSProperties}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : LABELS[state]}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <ellipse className="claaky__shadow" cx="32" cy="59" rx="16" ry="2.8" />
      <g className="claaky__bob">
        {/* Logo shapes: two leaf-petals forming a bowl, a round core, a floating round head. */}
        <path className="claaky__leaf claaky__leaf--l" d="M8 31 A24 24 0 0 0 30.6 54.8 L30.6 31 Z" />
        <path className="claaky__leaf claaky__leaf--r" d="M56 31 A24 24 0 0 1 33.4 54.8 L33.4 31 Z" />
        <circle className="claaky__belly" cx="32" cy="46" r="8.6" />
        <g className="claaky__headg">
          <circle className="claaky__head" cx="32" cy="15.5" r="10.5" />
          <ellipse className="claaky__cheek" cx="24.6" cy="18" rx="2.6" ry="1.7" />
          <ellipse className="claaky__cheek" cx="39.4" cy="18" rx="2.6" ry="1.7" />
          <g className="claaky__eyes">
            <ellipse className="claaky__eye" cx="28" cy="14" rx="1.9" ry="2.5" />
            <ellipse className="claaky__eye" cx="36" cy="14" rx="1.9" ry="2.5" />
          </g>
          <path className="claaky__lid" d="M25.8 14 H30.2 M33.8 14 H38.2" />
          <path className="claaky__mouth" d="M29.5 19.4 Q32 21.8 34.5 19.4" />
        </g>
      </g>
      <g className="claaky__fx">
        <circle className="claaky__dot claaky__dot--1" cx="49" cy="12" r="1.8" />
        <circle className="claaky__dot claaky__dot--2" cx="55" cy="18" r="1.8" />
        <circle className="claaky__dot claaky__dot--3" cx="58" cy="25" r="1.8" />
        <text className="claaky__z" x="46" y="14">z</text>
        <path className="claaky__spark" d="M52 10 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6 z" />
        <path className="claaky__drop" d="M50 18 q3 4 0 6 q-3 -2 0 -6 z" />
      </g>
    </svg>
  );
}
