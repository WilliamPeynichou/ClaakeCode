import { useEffect, useState } from "react";
import type { ClaakyState } from "./Claaky";
import type { ChatViewState } from "../chat/stream";

/**
 * What the agent is doing, as Claaky shows it. ChatPane publishes it; every Claaky on screen
 * (editor greeting, chat header, Settings preview) subscribes. Pure view of the stream state:
 * nothing here can change what the agent does.
 */
let current: ClaakyState = "idle";
const listeners = new Set<(state: ClaakyState) => void>();

export function publishClaakyState(state: ClaakyState) {
  if (state === current) return;
  current = state;
  listeners.forEach((listener) => listener(state));
}

export function useClaakyAgentState(): ClaakyState {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    setState(current);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** Maps the chat stream to a pose. Order matters: an error outranks everything else. */
export function claakyStateFromView(view: ChatViewState): ClaakyState {
  if (view.status === "streaming") {
    const blocks = view.blocks;
    if (blocks.some((b) => b.kind === "tool" && b.status === "running")) return "working";
    if (blocks.some((b) => b.kind === "thinking" && b.streaming)) return "thinking";
    if (view.streamPhase === "waiting") return "planning";
    return "working";
  }
  if (view.lastError) return "error";
  return "idle";
}

const DONE_MS = 3200;

/**
 * Publishes the pose for a chat, holding "done" for a moment after a turn ends without error.
 * Returns a cleanup so only the active chat drives Claaky.
 */
export function useClaakyFromView(view: ChatViewState, active: boolean) {
  const base = claakyStateFromView(view);
  const [wasStreaming, setWasStreaming] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (view.status === "streaming") {
      setWasStreaming(true);
      setDone(false);
      return;
    }
    if (wasStreaming) {
      setWasStreaming(false);
      if (view.status === "idle" && !view.lastError) {
        setDone(true);
        const timer = window.setTimeout(() => setDone(false), DONE_MS);
        return () => window.clearTimeout(timer);
      }
    }
    return;
  }, [view.status, view.lastError, wasStreaming]);

  const state: ClaakyState = done && base === "idle" ? "done" : base;
  useEffect(() => {
    if (active) publishClaakyState(state);
  }, [active, state]);
  return state;
}
