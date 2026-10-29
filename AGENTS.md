Code map:
- `.github/workflows/release.yml` : build macOS universel sur `macos-15-intel` explicite pour contourner la saturation du parc ARM64 ; cibles Intel et Apple Silicon conservées.
- Correctif Mistral streaming : `crates/claakecode-mistral/src/wire.rs` accepte texte ou fragments structurés ; `stream.rs` sépare thinking/texte et teste les formats, outils et usages.
- Settings Skills : `src/components/SettingsPane.tsx` garde la bibliothèque et l’éditeur prioritaires, avec gestion Git repliable en pied de page ; `src/styles.css` borne son défilement indépendamment.
- Dépôts de skills Git : `crates/claakecode-app/src/skill.rs` lit l’en-tête des SKILL.md avec `serde_yaml` (`>`/`|`, repli tolérant si YAML invalide) ; `skill_repository.rs` ignore les dossiers cachés (sauf dépôt qui n’a que ça), dédoublonne les copies internes (« doublon ignoré »), et met à jour par clone neuf validé (`auto_update` par dépôt, `update_all_in`) ; tests dans `skill_repository_{tests,security_tests,update_tests}.rs` (+ recette réseau ponytail `--ignored`) et fixtures `crates/claakecode-app/tests/fixtures/ponytail/` ; tâche de fond démarrage + 6 h et commandes dans `src-tauri/src/conversations.rs` / `lib.rs` (événement `skill-repositories-updated`) ; UI (interrupteur mise à jour auto, badge, « Tout mettre à jour », notification) dans `SettingsPane.tsx`.
- Catalogue de modèles distant : `models.json` (racine, aussi embarqué dans le binaire) ; `crates/claakecode-core/src/catalog.rs` valide (niveaux de thinking limités à ceux transmis fidèlement par chaque adaptateur), fusionne (distant gagne, `hidden` masque, ordre du fichier) et sert les limites aux crates providers (secours prudent par provider) ; `crates/claakecode-app/src/model_catalog.rs` télécharge une fois par lancement (3 s, tâche de fond dans `src-tauri/src/lib.rs`) puis émet `model-catalog-updated` ; cache SQLite `model_catalog` ; UI : `src/lib/models.ts` (`applyModelCatalog`, `startModelCatalogSync`, `useModelCatalogVersion`, `fallbackModelEntry` ; thinking piloté par le catalogue) vérifié par `scripts/check-models.mjs`, bulle compagnon qui garde mode/modèle choisis, `remote/public/app.js` ; CI `.github/workflows/models-catalog.yml`.
- Popup « nouveaux modèles » : `src/lib/modelAnnouncements.ts` (état localStorage `claakecode:model-announcements:v1` : ids déjà vus + en attente, base silencieuse au 1er lancement) alimenté par `applyModelCatalog` dans `src/lib/models.ts` ; `src/components/NewModelsPopup.tsx/.css` (dialog natif, monté dans `src/App.tsx`) ; tests dans `scripts/check-models.mjs`. Le skill `add-models` est privé (`~/.claakecode/skills/add-models`), jamais dans `src-tauri/bundled-skills` (test `shipped_bundle_is_valid…`).
- L'agent doit garder à jour cette carte simple des fichiers à chaque création, suppression, renommage, déplacement ou modification.

.
├── .gitignore
├── AGENTS.md
├── Cargo.lock
├── Cargo.toml
├── docs — notes et plans (déplacés de la racine)
│   ├── model-benchmark-plan.md — feuille de route performance modèles P0 filtres/intégrité, P1 métriques/comparabilité/qualité, P2 benchmark actif sécurisé (B5) + confidentialité
│   ├── plansNouvellesFeatures.md — plan : benchmark de performance des modèles (B1–B4/B6 faits, B5 phase 2 optionnelle) + mascotte Claaky (C1–C5 faits, version 2D)
│   ├── claaky2d/ — prototype du Claaky 2D : claaky2d.js/.css (dessin + poses), preview.html (planche animée), shoot.mjs (rend claaky2d-preview.png via Playwright)
│   ├── plansPrimeAgent.md — plan complet par features : intégration Prime Agent, Auto Compute, Python persistant, chat RLM, mémoire/apprentissage et UI/UX
│   ├── EDIT_TOOL_COMPARISON.md — comparaison des outils d'édition
│   ├── EmbendingFeatures.md — plan des providers d'embeddings
│   └── FeatureProd.md — plan de développement des providers Prod
├── claakecode-web — site vitrine statique (Vercel)
│   ├── index.html — accueil ; section #rlm « RLM chat » animée au scroll (rlmRender(p, pre) pur : prélude « RLM » 3D, champ de points canvas, 5 scènes dont onglets Chat|RLM et Auto Compute, compteur roulant, tilt souris, repli mouvement réduit)
│   ├── styles.css — styles du site, dont le bloc .rlm-*
│   └── llms.txt — résumé pour les LLM, inclut le chat RLM
├── films/claaky — teaser vidéo reproductible (montre l'ancien Claaky 3D ; assets/ contient l'illustration de référence du Claaky 2D) : BRIEF.md, BEATMAP.md, film.html (three.js, window.seek(t)), probe.mjs ; probe/sheet.jpg = quatre compositions à valider avant rendu MP4
├── index.html
├── LICENSE
├── package-lock.json
├── package.json
├── README.md
├── remote
│   ├── README.md
│   ├── server.mjs
│   ├── package.json
│   └── public
│       ├── app.js
│       ├── index.html
│       ├── manifest.webmanifest
│       ├── styles.css
│       ├── sw.js
│       └── icons
│           └── icon.svg
├── refero-heroes
│   ├── errors.json
│   ├── metadata.json
│   └── screenshots
│       ├── 001-auros.png
│       ├── 002-gsap.png
│       ├── 003-your-workplace-has-the-answer-just-ask-dala-for-it.png
│       ├── 004-structured.png
│       ├── 005-jeton.png
│       ├── 006-air.png
│       ├── 007-reflect-notes.png
│       ├── 008-ditto.png
│       ├── 009-linear.png
│       └── 010-apple.png
├── test-stop.md
├── scripts
│   ├── capture-refero-heroes.mjs
│   ├── prepare-sidecars.mjs
│   └── prepare-prime-sidecar.mjs — moteur du chat RLM : compile prime-agent au SHA épinglé + uv épinglé (SHA-256 vérifié), lipo universel ; opt-in CLAAKECODE_BUNDLE_PRIME=1 ou `npm run prepare-prime`
├── spikes
│   └── prime-acp — spike P0 jetable : pilotage de prime-agent en sidecar (ACP et protocole daemon v7) et ADR
│       ├── README.md — résultats, pièges, ADR P0
│       ├── acp_spike.py — client ACP stdio, 8 scénarios (in-process et daemon)
│       └── daemon_spike.py — client direct du protocole daemon v7 : récursion RLM, collect, kill, vérification des orphelins
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── .github
│   ├── assets
│   │   ├── architecture.png
│   │   ├── harness.png
│   │   ├── hero.png
│   │   ├── modes.png
│   │   ├── screenshot.png
│   │   └── swarm.png
│   └── workflows
│       └── release.yml
├── crates
│   ├── claakecode-anthropic
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── claakecode-app
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── agent.rs
│   │       ├── agent
│   │       │   ├── assistant_message.rs
│   │       │   ├── cancel.rs
│   │       │   ├── clean_context.rs
│   │       │   ├── compaction.rs
│   │       │   ├── context.rs
│   │       │   ├── events.rs
│   │       │   ├── history.rs
│   │       │   ├── mode.rs
│   │       │   ├── tests.rs
│   │       │   ├── tool_dispatch.rs
│   │       │   ├── tool_preflight.rs
│   │       │   ├── tool_summary.rs
│   │       │   └── turn.rs
│   │       ├── bash.rs
│   │       ├── compact.rs
│   │       ├── database.rs
│   │       ├── database_tool.rs
│   │       ├── edit.rs
│   │       ├── glob.rs
│   │       ├── grep.rs
│   │       ├── image.rs
│   │       ├── lib.rs
│   │       ├── mcp.rs
│   │       ├── model_stats.rs — benchmark B1 : agrégation des `token_usage` de l'historique par harness/provider/modèle (réponses, tokens, cache via prompt_tokens normalisé, outils en erreur), export CSV, tests
│   │       ├── powershell.rs
│   │       ├── prime_memory.rs — lecture/édition/suppression atomiques du harness Prime (global + session-artifacts), tests ; commandes list/edit/delete_rlm_memory
│   │       ├── prime.rs — boundary daemon Prime v7 : lifecycle Sidecar (start/stop, env minimal), mapping session_event → PrimeEvent → AgentEvent (RlmStream), create_session(_with sessionPath pour rouvrir)/set_model/run_prompt/abort_session, write_auth_file (auth.json 0600, access token seul), connexion persistante send/receive, commandes JSONL bornées, timeout, correlation, erreurs expurgées et tests (attach/événements/refus/EOF/limites)
│   │       ├── python.rs
│   │       ├── question.rs
│   │       ├── read.rs
│   │       ├── skill.rs — outil skill + priority_skill_section : le skill « CLAAKE.md » est injecté en tête du prompt de tout agent
│   │       ├── model_turns.rs — mesures locales sans contenu, collecte run_turn (classique/sous-agents) et RLM, agrégats médians, effacement et tarifs manuels ; migration store v12
│   │       ├── store.rs — SQLite ; colonne harness classic/rlm (migration v10) ; model_stats(since_ms, harness) pour le benchmark ; table model_turns v12
│   │       ├── subagent.rs
│   │       ├── team.rs
│   │       ├── team
│   │       │   ├── agent_turns.rs
│   │       │   ├── context.rs
│   │       │   ├── descriptors.rs
│   │       │   ├── launch.rs
│   │       │   ├── live.rs
│   │       │   ├── messaging.rs
│   │       │   ├── model.rs
│   │       │   ├── render.rs
│   │       │   ├── session.rs
│   │       │   ├── status_stop.rs
│   │       │   ├── task_board.rs
│   │       │   └── tests.rs
│   │       ├── text.rs
│   │       ├── todo.rs
│   │       ├── tool_names.rs
│   │       ├── tool_run.rs
│   │       ├── typesafe.rs
│   │       ├── web.rs
│   │       ├── write.rs
│   │       └── workspace.rs
│   ├── claakecode-core
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── error.rs
│   │       ├── lib.rs
│   │       ├── message.rs
│   │       ├── model.rs
│   │       ├── provider.rs
│   │       ├── stream.rs
│   │       └── tool.rs
│   ├── claakecode-google
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── claakecode-kimi
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── claakecode-openai
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── responses_stream.rs
│   │       ├── stream.rs
│   │       ├── websocket.rs — transport OpenAI WebSocket ; erreurs HTTP avec statut, transport et message de secours si corps vide ; tests locaux de classification
│   │       └── wire.rs
│   └── claakecode-openrouter
│       ├── Cargo.toml
│       └── src
│           ├── auth.rs
│           ├── client.rs
│           ├── lib.rs
│           ├── model_info.rs
│           ├── stream.rs
│           └── wire.rs
├── src-tauri
│   ├── Cargo.toml
│   ├── binaries
│   │   └── .gitkeep
│   ├── build.rs
│   ├── tauri.sidecars.conf.json
│   ├── tauri.prime.conf.json — sidecars macOS/Linux : rg + prime-agent + uv (chat RLM)
│   ├── tauri.conf.json
│   ├── tauri.windows.conf.json
│   ├── capabilities
│   │   └── default.json
│   ├── gen
│   │   └── schemas
│   │       ├── acl-manifests.json
│   │       ├── capabilities.json
│   │       ├── desktop-schema.json
│   │       └── macOS-schema.json
│   ├── icons
│   │   ├── 128x128.png
│   │   ├── 128x128@2x.png
│   │   ├── 32x32.png
│   │   ├── 64x64.png
│   │   ├── Square107x107Logo.png
│   │   ├── Square142x142Logo.png
│   │   ├── Square150x150Logo.png
│   │   ├── Square284x284Logo.png
│   │   ├── Square30x30Logo.png
│   │   ├── Square310x310Logo.png
│   │   ├── Square44x44Logo.png
│   │   ├── Square71x71Logo.png
│   │   ├── Square89x89Logo.png
│   │   ├── StoreLogo.png
│   │   ├── icon.icns
│   │   ├── icon.ico
│   │   ├── icon.png
│   │   ├── nsis-sidebar.bmp
│   │   ├── source.svg
│   │   ├── android
│   │   │   ├── mipmap-anydpi-v26
│   │   │   │   └── ic_launcher.xml
│   │   │   ├── mipmap-hdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-mdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xxhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xxxhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   └── values
│   │   │       └── ic_launcher_background.xml
│   │   └── ios
│   │       ├── AppIcon-20x20@1x.png
│   │       ├── AppIcon-20x20@2x-1.png
│   │       ├── AppIcon-20x20@2x.png
│   │       ├── AppIcon-20x20@3x.png
│   │       ├── AppIcon-29x29@1x.png
│   │       ├── AppIcon-29x29@2x-1.png
│   │       ├── AppIcon-29x29@2x.png
│   │       ├── AppIcon-29x29@3x.png
│   │       ├── AppIcon-40x40@1x.png
│   │       ├── AppIcon-40x40@2x-1.png
│   │       ├── AppIcon-40x40@2x.png
│   │       ├── AppIcon-40x40@3x.png
│   │       ├── AppIcon-512@2x.png
│   │       ├── AppIcon-60x60@2x.png
│   │       ├── AppIcon-60x60@3x.png
│   │       ├── AppIcon-76x76@1x.png
│   │       ├── AppIcon-76x76@2x.png
│   │       └── AppIcon-83.5x83.5@2x.png
│   └── src
│               ├── benchmark.rs — benchmark actif opt-in, plafond budgétaire, arrêt et résultats séparés `active_benchmark_runs`
        ├── context.rs (poids du skill CLAAKE.md inclus)

│       ├── conversations.rs
│       ├── git.rs
│       ├── lib.rs
│       ├── main.rs
│       ├── models.rs
│       ├── platform.rs
│       ├── providers.rs
│       ├── remote.rs
│       ├── (tests/e2e/ — e2e.config.ts, tauriMock.ts, rlm-chat.e2e.ts : tests navigateur du chat RLM (onglet RLM, état vide, Auto Compute, Stop, réouverture), skill-repositories.e2e.ts : dépôts de skills (ajout ponytail 6 skills, conflit, mise à jour auto, « Tout mettre à jour », erreur réseau, suppression), `npm run test:e2e`)
│       ├── rlm.rs — commandes Tauri du chat RLM : worktree isolé par conversation, sidecar Prime, credentials partagés avec le chat de base (OAuth Anthropic/OpenAI rafraîchis par Claake + clés API), modèle (set_model), tour unique (active_turns), historique persisté, reprise via sessionPath obligatoire ; politique appendSystemPrompt native de mémoire locale/globale et refinement evidence-gated (sans fine-tuning ni moteur mémoire parallèle), Stop, get_rlm_binding
│       ├── state.rs
│               ├── stats.rs — `get_model_stats` / `get_model_usage_series` exactes par buckets / export / effacement / prix

│       ├── swarm.rs
│       ├── terminal.rs
│       ├── typesafe.rs
│       ├── tests.rs
│       ├── turns.rs (system_prompt_for_workspace : base rules CLAAKE.md en premier)
│       ├── updater.rs
│       ├── workflow.rs
│       └── workspace.rs
└── src
    ├── App.tsx
    ├── main.tsx
    ├── styles.css
    ├── types.ts
    ├── vite-env.d.ts
    ├── components
    │   ├── ConversationList.tsx — liste de la sidebar, filtrée par onglet (Chat/RLM), prop emptyLabel
    │   ├── EditorPane.tsx
    │   ├── FileTree.tsx
    │   ├── GitPanel.tsx
    │   ├── RemotePanel.tsx
    │   ├── SearchPane.tsx
    │   ├── ClaakeCodeMark.tsx
    │   ├── DatabaseSettingsSection.tsx
    │   ├── SettingsPane.tsx
│   ├── ModelStatsSection.tsx — Settings « Performance » : historique distinct des séries exactes calendaires quotidiennes/mensuelles, filtres et tarifs
│   ├── MeasuredModelTable.tsx — médianes, débit de tour, erreurs/interruption/réécriture, sous-agents et coût estimé
│   ├── ModelPricesEditor.tsx — grille de tarifs manuels par million de tokens, validation et estimation
    │   ├── TypeSafeSettingsSection.tsx
    │   ├── SinewDesignDialog.tsx
    │   ├── SinewMark.tsx
    │   ├── Splitter.tsx
    │   ├── TerminalPanel.tsx
    │   ├── UpdateBadge.tsx
    │   ├── UpdaterLockScreen.tsx
    │   ├── Welcome.tsx
    │   ├── WindowControls.tsx
    │   ├── claaky/ — compagnon Claaky : Claaky.tsx (SVG 2D d'après films/claaky/assets/image_6e11fda6-…webp : corps crème menthe, oreilles feuilles, bille, virgule au ventre, yeux anime ; volume pâte mat par calques de dégradés ≥ 48 px, aucun filtre SVG (lents sous WebKit) ; 7 poses CSS ; remplace les loaders), claakyAgentState.ts (état de l'agent → pose : working/thinking/planning/done/error), ClaakyEmpty.tsx (écran vide « Que faisons-nous ? »), ClaakySettingsSection.tsx (vignettes fixes sans éclairage, seul le grand aperçu est animé), useClaakyEnabled.ts ; claakyVisibility.ts (un IntersectionObserver et un listener visibilitychange partagés, pause hors écran/fenêtre masquée, nettoyage à la dernière désinscription) ; Claaky est mémoïsé, aucun filtre SVG nulle part, loaders <40 px : seul le rebond du corps s'anime
    │   ├── Workspace.tsx — inclut l'onglet actif Chat/RLM (historiques séparés par harness), création selon l'onglet et le bouton Auto Compute (chat agent → nouveau chat RLM)
    │   └── chat
    │       ├── AIThinkingBlock.tsx
    │       ├── ChatPane.tsx — props headTabs / headActions / belowHead pour les onglets et actions d'en-tête ; résumé benchmark dans le sélecteur pour n≥20 tours réussis
    │       ├── ChatSurface.tsx — onglets « Chat | RLM », état vide RLM, transcript et prompt Auto Compute, LEARN_PROMPT (bouton « Apprendre de ce chat »)
    │       ├── RlmBanner.tsx — bandeau « confiance locale » du chat RLM (worktree isolé, pas de sandbox)
    │   (PythonRuntimeSection.tsx — section Settings « Python persistant » : état moteur Prime, venv, packages, redémarrage, liste « Mémoire de l'agent » (portée globale/par chat, modifier, supprimer ; via list/edit/delete_rlm_memory) ; via get_python_runtime_status / restart_python_runtime, backend prime::inspect_python_env)
    │       ├── DotmSquare2.tsx
    │       ├── DotmSquare5.tsx
    │       ├── FileChangeBlock.tsx
    │       ├── Markdown.tsx
    │       ├── MermaidDiagram.tsx
    │       ├── PlanningNextMoveBlock.tsx
    │       ├── Questionnaire.tsx
    │       ├── TodoStrip.tsx
    │       ├── ToolCard.tsx
    │       ├── dotmatrix-core.tsx
    │       ├── dotmatrix-hooks.ts
    │       └── stream.ts
    ├── lib
    │   ├── databaseSettings.ts
    │   ├── fileIcon.ts
    │   ├── ipc.ts
    │   ├── language.ts
    │   ├── models.ts
    │   ├── recents.ts
    │   └── tools.ts
