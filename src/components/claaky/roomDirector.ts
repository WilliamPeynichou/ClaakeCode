import type { ClaakyActivity } from "./claakyAgentState";
import type { TestRun } from "./claakyTestRun";

/**
 * Directs the 3D room: turns the agent activity into a sequence of Blender clips.
 *
 * Clips come from sinew/docs/Claaky3D/claaky_etats.py (exported to public/claaky3d/bureau):
 *  - loops at a place: travail_clavier (bureau), reflechir_tableau (tableau), dormir (lit), attente (centre)
 *  - one-shots at the desk: autorisation, erreur, cafe
 * There are no walks: changing place is a teleport with a short cross-fade (see `fade`),
 * which keeps the exported sheets small and the room light to run.
 *
 * Rules (docs/Claaky3D/plansClaaky3DforBlender.md, section 11):
 *  - short bursts never make him change place: a new place must stay wanted for a moment;
 *  - waiting for the user reacts at once;
 *  - sleep only after a finished turn plus SLEEP_MS of quiet, never during a silent computation.
 */
export type Place = "bureau" | "tableau" | "lit" | "centre";
export type ClipInfo = {
  planche: string;
  x: number;
  y: number;
  l: number;
  h: number;
  colonnes: number;
  images: number;
  boucle: boolean;
  lieu: Place;
  lieu_fin: Place;
};
/** Centre and radius of the test machine's screen in decor pixels (optional, from clips.json). */
export type MachineAnchor = { x: number; y: number; r: number; decor?: string };
export type ClipManifest = {
  fps: number;
  taille: number;
  decor: string;
  clips: Record<string, ClipInfo>;
  machine?: MachineAnchor;
};

/** Light shown by the test machine: steady while a run is going, short orange flash if it failed. */
export type MachineLight = { color: string; alpha: number };
/** Previous sprite fading out after a teleport. */
export type Fade = { clip: string; frame: number; start: number };

export const MACHINE_FLASH_MS = 2500;
export const FADE_MS = 320;
const MACHINE_COLOR = { running: "#b8ff8a", failed: "#ff7a4a" } as const;

type Goal = { place: Place; loop: string };

export const SLEEP_MS = 5 * 60_000;
/** How long a new place must stay wanted before he goes there. */
const SETTLE_MS: Record<Place, number> = { bureau: 900, tableau: 2500, centre: 1500, lit: 0 };
/** Minimum time spent at a place before leaving it again (except for the user). */
const DWELL_MS = 2500;
const LOOP_AT: Record<Place, string> = { bureau: "travail_clavier", tableau: "reflechir_tableau", lit: "dormir", centre: "attente" };

export class RoomDirector {
  clip = "attente";
  frame = 0;
  /** Set right after a teleport, while the old sprite fades out. */
  fade: Fade | null = null;
  private place: Place = "centre";
  private activity: ClaakyActivity = { state: "idle", awaitingUser: false, toolErrors: 0 };
  private wanted: Goal = { place: "centre", loop: "attente" };
  private wantedSince = 0;
  private arrivedAt = 0;
  private quietSince = 0;
  private finishedTurn = false;
  private queue: string[] = [];
  private testRun: TestRun | undefined = undefined;
  private flashUntil = 0;

  constructor(private manifest: ClipManifest, now: number) {
    this.wantedSince = now;
    this.arrivedAt = now;
    this.quietSince = now;
    this.clip = this.has("attente") ? "attente" : Object.keys(manifest.clips)[0];
    this.place = this.info(this.clip).lieu;
  }

  private has(name: string) {
    return name in this.manifest.clips;
  }
  private info(name: string) {
    return this.manifest.clips[name];
  }

  /** Clips that may play soon (current place loops first), for on-demand loading. */
  likelyClips(): string[] {
    const order = [this.clip, this.wanted.loop, ...Object.values(LOOP_AT), "erreur", "autorisation", "cafe"];
    return [...new Set(order)].filter((name) => this.has(name));
  }

  /** Feed the latest agent activity. */
  update(next: ClaakyActivity, now: number) {
    const prev = this.activity;
    this.activity = next;
    // Machine: driven by real transitions only, so a stale result never re-triggers a flash.
    if (next.testRun !== prev.testRun) {
      if (next.testRun === "running") this.flashUntil = 0;
      else if (prev.testRun === "running" && next.testRun === "failed") this.flashUntil = now + MACHINE_FLASH_MS;
    }
    this.testRun = next.testRun;
    if (next.toolErrors > prev.toolErrors && next.state !== "idle") this.queueOnce("erreur");
    if (next.state === "done" && prev.state !== "done") this.finishedTurn = true;
    if (next.state !== "idle" && next.state !== "done") this.finishedTurn = false;
    if (next.state !== "idle") this.quietSince = now;
    this.retarget(now);
  }

  private queueOnce(clip: string) {
    if (this.has(clip) && !this.queue.includes(clip)) this.queue.push(clip);
  }

  /** Light of the test machine at `now`, or null when it is off. */
  machineLight(now: number, machine?: MachineAnchor): MachineLight | null {
    if (!machine) return null;
    if (this.testRun === "running") {
      // Gentle breathing while the run lasts.
      const pulse = 0.75 + 0.25 * Math.sin(now / 350);
      return { color: MACHINE_COLOR.running, alpha: pulse };
    }
    if (now < this.flashUntil) {
      return { color: MACHINE_COLOR.failed, alpha: (0.9 * (this.flashUntil - now)) / MACHINE_FLASH_MS };
    }
    return null;
  }

  private goalFor(now: number): Goal {
    const a = this.activity;
    if (a.awaitingUser) return { place: "bureau", loop: "autorisation" };
    switch (a.state) {
      case "working":
      case "error":
        return { place: "bureau", loop: "travail_clavier" };
      case "thinking":
      case "planning":
        return { place: "tableau", loop: "reflechir_tableau" };
      case "sleeping":
        return { place: "lit", loop: "dormir" };
      case "done":
        return { place: "centre", loop: "attente" };
      default:
        if (this.finishedTurn && now - this.quietSince >= SLEEP_MS) return { place: "lit", loop: "dormir" };
        return { place: "centre", loop: "attente" };
    }
  }

  private retarget(now: number) {
    const goal = this.goalFor(now);
    if (goal.place !== this.wanted.place || goal.loop !== this.wanted.loop) this.wantedSince = now;
    this.wanted = goal;
  }

  /** Should he act on `wanted` now, or keep doing what he does? */
  private committed(now: number) {
    if (this.activity.awaitingUser || this.wanted.place === this.place) return true;
    if (now - this.arrivedAt < DWELL_MS) return false;
    return now - this.wantedSince >= SETTLE_MS[this.wanted.place];
  }

  private teleportDue(now: number) {
    return this.wanted.place !== this.place && this.committed(now) && this.has(this.wanted.loop);
  }

  /** Picks what plays after the current clip at the same place. */
  private next(): string {
    const clip = this.queue[0];
    if (clip) {
      this.queue.shift();
      // Reactions belong to their place; never teleport just for one.
      if (this.info(clip).lieu === this.place) return clip;
    }
    if (this.wanted.place === this.place && this.has(this.wanted.loop)) return this.wanted.loop;
    const loop = LOOP_AT[this.place];
    return this.has(loop) ? loop : this.clip;
  }

  /** Advance one animation frame. `ready(clip)` tells whether its sprite sheet is loaded. */
  step(now: number, ready: (clip: string) => boolean = () => true) {
    this.retarget(now);
    if (this.fade && now - this.fade.start >= FADE_MS) this.fade = null;
    const info = this.info(this.clip);
    const atEnd = this.frame >= info.images - 1;
    // Teleport from a loop at any frame (the fade hides the cut); a gesture finishes first unless the user waits.
    if (this.teleportDue(now) && (info.boucle || atEnd || this.activity.awaitingUser) && ready(this.wanted.loop)) {
      this.fade = { clip: this.clip, frame: this.frame, start: now };
      this.clip = this.wanted.loop;
      this.frame = 0;
      this.place = this.wanted.place;
      this.arrivedAt = now;
      return;
    }
    if (atEnd) {
      const next = this.next();
      // Sheet still loading: replay the current clip meanwhile.
      if (ready(next)) this.clip = next;
      this.frame = 0;
      return;
    }
    // A loop at the right place gives way to a wanted gesture (permission request) at once.
    if (info.boucle && this.activity.awaitingUser && this.wanted.loop !== this.clip && ready(this.wanted.loop)) {
      this.clip = this.wanted.loop;
      this.frame = 0;
      return;
    }
    this.frame += 1;
  }
}
