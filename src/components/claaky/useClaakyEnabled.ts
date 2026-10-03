import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Claaky on/off. Persisted by the backend (it also controls the persona in the prompt), mirrored
 * in a module cache so every Claaky on screen flips together and the first paint is not delayed.
 */
let cached = true;
let loaded = false;
const listeners = new Set<(enabled: boolean) => void>();

function publish(enabled: boolean) {
  cached = enabled;
  listeners.forEach((listener) => listener(enabled));
}

async function load() {
  try {
    publish(await invoke<boolean>("get_claaky_enabled"));
  } catch {
    // Backend unavailable (browser preview): keep the default.
  }
  loaded = true;
}

export async function setClaakyEnabled(enabled: boolean) {
  publish(enabled);
  try {
    await invoke<void>("set_claaky_enabled", { enabled });
  } catch (err) {
    publish(!enabled);
    throw err;
  }
}

export function useClaakyEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached);
  useEffect(() => {
    listeners.add(setEnabled);
    if (!loaded) void load();
    else setEnabled(cached);
    return () => {
      listeners.delete(setEnabled);
    };
  }, []);
  return enabled;
}
