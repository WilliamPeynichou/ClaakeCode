Code map:
- L'agent doit garder à jour cette carte simple des fichiers à chaque création, suppression, renommage, déplacement ou modification.

.
├── .gitignore
├── AGENTS.md
├── Cargo.lock
├── Cargo.toml
├── claakecode-web — site vitrine statique (Vercel)
│   ├── index.html — accueil ; section #rlm « RLM chat » animée au scroll (rlmRender(p) pur, 4 scènes, repli mouvement réduit)
│   ├── styles.css — styles du site, dont le bloc .rlm-*
│   └── llms.txt — résumé pour les LLM, inclut le chat RLM
├── EDIT_FILE_HARNESS_COMPARISON.md
├── EDIT_TOOL_COMPARISON.md
├── FEATURES.md
├── GLOB_HARNESS_COMPARISON.md
├── GREP_HARNESS_COMPARISON.md
├── index.html
├── LICENSE
├── package-lock.json
├── package.json
├── plansPrimeAgent.md — plan complet par features : intégration Prime Agent, Auto Compute, Python persistant, chat RLM, mémoire/apprentissage et UI/UX
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
│   │       ├── powershell.rs
│   │       ├── prime.rs — boundary daemon Prime v7 : lifecycle Sidecar (start/stop, env minimal), mapping session_event → PrimeEvent → AgentEvent (RlmStream), create_session(_with sessionPath pour rouvrir)/set_model/run_prompt/abort_session, write_auth_file (auth.json 0600, access token seul), connexion persistante send/receive, commandes JSONL bornées, timeout, correlation, erreurs expurgées et tests (attach/événements/refus/EOF/limites)
│   │       ├── python.rs
│   │       ├── question.rs
│   │       ├── read.rs
│   │       ├── skill.rs
│   │       ├── store.rs — SQLite ; colonne harness classic/rlm (migration v10)
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
│   │       ├── websocket.rs
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
│       ├── context.rs
│       ├── conversations.rs
│       ├── git.rs
│       ├── lib.rs
│       ├── main.rs
│       ├── models.rs
│       ├── platform.rs
│       ├── providers.rs
│       ├── remote.rs
│       ├── (tests/e2e/ — e2e.config.ts, tauriMock.ts, rlm-chat.e2e.ts : tests navigateur du chat RLM (onglet RLM, état vide, Auto Compute, Stop, réouverture), `npm run test:e2e`)
│       ├── rlm.rs — commandes Tauri du chat RLM : worktree isolé par conversation, sidecar Prime, credentials partagés avec le chat de base (OAuth Anthropic/OpenAI rafraîchis par Claake + clés API), modèle (set_model), tour unique (active_turns), historique persisté, reprise via sessionPath, Stop, get_rlm_binding
│       ├── state.rs
│       ├── swarm.rs
│       ├── terminal.rs
│       ├── typesafe.rs
│       ├── tests.rs
│       ├── turns.rs
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
    │   ├── TypeSafeSettingsSection.tsx
    │   ├── SinewDesignDialog.tsx
    │   ├── SinewMark.tsx
    │   ├── Splitter.tsx
    │   ├── TerminalPanel.tsx
    │   ├── UpdateBadge.tsx
    │   ├── UpdaterLockScreen.tsx
    │   ├── Welcome.tsx
    │   ├── WindowControls.tsx
    │   ├── Workspace.tsx — inclut l'onglet actif Chat/RLM (historiques séparés par harness), création selon l'onglet et le bouton Auto Compute (chat agent → nouveau chat RLM)
    │   └── chat
    │       ├── AIThinkingBlock.tsx
    │       ├── ChatPane.tsx — props headTabs / headActions / belowHead pour les onglets et actions d'en-tête
    │       ├── ChatSurface.tsx — onglets « Chat | RLM », état vide RLM, transcript et prompt Auto Compute
    │       ├── RlmBanner.tsx — bandeau « confiance locale » du chat RLM (worktree isolé, pas de sandbox)
    │   (PythonRuntimeSection.tsx — section Settings « Python persistant » : état moteur Prime, venv, packages, redémarrage ; via get_python_runtime_status / restart_python_runtime, backend prime::inspect_python_env)
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
