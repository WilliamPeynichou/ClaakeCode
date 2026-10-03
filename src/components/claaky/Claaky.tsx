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
 * Claaky as a small SVG sprite. Used where a loader used to be (and as the fallback when WebGL
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
      <ellipse className="claaky__shadow" cx="32" cy="58" rx="15" ry="3" />
      <g className="claaky__bob">
        <g className="claaky__antenna">
          <path d="M32 15 C32 9 34 7 35 5" />
          <circle className="claaky__bulb" cx="35.5" cy="4.5" r="3" />
        </g>
        <ellipse className="claaky__foot" cx="24" cy="54" rx="5.5" ry="3" />
        <ellipse className="claaky__foot" cx="40" cy="54" rx="5.5" ry="3" />
        <ellipse className="claaky__arm claaky__arm--l" cx="12" cy="37" rx="4" ry="6.5" />
        <ellipse className="claaky__arm claaky__arm--r" cx="52" cy="37" rx="4" ry="6.5" />
        <path
          className="claaky__body"
          d="M32 13 C47 13 55 24 55 37 C55 49 46 56 32 56 C18 56 9 49 9 37 C9 24 17 13 32 13 Z"
        />
        <ellipse className="claaky__cheek" cx="19" cy="41" rx="4" ry="2.6" />
        <ellipse className="claaky__cheek" cx="45" cy="41" rx="4" ry="2.6" />
        <g className="claaky__eyes">
          <ellipse className="claaky__eye" cx="24" cy="34" rx="3.4" ry="4.4" />
          <ellipse className="claaky__eye" cx="40" cy="34" rx="3.4" ry="4.4" />
        </g>
        <path className="claaky__lid" d="M20.5 34 H27.5 M36.5 34 H43.5" />
        <path className="claaky__mouth" d="M28 44 Q32 47.5 36 44" />
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
