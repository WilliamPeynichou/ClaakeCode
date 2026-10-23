import { useEffect, useState } from "react";
import type { ClaakyState } from "./Claaky";
import type { ChatViewState } from "../chat/stream";
import { latestTestRun, type TestRun } from "./claakyTestRun";

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

/**
 * Finer view for the 3D room: which tool runs, whether the agent waits for the user, how many
 * tool calls failed in the turn (a rising count triggers the "error" reaction).
 */
export type ClaakyActivity = {
  state: ClaakyState;
  tool?: string;
  awaitingUser: boolean;
  toolErrors: number;
  /** Latest real test run (bash command of a test runner). Only "running" while the turn streams. */
  testRun?: TestRun;
};

let activity: ClaakyActivity = { state: "idle", awaitingUser: false, toolErrors: 0 };
const activityListeners = new Set<(a: ClaakyActivity) => void>();

function publishClaakyActivity(next: ClaakyActivity) {
  if (
    next.state === activity.state &&
    next.tool === activity.tool &&
    next.awaitingUser === activity.awaitingUser &&
    next.toolErrors === activity.toolErrors &&
    next.testRun === activity.testRun
  ) {
    return;
  }
  activity = next;
  activityListeners.forEach((listener) => listener(next));
}

/** Subscribe without React (the 3D room runs its own frame loop). */
export function subscribeClaakyActivity(listener: (a: ClaakyActivity) => void): () => void {
  activityListeners.add(listener);
  listener(activity);
  return () => {
    activityListeners.delete(listener);
  };
}

function activityFromView(view: ChatViewState, state: ClaakyState): ClaakyActivity {
  let tool: string | undefined;
  let awaitingUser = false;
  let toolErrors = 0;
  for (const b of view.blocks) {
    if (b.kind !== "tool") continue;
    if (b.status === "error" || b.isError) toolErrors += 1;
    if (b.status === "running") {
      tool = b.name;
      if (b.name === "question" && !b.answered) awaitingUser = true;
    }
  }
  let testRun = latestTestRun(view.blocks);
  // A test left "running" by an interrupted turn must not keep the machine lit.
  if (testRun === "running" && view.status !== "streaming") testRun = undefined;
  return { state, tool, awaitingUser, toolErrors, testRun };
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
  useEffect(() => {
    if (active) publishClaakyActivity(activityFromView(view, state));
  }, [active, state, view]);
  return state;
}
