import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Claaky, type ClaakyState } from "../claaky/Claaky";
import {
  COMPANION_COMMANDS,
  COMPANION_EVENTS,
  type CompanionBubbleEvent,
  type CompanionStateEvent,
} from "./companionContract";
import { CompanionBubble } from "./CompanionBubble";

/** Distance (px) au-delà de laquelle un appui devient un glissement et non un clic. */
const DRAG_THRESHOLD = 4;

const VALID_STATES: ClaakyState[] = ["idle", "thinking", "working", "planning", "done", "error", "sleeping"];

function isClaakyState(value: unknown): value is ClaakyState {
  return typeof value === "string" && (VALID_STATES as string[]).includes(value);
}

function run(command: string, args?: Record<string, unknown>) {
  void invoke(command, args).catch((err) => console.error(`[companion] ${command} failed`, err));
}

/**
 * Claaky sur le bureau. Clic : la bulle se déploie sous lui (Rust choisit le côté selon la place
 * à l'écran). Glissement : déplace la fenêtre, Rust mémorise la position.
 */
export function CompanionDesk() {
  const [state, setState] = useState<ClaakyState>("idle");
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [side, setSide] = useState<"left" | "right">("left");
  /** Fondu vers opacité 0 pendant que Rust applique la nouvelle géométrie (anti-flash). */
  const [fading, setFading] = useState(false);
  const press = useRef<{ x: number; y: number; id: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSentHeight = useRef(0);

  /**
   * Hauteur de fenêtre adaptative : la bulle étant dimensionnée par son contenu (CSS
   * height: auto), on mesure ce contenu et on demande à Rust d'ajuster la fenêtre
   * (bornes et clamp à l'écran côté backend). ResizeObserver couvre messages,
   * historique, saisie multi-lignes et streaming des réponses.
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !bubbleOpen) return;
    const send = () => {
      const height = Math.ceil(el.scrollHeight);
      if (height === lastSentHeight.current) return;
      lastSentHeight.current = height;
      run(COMPANION_COMMANDS.setBubbleHeight, { height });
    };
    send();
    const observer = new ResizeObserver(() => window.requestAnimationFrame(send));
    observer.observe(el);
    return () => observer.disconnect();
  }, [bubbleOpen]);

  useEffect(() => {
    const offState = listen<CompanionStateEvent>(COMPANION_EVENTS.state, (event) => {
      if (isClaakyState(event.payload.state)) setState(event.payload.state);
    });
    const offFading = listen<CompanionBubbleEvent>(COMPANION_EVENTS.fading, () => {
      setFading(true);
    });
    const offBubble = listen<CompanionBubbleEvent>(COMPANION_EVENTS.bubbleChanged, (event) => {
      setBubbleOpen(Boolean(event.payload.open));
      if (event.payload.side) setSide(event.payload.side);
      setFading(false);
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") run(COMPANION_COMMANDS.setBubbleOpen, { open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void offState.then((off) => off());
      void offFading.then((off) => off());
      void offBubble.then((off) => off());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = press.current;
    if (!origin || origin.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD) return;
    // Le glissement natif avale le pointerup : on oublie l'appui pour ne pas ouvrir la bulle.
    press.current = null;
    void getCurrentWindow().startDragging();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = press.current;
    press.current = null;
    if (!origin || origin.id !== event.pointerId) return;
    run(COMPANION_COMMANDS.toggleBubble);
  };

  return (
    <div ref={rootRef} className="cd" data-open={bubbleOpen} data-side={side} data-fading={fading || undefined}>
      <div className="cd__dock">
        <button
          type="button"
          className="cd__claaky"
          aria-label={bubbleOpen ? "Replier Claaky" : "Déployer Claaky"}
          aria-expanded={bubbleOpen}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            press.current = null;
          }}
        >
          <Claaky state={state} size={88} />
        </button>
        <button
          type="button"
          className="cd__hide"
          aria-label="Cacher Claaky"
          title="Cacher · ⌃⌥Espace pour le rappeler"
          onClick={() => run(COMPANION_COMMANDS.hide)}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
          </svg>
        </button>
      </div>
      {bubbleOpen && (
        <div className="cd__drop">
          <CompanionBubble onClose={() => run(COMPANION_COMMANDS.setBubbleOpen, { open: false })} />
        </div>
      )}
    </div>
  );
}
