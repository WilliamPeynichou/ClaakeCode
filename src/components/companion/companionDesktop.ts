/**
 * Côté fenêtre principale (Claake Code) du compagnon : réception des tâches code transmises par
 * Claaky, relais de la pose de l'agent vers Claaky, et wrappers des réglages.
 * Les noms viennent de companionContract.ts ; aucun nom n'est écrit en dur ici.
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useClaakyAgentState } from "../claaky/claakyAgentState";
import {
  COMPANION_COMMANDS,
  COMPANION_EVENTS,
  DEFAULT_COMPANION_SETTINGS,
  type CompanionPendingForward,
  type CompanionSettings,
} from "./companionContract";

export function getCompanionSettings(): Promise<CompanionSettings> {
  return invoke<CompanionSettings>(COMPANION_COMMANDS.getSettings).catch(
    () => DEFAULT_COMPANION_SETTINGS,
  );
}

export function saveCompanionSettings(settings: CompanionSettings): Promise<CompanionSettings> {
  return invoke<CompanionSettings>(COMPANION_COMMANDS.saveSettings, { settings });
}

/** Affiche Claaky et ouvre sa bulle de chat (crée la fenêtre compagnon si besoin). */
export function openCompanionBubble(): Promise<void> {
  return invoke<void>(COMPANION_COMMANDS.setBubbleOpen, { open: true });
}

/**
 * Reçoit les tâches code transmises par la fenêtre compagnon. La tâche est lue dans la file
 * Rust (take), donc une seule fenêtre la consomme même si l'événement est diffusé à toutes.
 * Lue aussi au montage, pour une tâche posée pendant que l'espace de travail se chargeait.
 */
export function useCompanionTaskIntake(onTask: (task: CompanionPendingForward) => void) {
  const handlerRef = useRef(onTask);
  handlerRef.current = onTask;

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const claim = async () => {
      try {
        const task = await invoke<CompanionPendingForward | null>(
          COMPANION_COMMANDS.takePendingForward,
        );
        if (task && !disposed) handlerRef.current(task);
      } catch (err) {
        console.error("[companion] unable to take pending task", err);
      }
    };

    void claim();
    for (const eventName of [COMPANION_EVENTS.forwardTask, COMPANION_EVENTS.continueRequested]) {
      void listen(eventName, () => void claim()).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);
}

/**
 * Relaie la pose de l'agent de Claake Code vers Claaky (fenêtre compagnon). Ne publie pas à
 * l'ouverture : seul un changement d'état est envoyé.
 */
export function useCompanionStateReport() {
  const state = useClaakyAgentState();
  const lastReported = useRef<string>("idle");

  useEffect(() => {
    if (state === lastReported.current) return;
    lastReported.current = state;
    void invoke<void>(COMPANION_COMMANDS.reportState, { state }).catch(() => {
      // Compagnon désactivé ou absent : rien à afficher.
    });
  }, [state]);
}
