import type { ClaakyActivity } from "./claakyAgentState";
import type { TestRun } from "./claakyTestRun";

/**
 * Directs the 3D room: turns the agent activity into a sequence of Blender clips.
 *
 * Clips come from sinew/docs/Claaky3D/claaky_etats.py (exported to public/claaky3d/bureau):
 *  - loops at a place: travail_clavier (bureau), reflechir_tableau (tableau), dormir (lit), attente (centre)
 *  - one-shots: autorisation, erreur, cafe (bureau) · celebrer (centre)
 *  - walks: "<from>__<to>" for every pair of places
 * Every clip starts in the exact pose the previous one ends with, so any chain plays without a jump.
 *
 * Rules (docs/Claaky3D/plansClaaky3DforBlender.md, section 11):
 *  - short bursts never make him cross the room: a new place must stay wanted for a moment;
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

/** Light shown by the test machine: steady while a run is going, then a short flash for its result. */
export type MachineLight = { color: string; alpha: number };

export const MACHINE_FLASH_MS = 2500;
const MACHINE_COLOR = { running: "#b8ff8a", passed: "#7dffa0", failed: "#ff7a4a" } as const;

type Goal = { place: Place; loop: string; label: string };

export const SLEEP_MS = 5 * 60_000;
/** How long a new place must stay wanted before he walks there. */
const SETTLE_MS: Record<Place, number> = { bureau: 900, tableau: 2500, centre: 1500, lit: 0 };
/** Minimum time spent at a place before leaving it again (except for the user). */
const DWELL_MS = 2500;

const TOOL_LABELS: [RegExp, string][] = [
  [/edit|write|apply_patch|multi_edit/i, "Modifie des fichiers"],
  [/^(read|grep|glob|list|ls|search_files)/i, "Lit le projet"],
  [/bash|shell|terminal|python/i, "Lance une commande"],
  [/web_(search|fetch)|browse/i, "Cherche sur le web"],
  [/todo/i, "Organise les tâches"],
  [/team|subagent|agent/i, "Coordonne des agents"],
  [/database/i, "Interroge la base"],
  [/skill/i, "Ouvre une compétence"],
];

export function toolLabel(tool?: string): string {
  if (!tool) return "Travaille";
  for (const [re, label] of TOOL_LABELS) if (re.test(tool)) return label;
  return "Travaille";
}

export class RoomDirector {
  clip = "travail_clavier";
  frame = 0;
  label = "";
  private place: Place = "bureau";
  private activity: ClaakyActivity = { state: "idle", awaitingUser: false, toolErrors: 0 };
  private wanted: Goal = { place: "centre", loop: "attente", label: "Attend" };
  private wantedSince = 0;
  private arrivedAt = 0;
  private quietSince = 0;
  private finishedTurn = false;
  private queue: string[] = [];
  private testRun: TestRun | undefined = undefined;
  private flash: { result: "passed" | "failed"; until: number } | null = null;

  constructor(private manifest: ClipManifest, now: number) {
    this.wantedSince = now;
    this.arrivedAt = now;
    this.quietSince = now;
    this.clip = this.has("attente") ? "attente" : Object.keys(manifest.clips)[0];
    this.place = this.info(this.clip).lieu;
    this.label = "Attend";
  }

  private has(name: string) {
    return name in this.manifest.clips;
  }
  private info(name: string) {
    return this.manifest.clips[name];
  }

  /** Feed the latest agent activity. */
  update(next: ClaakyActivity, now: number) {
    const prev = this.activity;
    this.activity = next;
    // Machine: driven by real transitions only, so a stale result never re-triggers a flash.
    if (next.testRun !== prev.testRun) {
      if (next.testRun === "running") this.flash = null;
      else if (prev.testRun === "running" && (next.testRun === "passed" || next.testRun === "failed")) {
        this.flash = { result: next.testRun, until: now + MACHINE_FLASH_MS };
      }
    }
    this.testRun = next.testRun;
    if (next.toolErrors > prev.toolErrors && next.state !== "idle") this.queueOnce("erreur");
    if (next.state === "done" && prev.state !== "done") {
      this.finishedTurn = true;
      this.queueOnce("celebrer");
    }
    if (next.state !== "idle" && next.state !== "done") {
      this.finishedTurn = false;
      this.queue = this.queue.filter((clip) => clip !== "celebrer");
    }
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
    if (this.flash && now < this.flash.until) {
      const left = (this.flash.until - now) / MACHINE_FLASH_MS;
      return { color: MACHINE_COLOR[this.flash.result], alpha: 0.9 * left };
    }
    return null;
  }

  private goalFor(now: number): Goal {
    const a = this.activity;
    if (a.awaitingUser) return { place: "bureau", loop: "autorisation", label: "Attend ta réponse" };
    switch (a.state) {
      case "working":
        return {
          place: "bureau",
          loop: "travail_clavier",
          label: a.testRun === "running" ? "Lance les tests" : toolLabel(a.tool),
        };
      case "thinking":
      case "planning":
        return { place: "tableau", loop: "reflechir_tableau", label: a.state === "planning" ? "Planifie" : "Réfléchit" };
      case "error":
        return { place: "bureau", loop: "travail_clavier", label: "Une erreur est survenue" };
      case "done":
        return { place: "centre", loop: "attente", label: "Terminé" };
      case "sleeping":
        return { place: "lit", loop: "dormir", label: "Dort" };
      default:
        if (this.finishedTurn && now - this.quietSince >= SLEEP_MS) return { place: "lit", loop: "dormir", label: "Dort" };
        return { place: "centre", loop: "attente", label: "Attend" };
    }
  }

  private retarget(now: number) {
    const goal = this.goalFor(now);
    if (goal.place !== this.wanted.place || goal.loop !== this.wanted.loop) this.wantedSince = now;
    this.wanted = goal;
  }

  /** Should he act on `wanted` now, or keep doing what he does? */
  private committed(now: number) {
    const urgent = this.activity.awaitingUser || this.wanted.place === this.place;
    if (urgent) return true;
    if (now - this.arrivedAt < DWELL_MS) return false;
    return now - this.wantedSince >= SETTLE_MS[this.wanted.place];
  }

  /** Picks what plays after the current clip (or interrupts a loop). */
  private next(now: number): string {
    const loopInfo = this.info(this.clip);
    if (this.queue.length) {
      const clip = this.queue[0];
      if (this.info(clip).lieu === this.place) {
        this.queue.shift();
        return clip;
      }
      // Reaction belongs elsewhere: keep it if he is heading there, otherwise forget it
      // rather than walk across the room for it.
      if (this.info(clip).lieu !== this.wanted.place) this.queue.shift();
    }
    if (this.committed(now) && this.wanted.place !== this.place) {
      const walk = `${this.place}__${this.wanted.place}`;
      if (this.has(walk)) return walk;
    }
    if (this.wanted.place === this.place && this.has(this.wanted.loop)) return this.wanted.loop;
    // Not committed yet: keep the current place's loop.
    const fallback = { bureau: "travail_clavier", tableau: "reflechir_tableau", lit: "dormir", centre: "attente" }[this.place];
    return loopInfo.boucle && loopInfo.lieu === this.place ? this.clip : fallback;
  }

  /** Advance one animation frame. */
  step(now: number) {
    this.retarget(now);
    const info = this.info(this.clip);
    const atEnd = this.frame >= info.images - 1;
    // Leave at the loop boundary to avoid jumping from a mid-gesture pose.
    // User requests remain urgent; walks and reactions always finish.
    const leaveLoop = info.boucle && !atEnd && this.activity.awaitingUser && this.wantsChange(now);
    if (atEnd || leaveLoop) {
      const next = this.next(now);
      if (next !== this.clip || atEnd) {
        const prevPlace = this.place;
        this.clip = next;
        this.frame = 0;
        this.place = this.info(next).lieu;
        if (this.place !== prevPlace) this.arrivedAt = now;
      } else {
        this.frame += 1;
      }
    } else {
      this.frame += 1;
    }
    const cur = this.info(this.clip);
    if (!cur.boucle && cur.lieu !== cur.lieu_fin && this.frame === cur.images - 1) {
      this.place = cur.lieu_fin;
      this.arrivedAt = now;
    }
    const clipLabel: Record<string, string> = { erreur: "Un outil a échoué", celebrer: "Terminé !", cafe: "Petite pause café" };
    this.label =
      clipLabel[this.clip] ??
      (cur.lieu !== cur.lieu_fin ? "Se déplace" : this.wanted.place === this.place ? this.wanted.label : this.label);
  }

  private wantsChange(now: number) {
    if (this.queue.length && this.info(this.queue[0]).lieu === this.place) return true;
    if (this.wanted.place !== this.place) return this.committed(now);
    return this.wanted.loop !== this.clip && this.has(this.wanted.loop);
  }
}
