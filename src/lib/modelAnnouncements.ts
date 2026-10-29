export type ModelAnnouncement = { value: string; label: string; provider: string };
export type ModelAnnouncementState = {
  known: string[];
  pending: ModelAnnouncement[];
};

/** Keep a lifetime set of known ids: renames, removals and reappearance aren't additions. */
export function updateModelAnnouncements(
  previous: ModelAnnouncementState | null,
  baseline: readonly string[],
  visible: readonly ModelAnnouncement[],
): ModelAnnouncementState {
  const known = new Set(previous?.known ?? baseline);
  const visibleIds = new Set(visible.map((model) => model.value));
  const pending = new Map(
    (previous?.pending ?? []).filter((model) => visibleIds.has(model.value)).map((model) => [model.value, model]),
  );
  for (const model of visible) {
    if (!known.has(model.value) || pending.has(model.value)) pending.set(model.value, model);
    known.add(model.value);
  }
  return { known: [...known], pending: [...pending.values()] };
}

/** Corrupt/old browser storage is treated as an uninitialized baseline. */
export function parseModelAnnouncements(raw: string | null): ModelAnnouncementState | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (
      !value || !Array.isArray(value.known) || !value.known.every((id: unknown) => typeof id === "string") ||
      !Array.isArray(value.pending) || !value.pending.every((model: ModelAnnouncement) =>
        model && typeof model.value === "string" && typeof model.label === "string" && typeof model.provider === "string",
      )
    ) return null;
    return value;
  } catch {
    return null;
  }
}
