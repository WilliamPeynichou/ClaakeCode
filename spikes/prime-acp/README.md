# Spike P0 — Prime Agent en sidecar (ACP + daemon)

Spike jetable du lot **P0** de `plansPrimeAgent.md` (F01). Il vérifie qu'on peut piloter
`prime-agent` comme sidecar depuis Claake Code, sans lier ses crates.

- Prime Agent : fork `WilliamPeynichou/prime-agent`, SHA `3358e0016bce7cf34a195af58bbd91a26e17d694`, version 0.9.8
- Machine : macOS Intel x86_64, rustc **1.91.1** stable (la toolchain 1.98.1 de la CI Prime n'est pas nécessaire), build release en ~9 min 30 s, binaire de 55 Mo
- Python : uv 0.12.22, CPython 3.12 géré par uv
- Scripts : Python 3.9+, stdlib uniquement. Les tests utilisent le provider scriptable `faux` : aucune clé API, aucun appel réseau LLM.

## Fichiers

| Fichier | Rôle |
|---|---|
| `acp_spike.py` | Client ACP JSON-RPC en stdio. 8 scénarios en in-process et en mode attaché au daemon. |
| `daemon_spike.py` | Client direct du protocole `prime-agent.daemon` v7 sur socket Unix. Exécute `create` → `prompt_and_wait` → `wait_for_headless_completion` → `get_rlm_children` → `kill` → `shutdown`, puis vérifie qu'aucun processus orphelin ne reste. |

## Lancer

```bash
git clone git@github.com:WilliamPeynichou/prime-agent.git /tmp/pa
cd /tmp/pa && git checkout 3358e0016bce && cargo build --release -p pa-cli
echo 'cryptography<49' > /tmp/pas-constraints.txt   # Mac Intel uniquement, voir plus bas

COMMON="--bin /tmp/pa/target/release/prime-agent --uv-dir <dossier contenant uv> \
  --env UV_PYTHON=3.12 --env UV_CACHE_DIR=/tmp/pas-uv-cache \
  --env UV_PYTHON_INSTALL_DIR=/tmp/pas-uv-python --env UV_CONSTRAINT=/tmp/pas-constraints.txt"

python3 acp_spike.py    $COMMON --report /tmp/pas-acp-report.json   # --only <scénario>, --keep
python3 daemon_spike.py $COMMON --report /tmp/pas-dmn.json
```

Les scripts isolent tout dans un bac à sable temporaire : `PRIME_AGENT_CODING_AGENT_DIR`, le socket du daemon et le venv du kernel y sont placés. Ils exportent aussi `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1` et `PI_OFFLINE=1`.

## Résultats (2 octobre)

| Scénario | Résultat | Détail |
|---|---|---|
| `inproc-basic` | ✅ | handshake ACP, stream `agent_message_chunk`, `end_turn`, `session/close` |
| `inproc-cancel` | ✅ | `session/cancel` → `stopReason: cancelled`, latence ~0 s |
| `inproc-kernel` | ✅ | kernel Python persistant : la variable reste disponible d'une cellule à l'autre. ~5 s au démarrage à froid, 0,2 s quand le venv est déjà créé |
| `inproc-spawn` | ✅ (refus attendu) | `rlm.spawn requires a daemon-backed session` |
| `daemon-basic` | ✅ | ACP attaché au daemon ; le script `faux` doit contenir `"engine":"faux"` |
| `daemon-cancel` | ✅ | annulation en 0,03 s |
| `daemon-spawn` | ❌ | `RLM ledger: invalid spawn … (depth 1)` |
| `daemon-spawn-persist` | ❌ | même erreur |
| **`daemon_spike.py`** (protocole daemon direct) | ✅ | spawn admis, enfant exécuté (`status: done`, `answerPreview: FINAL-TEXT`), `collect` OK, `kill` OK, **0 processus orphelin** |

ACP : **6/8** scénarios réussis. Protocole daemon direct : **récursion complète validée**.

### Pourquoi la récursion échoue en ACP

Au SHA épinglé, le pont ACP adossé au daemon code en dur `no_session: Some(true)` (`crates/pa-daemon/src/acp/daemon.rs:549`). La session parente n'a donc pas de fichier de session, et le ledger RLM refuse d'y rattacher un enfant. Ce n'est pas un bug de notre client : la récursion n'est pas exposée par ACP.

## Pièges rencontrés (à reprendre en P1)

1. **Chemins canoniques obligatoires.** Sur macOS, `/tmp` pointe vers `/private/tmp`. Si le `cwd` passé à `create` n'est pas canonisé avec `realpath`, l'appel échoue avec `session lease does not own append target`, et `kill` échoue aussi. Le client Rust doit canoniser tous les chemins (`cwd`, scripts, `agentDir`).
2. **`childScript`.** Sans script pour l'enfant, celui-ci n'a pas d'engine et le parent reçoit `[child-exited: no-reply …]`. Avec un vrai provider, ce paramètre est inutile, mais il reste nécessaire pour les tests E2E avec `faux`.
3. **`cryptography` ≥ 49 et Mac Intel.** Ces versions ne publient plus de wheel macOS x86_64 : uv tente alors une compilation via maturin, qui échoue. Il faut la contrainte `cryptography<49`, ou un lock du runtime, pour les builds Intel.
4. **uv n'est pas fourni par Prime.** Prime suppose que `uv` est présent dans le `PATH`. Claake Code doit embarquer uv et le pointer explicitement.
5. **Kernel.** Python ≥ 3.11 est requis, avec 12 packages par défaut. Venv par défaut : `~/.prime/agent/kernel-venv`. On peut le surcharger avec `PRIME_AGENT_KERNEL_VENV` / `PRIME_AGENT_KERNEL_PYTHON`. Claake Code doit le placer dans son propre dossier de données.
6. **Télémétrie.** Le sink PostHog est désactivé par `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1` ou `PI_OFFLINE=1`, et `DO_NOT_TRACK`/`PI_OFFLINE` ont priorité. Un miroir local `<agentDir>/telemetry.jsonl` (5 Mio, rotation) est quand même écrit : il ne quitte pas la machine, mais doit être couvert par la rétention et l'export (F28).
7. **Durée de l'enfant.** Lors du test daemon direct, l'enfant a mis ~60 s, probablement à cause du démarrage à froid de son kernel. **À mesurer en P2** : préchauffage, venv partagé.
8. **Lancement en arrière-plan.** Le daemon doit être lancé dans son propre groupe de processus (`setsid` / `start_new_session`). L'arrêt passe par la commande `shutdown`, puis par un kill du groupe en dernier recours.

## ADR P0 — décision

| # | Décision | Statut |
|---|---|---|
| 1 | **Sidecar** `prime-agent` épinglé au SHA du fork, compilé avec sa propre toolchain. Claake Code reste en Rust 1.80 et ne lie aucune crate Prime. | ✅ confirmé |
| 2 | **Chat RLM minimal (P1) en ACP** : prompt, stream, annulation et kernel persistant fonctionnent en in-process et en mode daemon. | ✅ confirmé |
| 3 | **Récursion, roster, attach/detach (P2) via le protocole daemon direct v7.** ACP ne permet pas la récursion au pin. **Recommandation** : dès P1, écrire le client Rust directement sur le protocole daemon, en gardant ACP comme mode de secours in-process. Cela évite deux mappings d'événements. | ✅ décidé |
| 4 | **Alternative écartée pour l'instant** : patcher le fork pour retirer `no_session` côté ACP. Possible, mais cela ajoute un écart avec upstream sans apporter la supervision du roster. | ⏸ reporté |
| 5 | **Credentials** injectés via l'environnement du sidecar (`ANTHROPIC_API_KEY`, etc.) depuis le stockage Claake Code ; rien n'est écrit dans la configuration Prime. | ✅ |
| 6 | **Sécurité** : aucun `request_permission` côté Prime. En P1 : worktree dédié + mode « confiance locale » affiché clairement. Plus tard : patch de permissions dans le fork (F09 b). | ✅ |
| 7 | **Packaging** : binaire `prime-agent` + `uv` embarqués, venv du kernel et `PRIME_AGENT_CODING_AGENT_DIR` sous le dossier de données de `claakecode`, télémétrie désactivée par défaut, lock Python par architecture (`cryptography<49` sur Intel). | ✅ |
| 8 | **Chemins** toujours canonisés côté client. | ✅ |

## Suite immédiate (P1)

Client Rust du protocole daemon dans `claakecode-app` :
- lancement du daemon et socket ;
- `create` / `prompt` / `abort` / `get_messages` ;
- flux d'événements vers le front ;
- chat de type « RLM » avec badge ;
- Stop ;
- worktree par défaut.

Les tests E2E réutilisent le provider `faux` (`config.script`).
