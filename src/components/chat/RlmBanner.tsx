import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";

/** Tells the user where the RLM agent works and what isolation actually means. */
export function RlmBanner({
  workspacePath,
  conversationId,
}: {
  workspacePath: string;
  conversationId: string;
}) {
  const [worktree, setWorktree] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api
      .getRlmBinding(workspacePath, conversationId)
      .then((b) => alive && setWorktree(b?.worktreePath ?? null))
      .catch(() => alive && setWorktree(null));
    return () => {
      alive = false;
    };
  }, [workspacePath, conversationId]);
  if (worktree === undefined) return null;
  return (
    <div className="rlm-banner" role="note">
      <strong>RLM · confiance locale</strong>
      {worktree ? (
        <span>
          L'agent travaille dans un worktree isolé : <code title={worktree}>{worktree}</code>. Vos
          fichiers ne sont pas modifiés, mais l'agent s'exécute avec vos droits (pas de sandbox).
        </span>
      ) : (
        <span>Aucun worktree associé : cette conversation ne peut pas lancer l'agent.</span>
      )}
    </div>
  );
}
