import { useRef, useState } from "react";

export const SLIDE_MS = 320;

/** Swipe from the left edge to go back, like a native navigation stack. */
export function useEdgeSwipe(enabled: boolean, onBack: () => void) {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      if (enabled && e.touches[0].clientX < 24) start.current = e.touches[0].clientX;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (start.current !== null) setOffset(Math.max(0, e.touches[0].clientX - start.current));
    },
    onTouchEnd: () => {
      if (start.current !== null && offset > 90) onBack();
      start.current = null;
      setOffset(0);
    },
  };
  return { offset, handlers };
}

/** A navigation stack of routes: push slides the new screen in, pop slides it away. */
export function useStack<R>(root: R) {
  const seq = useRef(0);
  const [routes, setRoutes] = useState<{ key: number; route: R }[]>([{ key: 0, route: root }]);
  const [phase, setPhase] = useState<"idle" | "enter" | "leave">("idle");

  function push(route: R) {
    seq.current += 1;
    setRoutes((current) => [...current, { key: seq.current, route }]);
    setPhase("enter");
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("idle")));
  }

  function pop() {
    if (routes.length < 2 || phase === "leave") return;
    setPhase("leave");
    window.setTimeout(() => {
      setRoutes((current) => current.slice(0, -1));
      setPhase("idle");
    }, SLIDE_MS);
  }

  /** Replaces the top route without animation (a new chat that just got its id). */
  function replace(route: R) {
    setRoutes((current) => [...current.slice(0, -1), { key: current[current.length - 1].key, route }]);
  }

  const depth = (index: number): "front" | "behind" | "away" | "hidden" => {
    const top = routes.length - 1;
    if (index === top) return index > 0 && phase !== "idle" ? "away" : "front";
    if (index === top - 1) return phase === "leave" ? "front" : "behind";
    return "hidden";
  };

  return { routes, top: routes[routes.length - 1].route, push, pop, replace, depth, leaving: phase === "leave" };
}
