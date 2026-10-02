# Plan Prime Agent — intégration complète dans Claake Code

> **Statut : plan de réalisation, aucune feature décrite ici n'est encore déclarée implémentée.**
>
> **Révision v2 — décisions de chantier :** Prime est intégré comme **sidecar épinglé** (binaire `prime-agent` piloté en `--mode acp` puis via le protocole daemon), pas comme crates liées ni portage. Le **chat RLM est livré avant** le Compute du chat classique, et l'auto-compute réutilise le même moteur Prime. Voir [2.5](#25-faits-vérifiés-au-pin-et-décision-darchitecture-v2), [11.1](#111-lots-livrables) et [11.4](#114-reporté-après-la-v1). Les sections antérieures restent valables sauf mention contraire.
> Ce document consolide les décisions de la discussion et constitue le backlog de référence pour l'ensemble de l'ajout. Il remplace les découpages provisoires précédents. Les noms de nouveaux modules, types, tools et écrans sont des propositions à stabiliser pendant F01–F02, pas des API déjà disponibles.

## Sommaire

1. [Vision et périmètre](#1-vision-et-périmètre)
2. [Référence Prime Agent et stratégie de réutilisation](#2-référence-prime-agent-et-stratégie-de-réutilisation)
3. [Existant Claake Code et écarts](#3-existant-claake-code-et-écarts)
4. [Architecture cible et règles communes](#4-architecture-cible-et-règles-communes)
5. [Catalogue des features](#5-catalogue-des-features)
6. [Features détaillées](#6-features-détaillées)
7. [UI/UX détaillée et parcours](#7-uiux-détaillée-et-parcours)
8. [Stockage, mémoire et apprentissage](#8-stockage-mémoire-et-apprentissage)
9. [Contrats, lifecycle et sécurité](#9-contrats-lifecycle-et-sécurité)
10. [Carte des zones de code concernées](#10-carte-des-zones-de-code-concernées)
11. [Ordre de livraison et dépendances](#11-ordre-de-livraison-et-dépendances)
12. [Tests et définition de terminé](#12-tests-et-définition-de-terminé)
13. [Décisions ouvertes, risques et exclusions](#13-décisions-ouvertes-risques-et-exclusions)
14. [Checklist de couverture](#14-checklist-de-couverture)
15. [Sources techniques](#15-sources-techniques)

---

## 1. Vision et périmètre

### 1.1 Objectif produit

Ajouter la puissance du harness Prime Agent à Claake Code tout en conservant la simplicité et la stabilité du chat actuel.

Le produit cible comprend :

- **Chat classique** : comportement actuel, sans compute obligatoire.
- **Chat classique augmenté** : Python persistant, auto-compute et orchestration activables indépendamment selon leurs dépendances.
- **Chat RLM** : conversation directe avec un véritable agent fondé sur Prime, qui manipule son contexte et orchestre son travail principalement par code.
- **Settings Auto Compute** : configuration et supervision des environnements, profils, kernels et artefacts.
- **Settings Agent RLM** : gestion du harness, des agents, de la mémoire, du refinement, de l'autonomie et du service.
- **Mémoire conversationnelle** : l'utilisateur discute directement avec l'agent de ce qu'il sait, retient, corrige et améliore.
- **Profils spécialisés** : Général, Web, Data, Software, Science, Mathématiques et IA, au-dessus du socle partagé.

**Le chat RLM, sa mémoire et sa gestion dans les Settings font partie du périmètre final. Ils ne sont pas des extensions hypothétiques.** Le déploiement reste progressif et peut comporter des versions expérimentales.

### 1.2 Ce qui doit rester vrai

1. Les anciennes conversations restent classiques et n'acquièrent pas silencieusement de nouvelles capacités.
2. Python persistant et auto-compute sont désactivés par défaut dans le chat classique.
3. Le clic principal « Nouveau chat » et son raccourci continuent à créer un chat classique.
4. RLM est un harness, pas un cinquième mode à ajouter à Ask/Plan/Act/Goal.
5. L'activation d'une capacité autorise son usage ; elle ne démarre pas automatiquement une tâche ni une installation.
6. Les données d'une conversation, d'un projet ou d'un utilisateur ne sont pas mélangées implicitement.
7. Le RLM ne contourne pas les interdictions Claake Code. Toute différence de permission par rapport à Prime est explicite.
8. L'agent reste composable : les profils préparent son travail sans le réduire à des recettes fixes.
9. « Apprentissage » désigne ici l'évolution de la mémoire, des instructions supplémentaires et des skills, **pas l'entraînement des poids du LLM**.
10. Une limite atteinte, une reprise partielle ou une erreur ne sont jamais affichées comme une réussite.

### 1.3 Ce que signifie « comme Prime Agent »

Conserver les mécanismes distinctifs : runtime Python persistant, prompt-as-a-variable, tools programmatiques, récursion réelle, sessions résidentes, communication d'agents, skills Python, harness durable, refinement traçable, compaction, objectifs, autonomie bornée, daemon et planification.

Ne pas livrer un simple chat classique muni d'un tool Python sous l'étiquette « Prime/RLM ». La parité recherchée est **fonctionnelle et comportementale**, pas la reproduction de la TUI, du site ou de tous les services commerciaux Prime.

---

## 2. Référence Prime Agent et stratégie de réutilisation

### 2.1 Référence à figer

- Dépôt demandé : `git@github.com:WilliamPeynichou/prime-agent.git`.
- Dépôt public : `https://github.com/WilliamPeynichou/prime-agent`.
- Upstream indiqué par le fork : `PrimeIntellect-ai/prime-agent`.
- Révision observée via l'API GitHub pendant la rédaction : **`3358e0016bce7cf34a195af58bbd91a26e17d694`**.
- Cette révision est le candidat de référence ; **F01 doit vérifier tous les composants et tests à ce SHA et confirmer ou remplacer le pin avec justification**. Les sources consultées sur `main` ne constituent pas à elles seules un audit complet de ce commit.
- Licence annoncée : MIT. Conserver les notices et vérifier aussi les licences des dépendances, distributions Python et packages embarqués.

Ne jamais télécharger ou compiler `main` sans pin lors d'une release Claake Code. Stocker un manifest d'intégration : URL, SHA, version, composants repris, patchs, formats de stockage et protocoles compatibles.

### 2.2 Carte de réutilisation

| Composant Prime | Travail déjà fourni | Stratégie |
|---|---|---|
| `prime-agent-runtime/src/rlm` | REPL CPython, asyncio, host requests, bash, MCP, harness et skills côté Python | Réutiliser prioritairement ; ne pas réécrire le REPL naïvement |
| `pa-core/kernel` | Provisionnement, manager, protocoles, annulation et snapshots | Réutiliser/intégrer selon prototype ; garder les garanties et tests |
| `pa-agent` | Boucle indépendante des providers | Évaluer comme moteur RLM ; ne pas imposer la boucle classique par défaut |
| `pa-core/prompts` | Couches statiques/dynamiques et rôles RLM | Reprendre la structure et les règles, documenter les adaptations |
| `pa-core/session_engine` | Pont RLM, commandes, usage, compaction, objectifs | Reprendre les contrats et adapters |
| `pa-core/skills` | Découverte et chargement Markdown/Python | Relier au système de skills Claake Code |
| `pa-core/refinement` | Planification, classement et application du refinement | Reprendre avant de créer un mécanisme concurrent |
| `pa-core/autonomous`, `goals`, `cron` | Budgets, continuations, gates et jobs | Reprendre les politiques, adapter les commandes UI |
| `pa-daemon` | Superviseur, workers, attachement, agents enfants, journaux | Prioritaire pour récursion et continuité réelles |
| `pa-types` | Vocabulaire et protocoles | Conserver au boundary Prime si nécessaire, mapper vers IPC Claake Code |
| `pa-ai`, `pa-models` | Providers, streaming, résolution de modèles | Valider une adaptation aux providers Claake Code ; éviter deux configurations de credentials |
| `pa-tui`, `pa-cli` | Terminal et racine de composition | Ne pas porter la TUI ; le CLI peut servir de sidecar/test oracle si retenu |
| `pa-telemetry` | Schéma et sinks de télémétrie | Examiner les émissions ; aucune activation implicite d'un suivi externe |

### 2.3 Trois catégories pour chaque feature

- **Reprise** : composant Prime intégré ou porté avec origine et tests.
- **Adaptation** : raccord aux providers, permissions, UI, stockage et lifecycle Claake Code.
- **Ajout** : profils, Settings desktop, cartes et inspections propres au produit.

Un fichier repris doit conserver sa provenance. Les modifications locales sont identifiables et testées. Les identifiants wire nécessaires à la compatibilité ne sont pas renommés uniquement pour le branding.

### 2.4 Choix de composition à valider, pas à deviner

Le prototype compare :

1. Intégration des crates pertinentes avec adapters.
2. Service/sidecar Prime adapté derrière son protocole local.
3. Portage ciblé de composants, seulement si les deux premières options ne satisfont pas les contraintes.

Mesurer : compatibilité des providers, accès aux seams publics, coûts de maintenance, poids de build, toolchain/MSRV, isolation, stockage, packaging et parité. Claake Code déclare actuellement Rust `1.80` ; vérifier les exigences de Prime avant toute intégration. Ne pas augmenter la toolchain silencieusement.

**Pas de deux moteurs concurrents de kernels, de deux registres indépendants d'enfants ou de deux mémoires maîtres.** Si plusieurs expériences utilisent des engines distincts, les services partagés et les autorités de données restent explicites.

---

### 2.5 Faits vérifiés au pin et décision d'architecture (v2)

Vérifié sur un clone au SHA `3358e0016bce7cf34a195af58bbd91a26e17d694` :

| Fait | Conséquence |
|---|---|
| `pa-cli` (binaire `prime-agent`) expose `--mode text\|json\|rpc\|acp\|daemon` | Prime est pilotable par un hôte sans porter de code |
| `pa-daemon::acp` sert ACP en stdio : `session/new`, `session/prompt`, `session/cancel`, `session/close`, `session/set_config_option`, notifications `session/update` avec `_meta` | Surface suffisante pour un chat RLM minimal |
| `pa-daemon` fournit superviseur, worker par session, roster durable, attach/detach, snapshots chunkés, `agent_message`/`agent_observe`, parent-death cleanup, archivage, compaction, auto-refine, goal continuation, export | F12–F13, F22–F24 deviennent majoritairement du **raccordement** |
| Credentials lus via variables d'environnement (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`…) | Claake Code injecte les clés à l'exécution du sidecar : une seule autorité de credentials, rien dans la config Prime |
| `prime-agent-runtime` : Python `>=3.11` | Version minimale du runtime packagé |
| CI release Prime épinglée sur Rust `1.98.1` ; Claake Code déclare `rust-version = 1.80` | Lier les crates imposerait une montée de toolchain globale → **rejeté** ; le sidecar compile avec sa propre toolchain |
| Aucun `session/request_permission` trouvé dans la surface ACP | Prime agit en mode non restreint : la sécurité doit être traitée côté hôte (F09 v2) |

**Décision (à confirmer par F01) :**

1. **Sidecar Prime épinglé**, compilé dans une CI dédiée avec sa toolchain, packagé comme les autres sidecars.
2. **Fork maintenu** `WilliamPeynichou/prime-agent` + patch ledger + sync périodique ; pas de copie de fichiers épars.
3. Claake Code parle **ACP** pour le chat RLM minimal, puis le **protocole daemon** pour roster, attach/detach et récursion.
4. **Une seule autorité par donnée** : sessions, roster, harness et mémoire restent dans les stores Prime ; Claake Code ne garde que des projections reconstructibles pour l'UI.
5. **Un seul moteur** : l'auto-compute du chat classique lance une session Prime headless déléguée ; pas de seconde orchestration côté Claake.
6. Le Python persistant du chat classique réutilise le REPL `prime-agent-runtime` via un client Rust léger du protocole JSONL ; pas de réécriture du kernel.

**Résultats du spike P0** (détail et ADR : `spikes/prime-acp/README.md`) :

| Constat | Conséquence |
|---|---|
| ACP in-process et ACP attaché au daemon : prompt, stream, annulation (0,03 s) et kernel persistant fonctionnent | Le chat RLM minimal est faisable sans patch |
| La récursion **échoue en ACP** : le pont daemon code en dur `no_session: Some(true)` (`pa-daemon/src/acp/daemon.rs:549`), ce qui fait refuser l'enfant par le ledger | La récursion passe par le **protocole daemon direct v7** |
| Protocole daemon direct : spawn, exécution de l'enfant, `collect`, `kill`, sans processus orphelin | **Client Rust écrit directement sur le protocole daemon dès P1**, ACP gardé comme mode de secours |
| Les chemins doivent être canonisés (`/tmp` → `/private/tmp` sur macOS), sinon `session lease does not own append target` | Le client canonise tous les chemins |
| Prime n'installe pas `uv` ; kernel : Python ≥ 3.11 + 12 packages ; `cryptography` ≥ 49 sans wheel pour macOS Intel | Embarquer uv, lock Python par architecture |
| Télémétrie PostHog coupée par `DO_NOT_TRACK`/`PI_OFFLINE`, mais miroir local `telemetry.jsonl` toujours écrit | Défaut : désactivée ; miroir couvert par rétention et export (F28) |
| Build avec rustc 1.91.1 stable | La toolchain 1.98.1 n'est pas requise pour le sidecar |
| Démarrage à froid du kernel d'un enfant : ~60 s | Préchauffage et venv partagé à traiter en P2 |

Note : `yusAIComparaison.md` (projet similaire cité) était vide au moment de la révision v2 ; ses enseignements restent à intégrer.

## 3. Existant Claake Code et écarts

Application active : `sinew/`. Ne pas modifier le snapshot `sinew-release-claake-1.21/`.

| Existant observé | Écart pour l'ajout |
|---|---|
| `python.rs` lance un processus Python par appel, timeout 30–120 s | Kernel vivant au-delà d'un appel/tour, API de cellules et contrôle d'état |
| `TurnContext` reçoit un `PythonTool` | Le propriétaire du kernel doit survivre à la création du contexte de tour |
| Sous-agents configurés, avec enfants sans sous-agents/teams | Récursion dynamique, sessions résidentes et roster durable |
| Teams avec historiques réutilisés, coordination et verrou d'écriture pour certains tools | Pont Python, familles RLM et gestion des mutations directes Python/shell |
| Ask/Plan/Act/Goal | Harness indépendant et matrice de permissions réelle |
| Goal, compaction, nettoyage du contexte | Continuité et limites familiales compatibles avec Prime |
| `ToolSettings` filtre et contrôle les tools | Autorisations globales + préférences de conversation + dépendances |
| Store SQLite et conversations sauvegardées | Identités runtime, versions, projections, migrations et ownership |
| Catalogue de providers d'embeddings côté UI | Vérifier les services d'exécution avant réutilisation ; catalogue ≠ index fonctionnel |
| `AgentEvent` et replay des tours | Événements de kernel, agents, mémoire, service et resynchronisation |
| Composer Mode/Model/Thinking | Un contrôle Compute compact ; pas une rangée de nombreux switches |
| `ToolCard`, `ConversationList`, Settings | Cartes spécialisées, badges RLM, pages de supervision |
| Tauri, React, Tokio, Serde, rusqlite | Fondations réutilisables sans ajouter un serveur web interne pour le kernel |
| Packaging de sidecars, actuellement notamment ripgrep | Packaging du runtime, de uv/Python et du service si retenu |
| Interface remote | Exposer les états pertinents sans donner de privilèges nouveaux au client distant |

---

## 4. Architecture cible et règles communes

### 4.1 Composition

```text
Chat classique                            Chat RLM
   │                                         │
Tools Python/Auto Compute            Engine / harness fondé sur Prime
   │                                         │
   └────────── Facades de services ───────────┘
                        │
           ├── EnvironmentManager (uv / Python / packages)
           ├── KernelManager (REPL, cellules, processus)
           ├── Context / Artifact Store (références et provenance)
           ├── ToolBridge / AgentBridge (contrôles hôte)
           ├── Permissions / Budgets / Usage
           ├── Harness / Memory / Skills
           └── Events / SessionStore / Supervisor
```

Les facades sont conceptuelles : ne pas reconstruire ces modules s'ils existent déjà dans Prime. L'UI dépend des contrats, pas des internals du moteur. Le service headless ne doit pas dépendre du frontend Tauri.

### 4.2 Stack recommandée

- **Sidecar `prime-agent` épinglé** (ACP stdio puis protocole daemon) comme moteur RLM et auto-compute ; toolchain Rust propre au sidecar.
- Processus **CPython séparé** (`>=3.11`), version mineure épinglée compatible avec le runtime repris.
- REPL de Prime, basé sur `asyncio`, compilation des cellules, `contextvars` et canaux de sorties protégés.
- **Rust/Tokio**, Serde et transport local pour supervision et streaming.
- **JSONL sur pipes** pour le protocole du kernel ; transport daemon de Prime/local authentifié pour les workers si retenu.
- **uv + environnements virtuels** pour provisionnement ; runtime Python packagé avec Claake Code.
- SQLite existant pour configuration et projections ; journaux Prime conservés si autorité retenue ; fichiers pour skills, artefacts et checkpoints.
- React/Tauri pour UI/IPC. Pas de PyO3/Python embarqué comme choix par défaut.
- Pas de dépendance Jupyter obligatoire : le runtime inspecté est un REPL CPython personnalisé malgré le nom `ipython` de sa surface modèle.

### 4.3 Identités et ownership

Distinguer `workspace`, `conversation`, `agent/session`, `parent/root`, `kernel`, `environment`, `profile`, `branch`, `turn`, `cell`, `artifact`, `memoryEntry`, `refinement`, `job`.

- Un environnement de dépendances peut servir plusieurs kernels.
- Un kernel a un propriétaire clair ; pas de namespace commun implicite.
- Un profil est versionné ; une session référence la version utilisée.
- Une famille d'agents partage des plafonds, pas automatiquement des variables ni secrets.
- Les credentials restent sous contrôle du backend ; définir comment les workers les obtiennent sans les écrire dans les transcripts.

### 4.4 Configuration effective

Les autorisations administratives/globales plafonnent les capacités. Les préférences de profil/projet/conversation ne peuvent que respecter ces plafonds. Stabiliser une priorité unique pour les valeurs par défaut en F02 ; afficher les surcharges et leur origine.

Changer un paramètre d'exécution en cours est refusé, différé ou appliqué selon une règle visible. Les boutons d'arrêt restent utilisables. Les descriptions utilisateur de tools ne peuvent pas modifier leurs permissions.

---

## 5. Catalogue des features

Chaque feature ci-dessous est une unité de travail suivable, avec réalisations, UI, validation et dépendances. Les livraisons suivent le graphe de dépendances, pas simplement les numéros.

| ID | Feature | Origine principale |
|---|---|---|
| F01 | Audit, pin et prototype Prime | Reprise/adaptation |
| F02 | Contrats, configuration et migrations | Adaptation |
| F03 | Environnements Python | Reprise (bootstrap Prime)/adaptation |
| F04 | Kernel persistant et protocole | Reprise du REPL Prime + client Rust |
| F05 | Inspection des cellules et variables | Adaptation/UI sur protocole Prime |
| F06 | Contexte programmable et artefacts | Reprise/adaptation |
| F07 | Tools Compute du chat classique | Ajout |
| F08 | Pont des tools et intégrations | Adaptation |
| F09 | Permissions, isolation et sécurité | Adaptation |
| F10 | Budgets et usage familiaux | Reprise/adaptation |
| F11 | Moteur et prompt RLM Prime | Reprise |
| F12 | Superviseur et workers RLM | Reprise/adaptation |
| F13 | Récursion et communication d'agents | Reprise |
| F14 | Skills Markdown/Python | Reprise/adaptation |
| F15 | Harness durable et versions | Reprise/adaptation |
| F16 | Mémoire structurée | Reprise/adaptation |
| F17 | Recherche hybride et embeddings | Ajout compatible |
| F18 | Dialogue avec la mémoire | Adaptation/UI |
| F19 | Refinement et apprentissage | Reprise |
| F20 | Création et validation de skills | Reprise/adaptation |
| F21 | Profils spécialisés | Ajout |
| F22 | Checkpoints, compaction et branches | Reprise/adaptation |
| F23 | Objectifs, autonomie et gates | Reprise/adaptation |
| F24 | Heartbeats et planification | Reprise/adaptation |
| F25 | UX chat classique et chat RLM | Ajout |
| F26 | Settings Auto Compute | Ajout |
| F27 | Settings Agent RLM | Ajout |
| F28 | Diagnostic, export, rétention et remote | Adaptation |
| F29 | Parité, tests, performance et benchmarks | Reprise/adaptation |
| F30 | Packaging, release et maintenance upstream | Adaptation |

---

## 6. Features détaillées

### F01 — Audit, pin et prototype d'intégration Prime

**But :** prouver l'intégration avant de concevoir un moteur incompatible. **Origine :** reprise/adaptation. **Dépendances :** aucune.

**Réalisations et travail :**
- [ ] Vérifier le SHA candidat, ses README, prompts, contrats, tests, licences et requirements Python/Rust.
- [ ] Produire une matrice de parité : composant source, comportement, adaptation, test, statut et différence.
- [ ] Prototyper une cellule, une host request, un appel modèle streamé, un enfant RLM réel et sa collecte.
- [ ] Vérifier les seams publics pour provider/tool/usage/credentials ; une compatibilité théorique n'est pas suffisante.
- [ ] Tester une interruption et un détachement/réattachement.
- [ ] Comparer crates/sidecar/portage ; écrire une ADR sur le choix et les coûts.
- [ ] Fixer les sources de vérité du stockage et du roster avant migrations.
- [ ] Décider du maintien des API Python Prime, des identifiants wire et de la politique d'updates.
- [ ] Désactiver/adapter explicitement télémétrie externe et services non requis.

**UI/UX :** prévoir un futur écran Compatibilité Prime avec SHA et différences, sans promettre une parité avant tests.

**Validation :** preuve reproductible sur un parcours complet modèle → kernel → enfant → collecte, choix d'architecture documenté, aucun stub utilisé pour annoncer une feature.

### F02 — Contrats, configuration effective et migrations

**But :** introduire les concepts sans casser les conversations. **Origine :** adaptation. **Dépendances :** F01.

**Réalisations et travail :**
- [ ] Définir les types Rust/TypeScript et schémas versionnés des objets listés en 4.3.
- [ ] Ajouter harness classique/RLM aux résumés et conversations, avec défaut rétrocompatible.
- [ ] Créer settings Auto Compute/RLM et préférences de conversation/projet/profil.
- [ ] Définir résolution des permissions, budgets et capacités par un service unique.
- [ ] Adapter création, bootstrap, chargement, clone/branche, sauvegarde, suppression et estimation du contexte.
- [ ] Séparer les preferences des modèles classiques de celles du root/enfants RLM sans dupliquer les credentials.
- [ ] Définir événements séquencés, snapshots et resync sur reconnexion ; IDs idempotents pour mutations.
- [ ] Migrer transactionnellement, sauvegarder avant changements et définir compatibilité downgrade.

**UI/UX :** montrer scope, valeurs héritées, surcharges et raisons d'indisponibilité ; verrouiller les changements incompatibles pendant une tâche.

**Validation :** fixtures d'anciennes conversations chargées sans modification ; estimateur et exécution exposent les mêmes tools/prompt ; client périmé ne détruit pas un état plus récent.

### F03 — Environnements Python gérés et personnalisés

**But :** une préparation reproductible, explicite et réparable. **Origine :** bootstrap Prime adapté. **Dépendances :** F01–F02.

**Réalisations et travail :**
- [ ] Intégrer uv, une version Python compatible épinglée et le runtime distribué avec l'application.
- [ ] Gérer environnement standard, environnements dédiés et interpréteur utilisateur en mode avancé.
- [ ] Valider architecture, version, imports, runtime/protocole et packages réellement disponibles.
- [ ] Verrouiller la préparation, exposer progression/annulation et réparer une installation interrompue.
- [ ] Verrouiller les dépendances et garder manifest/hash/provenance ; vérifier les téléchargements.
- [ ] Ne pas modifier Python global ni le venv du projet sans consentement.
- [ ] Prévoir packs Data/Math/Web et dépendances optionnelles, sans prétendre qu'un pack minimal égale le catalogue Prime.
- [ ] Pour le profil de compatibilité RLM Prime, reproduire son catalogue requis ou documenter chaque différence dans prompt et matrice.
- [ ] Mettre à jour par nouvelle version/staging ; ne pas muter les dépendances d'un kernel actif.
- [ ] Gérer proxy, absence réseau, cache, chemins avec espaces et packages sans wheel compatible.

**UI/UX :** préparer/vérifier/réparer/dupliquer/supprimer ; afficher versions, packages, disque, sessions utilisatrices et redémarrage nécessaire.

**Validation :** installation propre sur trois OS ; local hors ligne après préparation ; conflit ou incompatibilité expliqué ; suppression refusée ou coordonnée si environnement utilisé.

### F04 — Kernel Python persistant et protocole robuste

**But :** reprendre le REPL Prime, pas concaténer des scripts. **Origine :** reprise ; côté Claake uniquement un client Rust du protocole JSONL (v2). **Dépendances :** F03 ; contrôles F09 pour livraison publique. Dans le chat RLM, le kernel est géré par le sidecar Prime et F04 ne sert que le chat classique.

**Réalisations et travail :**
- [ ] Démarrage paresseux d'un processus CPython par propriétaire, namespace et boucle asyncio persistants.
- [ ] Reprendre execute/interrupt/host_reply/list_names/snapshot/restore/shutdown selon version épinglée.
- [ ] Respecter handshake, correlation des IDs, done unique, ordre des cellules et erreurs strictes.
- [ ] Séparer canal protocole de stdout/stderr, y compris écritures natives et sous-processus.
- [ ] Préserver sorties sans ownership prouvable comme non attribuées, sans inventer une cellule propriétaire.
- [ ] Router host_reply et interrupt hors FIFO pour éviter deadlocks.
- [ ] Limiter frames, sortie totale, queues et débit ; backpressure avant saturation mémoire.
- [ ] Gérer top-level await, expression finale, linecache/tracebacks et tasks en arrière-plan.
- [ ] Définir ce que Stop fait aux tasks détachées ; hard-stop groupe de processus après délai si nécessaire.
- [ ] Gérer heartbeat technique, EOF, mort du propriétaire, exit, kernel zombie et expiration.

**UI/UX :** statut du kernel et état de restauration ; interruption préserve l'état si possible, arrêt forcé avertit de sa perte.

**Validation :** protocol corruption, syntax error, output flooding, cellule bloquée et Windows sync-blocked testés ; un échec de cellule ne tue pas le serveur ; pas de processus oublié.

### F05 — Inspection des cellules, variables et ressources

**But :** rendre l'exécution inspectable sans exécuter des aperçus dangereux par défaut. **Origine :** adaptation/UI. **Dépendances :** F04.

**Réalisations et travail :**
- [ ] Journal des cellules : code, dates, durée, statut, stdout/stderr, résultat et erreur.
- [ ] Inventaire des noms, types, dimensions si accessibles sans effets de bord, tailles explicitement estimées.
- [ ] Mesure mémoire processus distincte de taille des variables ; ne pas promettre un total exact via sys.getsizeof.
- [ ] Aperçus paginés/à la demande, bornés en durée et volume ; attention à repr/propriétés qui exécutent du code.
- [ ] Arbre des activités/tasks/subprocesses identifiées et diagnostics hors canal de cellule si nécessaire.
- [ ] Export de cellule/script sans rejouer automatiquement le code.
- [ ] Rafraîchissement sobre et statut « inspection indisponible pendant calcul » si le protocole ne peut répondre.

**UI/UX :** Activité/État, code repliable, copie, recherche, traces ; pas de valeurs sensibles exposées dans la liste générale.

**Validation :** objet avec repr lent ou fautif ne bloque pas l'UI ; gros tableau virtualisé ; aperçu borné ; aucune valeur envoyée par télémétrie.

### F06 — Contexte programmable, références et artefacts

**But :** rendre prompt-as-a-variable et sélection de contexte réellement utiles. **Origine :** reprise/adaptation. **Dépendances :** F04.

**Réalisations et travail :**
- [ ] Fournir références aux fichiers, pièces jointes, résultats tools, historiques et résultats enfants.
- [ ] APIs de lecture partielle, recherche, découpage, chargement dans variables et agrégation.
- [ ] Conserver source, version/hash utile, scope et vérification de fraîcheur.
- [ ] Persister rapports, tableaux, images et scripts avec manifests et liens de provenance.
- [ ] Traiter fichiers changés, référence supprimée et résultat périmé de manière explicite.
- [ ] Quantifier volume stocké vs tokens présentés au LLM ; éviter duplication parent/enfants.
- [ ] Traiter pièces jointes et vision avec capabilities du modèle ; reprendre attach_image si disponible.
- [ ] Rendu MIME avec allowlist, sanitation et chemins validés ; ne pas injecter HTML/code arbitraire dans l'UI.

**UI/UX :** sources consultables, aperçu/open/export d'artefacts, statut périmé, cartes de preuves.

**Validation :** gros corpus traité sans insertion intégrale ; synthèse sourcée ; référence d'un autre workspace refusée ; image non supportée signalée.

### F07 — Tools Compute optionnels du chat classique

**But :** bénéficier du socle sans changer de harness. **Origine :** ajout. **Dépendances :** F04–F06, F08–F10 ; F11–F12 pour auto-compute (v2 : l'auto-compute est une session Prime headless déléguée, résultat structuré rapatrié).

**Réalisations et travail :**
- [ ] Définir une surface courte : python_session, python_state, auto_compute (noms à confirmer).
- [ ] Conserver Python ponctuel et expliciter quand utiliser chaque outil.
- [ ] Auto-compute admet objectif, input refs, limites et stratégie/profile autorisés.
- [ ] Le worker retourne statut métier, synthèse, preuves, artefacts, usage et travail restant.
- [ ] Les traces intermédiaires sont inspectables mais pas toutes recopiées dans le transcript parent.
- [ ] Bloquer délégation récursive non bornée ; éviter qu'un worker auto_compute relance lui-même des auto_compute sans admission.
- [ ] Une invocation s'intègre aux annulations/events existants et ne termine pas avec un faux succès si enfant interrompu.
- [ ] Défauts off, autorisations globales et préférences locales ; aucun démarrage/installation à l'activation seule.

**UI/UX :** popover Compute, carte compacte avec détails et arrêt ; disponibilité/capacités effectives affichées.

**Validation :** chat classique off identique ; tests de résultats partiels, tool désactivé, worker en erreur et limites propagées.

### F08 — Pont des tools, providers, MCP et bases de données

**But :** réutiliser les intégrations Claake Code sans bypass. **Origine :** adaptation. **Dépendances :** F01–F02, F04.

**Réalisations et travail :**
- [ ] Adapter stream/provider/capabilities/cache/thinking/service tier/usage au moteur Prime retenu.
- [ ] Choisir une autorité de credentials ; ne pas copier les secrets dans kernel, prompts ou journaux.
- [ ] Réutiliser le dispatcher ou une facade hôte contrôlée pour opérations existantes.
- [ ] Définir wrappers compatibles pour edit/bash sans prétendre mêmes garanties si différents.
- [ ] Respecter empreintes de lecture, suivi des changements, worktrees et confirmations destructives.
- [ ] Relier MCP via la surface compatible, éviter doubles connexions/serveurs et double authentification.
- [ ] Relier accès DB en conservant read-only, confirmations, logs et limites.
- [ ] Faire passer les demandes de confirmation à l'UI ; background sans UI = pause/refus, jamais consentement inventé.
- [ ] Annuler les requêtes modèle réellement au transport, pas seulement cacher leurs sorties.

**UI/UX :** cartes et confirmations existantes réutilisées, source de l'appel visible root/enfant/cellule.

**Validation :** provider réel et mock contractuels ; MCP/DB interdits restent interdits ; confirmation valide pour la bonne opération ; pas de double credentials.

### F09 — Permissions, isolation et sécurité d'exécution

**But :** permissions vérifiables, pas des promesses dans le prompt. **Origine :** adaptation. **Dépendances :** F02, F04, F08.

**Décision v2 :** Prime n'expose pas de demande de permission ACP. Phase expérimentale = **(a)** RLM « local de confiance » confiné à un **worktree dédié par défaut**, avertissement explicite « agent non restreint », Ask/Plan RLM refusés plutôt que simulés. Ensuite **(b)** patch du fork pour émettre `session/request_permission` sur bash/edit/écritures, relayé aux confirmations Claake Code. La public beta exige (b).

**Réalisations et travail :**
- [ ] Matrice harness × mode × capacité ; Ask sans Python, délégation ou write via RLM.
- [ ] Plan : ne pas activer un environnement prétendument read-only si filesystem/process/network ne sont pas imposés.
- [ ] Deux niveaux explicites : local de confiance (permissions utilisateur) et restreint si sandbox réellement disponible/testée.
- [ ] Évaluer backend externe d'isolation pour workloads non fiables ; aucune dépendance container universelle inventée avant prototype.
- [ ] Ne pas hériter tout l'environnement process ; allowlist minimale et injection ciblée des credentials côté hôte.
- [ ] Contrôler chemins/symlinks et ownership, accès réseau, sous-processus, packages et téléchargements.
- [ ] Protéger instructions/skills/mémoire contre contenus externes promus en autorité.
- [ ] Bornes d'admission, preuve du consentement, révocation de capacité et arrêt des opérations concernées.
- [ ] Transport local authentifié, endpoints privés, protection replay et droits filesystem appropriés.
- [ ] Examiner journaux, snapshots, preview et exports comme données sensibles.

**UI/UX :** état d'isolation réel, warning local une fois par politique appropriée, différences mode expliquées avant exécution.

**Validation :** tests de bypass direct Python, chemins échappants, grants périmés, credentials et opérations destructives ; audit ciblé avant public beta.

### F10 — Budgets, usage et comptabilité des familles

**But :** travail borné réellement contrôlé par l'hôte. **Origine :** reprise/adaptation. **Dépendances :** F02, F08.

**Réalisations et travail :**
- [ ] Plafonds de durée, tokens, cellules/appels, concurrence, nombre d'enfants, profondeur, sortie et stockage.
- [ ] Limites mémoire/CPU seulement si backend capable ; afficher monitoring vs enforcement.
- [ ] Attribution root/enfants/kernels/refinement/embeddings/gates selon périmètre, sans double comptage.
- [ ] Réserver budget avant admission concurrente ; stopper nouvelles admissions puis traiter travaux actifs.
- [ ] Prix/modèles versionnés quand disponibles ; coût inconnu reste inconnu, jamais 0 artificiel.
- [ ] Définir marge de dépassement possible liée aux appels en vol ; budget comptable ≠ garantie de facture fournisseur.
- [ ] Persister compteurs à la reprise ; pas de remise à zéro par redémarrage d'un worker.
- [ ] Protocole de wrap-up borné à limite et résultat partial/budget_exhausted.

**UI/UX :** profils Économique/Standard/Personnalisé avec chiffres visibles, usage familial, raison d'arrêt et historique.

**Validation :** enfants concurrents, token stream, appels inconnu coût et crash recovery ne permettent pas bypass ; aucun succès implicite sur limite.

### F11 — Moteur RLM et prompts fondés sur Prime

**But :** le RLM est un agent réel, pas un picker décoratif. **Origine :** reprise. **Dépendances :** F01–F02, F04, F06, F08–F10.

**Réalisations et travail :**
- [ ] Intégrer l'engine/politique Prime retenu, avec surface bash/edit/ipython conforme au contrat validé.
- [ ] Reprendre instructions core/usage/opinionated/per-model si présentes à la révision retenue.
- [ ] Queue dynamique : packages disponibles, projet, skills, MCP, environnement, rôle et guidance explicite.
- [ ] Maintenir préfixe cache-stable ; digest harness séparé ; pas de données privées dans partie prétendument statique.
- [ ] Exposer API réellement opérationnelles, dont attach_image, compact, goal et refine selon lots livrés.
- [ ] Adapter Ask/Plan et afficher les différences avec le fonctionnement Prime unrestricted.
- [ ] Monter harness, profil et mémoire sans contradiction silencieuse ; base immuable pour refinement.
- [ ] Construire prompt et estimation avec le même resolver que l'exécution ; dump inspectable et sources.
- [ ] Traiter modèles sans tools/vision/thinking compatible avec refus explicite.

**UI/UX :** chat direct, inspection de prompt et capacités, disponibilité expérimentale identifiable.

**Validation :** fixtures de prompt, cache et API ; scénario qui lit contexte en variable, choisit extraits et agrège des résultats ; pas de faux enfant simulé.

### F12 — Superviseur, workers et service local

**But :** fournir l'hôte réel requis par les enfants Prime et la continuité. **Origine :** reprise/adaptation. **Dépendances :** F01–F02, F11 et socle F09–F10.

**Réalisations et travail :**
- [ ] Reprendre modèle superviseur + worker/session et registre durable selon choix F01.
- [ ] Transport attach/detach, capability negotiation, snapshot puis deltas, authentification locale.
- [ ] Root et enfants ont identité stable ; reconnexion et resync inter-fenêtres.
- [ ] Supervision avec restart/backoff ; parent death policy ; nettoyage des kernels et sous-processus.
- [ ] Processus GUI n'est pas autorité implicite du lifecycle lorsque le service est actif.
- [ ] Gestion du démarrage manuel/auto et de la continuation après fermeture, opt-in.
- [ ] Définir comportement suspend/resume OS, worker orphelin, service mort et utilisateur logout.
- [ ] Drainer/fencer avant update, coordonner arrêt propre et restauration ; pas de rollback qui duplique les tâches.
- [ ] Session sans host enfants répond par erreur explicite, pas par faux rlm.spawn réussi.

**UI/UX :** état service, lancer/arrêter/redémarrer, sessions actives et fermeture avec travail en cours.

**Validation :** child worker réel, GUI fermée sans arrêt opt-in, crash superviseur, worker recovery et arrêt global testés. Un service n'est pas une sandbox.

### F13 — Récursion, collecte et communication d'agents

**But :** reproduire l'orchestration programmable Prime. **Origine :** reprise. **Dépendances :** F11–F12, F08–F10.

**Réalisations et travail :**
- [ ] rlm.spawn/find_models/collect/list_subagents/delete_subagent/create_session/progress_note selon contrats source.
- [ ] Registre parent/enfant et profondeur durable ; modèles/thinking validés contre credentials disponibles.
- [ ] Admission asynchrone, collecte avec timeout/snapshot, statuts exacts et retained sessions.
- [ ] agent_message.send et agent_observe avec cibles et droits vérifiés ; notes bornées/throttled.
- [ ] Distinguer fin de tour, réponse à une tâche, idle résident et fin définitive d'une session.
- [ ] Politique suppression/arrêt/retain et protection des parents/siblings hors périmètre.
- [ ] Résultats référencés sans recopier toutes les traces ; usage familial et erreurs propagés.
- [ ] Accès aux sous-agents/teams existants par adaptation explicite si pertinent, sans double roster.
- [ ] Coordination des mutations ; worktrees pour branches parallèles et merge/review contrôlés.
- [ ] Mort/reprise du parent et enfants autonomes définies, pas d'orphelins accidentels.

**UI/UX :** arbre de famille, progression, modèle, profondeur, usage, inspecter/ouverture, arrêt individuel/famille.

**Validation :** fan-out/fan-in réel, erreurs sélecteurs, collecte partielle, messages, profondeur, consentement et annulation en cascade.

### F14 — Skills Markdown et packages Python

**But :** préserver la capacité exécutable de Prime et les skills existants. **Origine :** reprise/adaptation. **Dépendances :** F03, F11.

**Réalisations et travail :**
- [ ] Unifier discovery/precedence avec chemins Claake Code et scopes sans copier les mêmes skills deux fois.
- [ ] Reprendre métadonnées import/package/pyproject et contrat source Prime.
- [ ] Inventaire versionné, activation, import checks et diagnostic des skills indisponibles.
- [ ] Dépendances installées explicitement dans environnement approprié, pas Python global.
- [ ] Confiance du package/source, hash et review des installations exécutables.
- [ ] Compatibilité des skills existants ; pas de conversion forcée du Markdown vers Python.
- [ ] Les skills ne peuvent pas étendre permissions/secret scopes par leurs instructions.

**UI/UX :** réutiliser Settings Skills avec type Markdown/Python, environnement, imports, origine et versions ; lien depuis RLM.

**Validation :** import invalide non annoncé comme opérationnel ; ordre de découverte déterministe ; skill désactivé absent de l'inventaire effectif.

### F15 — Harness durable, API et versionnement

**But :** reprendre le continual harness de Prime. **Origine :** reprise/adaptation. **Dépendances :** F11, F02.

**Réalisations et travail :**
- [ ] Reprendre rlm.harness CRUD pour supplemental prompts/memories/skill descriptions/subagent specifications selon source épinglée.
- [ ] Base system prompt immuable au refinement ; personnalisation experte distincte, explicitement hors parité si remplacement.
- [ ] Scope session par défaut pour ajustements automatiques, comme la documentation Prime ; promotion projet/personnelle explicite.
- [ ] Digest compact, inventaire, revisions, history et rollback atomique.
- [ ] Détection conflit/version périmée entre UI, root et enfants.
- [ ] Autorité canonique unique entre format Prime et projections Claake Code.
- [ ] Différencier description de skill et code exécutable : changer la première n'installe pas le second.

**UI/UX :** couches prompt, suppléments, ressources et diff ; visualiser source/portée et revision active par session.

**Validation :** CRUD et rollback ne touchent jamais règles de sécurité ; digest reflète état canonique ; children ne modifient pas arbitrairement harness global.

### F16 — Mémoire structurée et provenance

**But :** connaissances persistantes explicables, pas un kernel général rempli de souvenirs. **Origine :** adaptation du harness Prime. **Dépendances :** F15.

**Réalisations et travail :**
- [ ] Modèle d'entrée : texte, type, portée, sujet/profil éventuel, statut, source, timestamps, version et expiration si applicable.
- [ ] Distinguer instruction utilisateur, préférence, observation, procédure, référence et résultat conditionnel.
- [ ] États candidate/validée/superseded/archivée/supprimée et liens de contradiction.
- [ ] Instructions explicites utilisateur traitées différemment d'inférences ou documents externes.
- [ ] Créer/corriger/oublier avec vérification de portée, concurrence et journal de mutation.
- [ ] Extraction seulement selon consentement/politique ; pas de mémorisation automatique de secrets ou datasets bruts.
- [ ] Déduplication, limites, invalidation après modification du projet et source disparue.
- [ ] Décider store canonique F01 ; index/projections suivent les mutations via mécanisme fiable.

**UI/UX :** mémoire personnelle/projet/session/profil, provenance, versions et contradictions ; mots « candidat » et « vérifié » précis.

**Validation :** aucune fuite de workspace, observation non promue en règle globale ; suppression cohérente dans mémoire active et index.

### F17 — Recherche textuelle, embeddings et retrieval

**But :** charger la bonne mémoire, pas toute la mémoire. **Origine :** ajout compatible Prime. **Dépendances :** F16 ; intégration provider F08.

**Réalisations et travail :**
- [ ] Recherche textuelle SQLite FTS5 si build disponible, ou alternative vérifiée ; filtres de portée avant résultats.
- [ ] Pipeline recherche/reclassement/déduplication/contradictions et budget tokens de retrieval.
- [ ] Embeddings optionnels : vérifier services backend, réutiliser settings/credentials existants si compatible.
- [ ] Choisir index embarqué après benchmark ; pas de serveur vectoriel obligatoire en première version.
- [ ] Conserver modèle/version/dimensions/hash du contenu avec vecteur ; rebuild explicite lors de changement.
- [ ] Cloud embeddings : consentement sur texte envoyé ; local : téléchargement et ressources explicites.
- [ ] Index reconstructible, reprises de jobs, limites/coût, mode offline et fallback lexical.
- [ ] Oubli/suppression retire aussi les vecteurs ; sauvegardes traitées selon rétention documentée.

**UI/UX :** configuration retrieval, statut index, réindexation et raisons des mémoires sélectionnées, lien vers Settings Embedding sans double configuration.

**Validation :** paraphrases, conflits, pertinence et scope ; provider indisponible n'empêche pas mémoire lexicale ; mauvais modèle/dimension détecté.

### F18 — Dialogue naturel avec la mémoire et les méthodes

**But :** dans le chat RLM, l'utilisateur parle directement à l'agent de sa mémoire et de son apprentissage. **Origine :** adaptation/UI. **Dépendances :** F11–F13, F15–F17 ; carte conversationnelle F25 livrée dans la même tranche.

**Réalisations et travail :**
- [ ] APIs inspect/search/read/create/update/forget sous contrôles hôte, sans édition libre des fichiers internes.
- [ ] Comprendre demandes de souvenir, provenance, correction, oubli et portée ; demander précision en cas d'ambiguïté.
- [ ] Répondre sur données enregistrées, distinguer contexte de conversation, état Python et mémoire durable.
- [ ] Produire résultat structuré de mutation et afficher échec réel si stockage indisponible.
- [ ] Confirmer suppressions larges/promotion globale ; permettre annulation/version rollback.
- [ ] Expliquer pourquoi une mémoire est utilisée sans exposer secrets ni prétendre montrer un raisonnement interne caché.
- [ ] Prévenir les instructions externes « mémorise ceci » de se faire passer pour une demande utilisateur.

**UI/UX :** cartes « Mémoire mise à jour » avec portée/source/Voir/Modifier/Annuler ; synchronisation Settings immédiate.

**Validation :** « retiens pnpm », « projet seulement », « corrige », « oublie », « qu'as-tu appris ? » ; pas de souvenir inventé ni d'annonce prématurée.

### F19 — Refinement et apprentissage du harness

**But :** réutiliser le travail de Prime pour des améliorations fondées sur preuves. **Origine :** reprise. **Dépendances :** F15–F18, F10.

**Réalisations et travail :**
- [ ] Reprendre planner/ranking/executor Prime et review de trajectoire du pin.
- [ ] Déclenchement manuel par dialogue/action refine ; automatique après compaction selon politique Prime validée.
- [ ] Générer petits changements evidence-backed aux suppléments, pas une réécriture de base.
- [ ] Diff, preuves, portée, justification, statut, tests/gates pertinents et rollback.
- [ ] Review humaine par défaut ; auto-apply local opt-in explicite avec limites et journal.
- [ ] Pas de généralisation automatique projet → personnel ni suppression de contraintes de sécurité.
- [ ] Détecter duplication, contradiction, régression ; empêcher boucle de refinement coûteuse.
- [ ] Conserver version du modèle et des ressources ayant produit la proposition pour audit.

**UI/UX :** amélioration proposée/acceptée/rejetée, voir diff, appliquer, ignorer, revenir en arrière ; aucun « entraînement terminé » trompeur.

**Validation :** refinement utile sur erreur prouvée, rejet sans effet, rollback, conflit concurrent, auto policy et budgets ; gain évalué, pas auto-déclaré.

### F20 — Création, test et promotion de skills

**But :** transformer les workflows récurrents en capacités contrôlées. **Origine :** reprise/adaptation du skill creator Prime. **Dépendances :** F14, F19, F09.

**Réalisations et travail :**
- [ ] Depuis la conversation, proposer skill Markdown et/ou package Python à partir d'une procédure réussie.
- [ ] Générer manifeste, documentation, exemples, deps, tests et provenance.
- [ ] Construire/tester dans environnement contrôlé sans secrets et sans effets de bord implicites.
- [ ] Review code et permissions, promotion explicite au scope projet/personnel/profil.
- [ ] Versionning, update, disable et rollback ; conserver compatibilité des anciens utilisateurs du skill.
- [ ] Distinguer refinement d'une description et installation d'un exécutable.

**UI/UX :** carte « Skill proposé », diff/code/tests, Installer/Modifier/Rejeter ; lien Settings Skills.

**Validation :** création reproduit la procédure, tests indépendants, package refusé si incomplet/non compatible ; aucun import auto de code non approuvé.

### F21 — Profils Général, Web, Data, Software, Science, Mathématiques et IA

**But :** spécialisation sans enfermer le RLM. **Origine :** ajout Claake Code. **Dépendances :** F03, F14–F16 ; F07/F11 pour utilisation.

**Réalisations et travail :**
- [ ] Manifeste versionné : description, instructions, skills, env, capacités, limites, vérificateurs et références mémoire.
- [ ] Base commune de définitions, pas héritage de variables/snapshots d'un kernel général.
- [ ] Plusieurs profils peuvent partager env compatible ; calculer compatibilité et conflits de dépendances.
- [ ] Général : JSON/texte/calcul léger ; Data : exploration/qualité/statistiques/visualisation ; Mathématiques : symbolique/numérique/vérification.
- [ ] Web : parsing/collecte autorisée, navigateur éventuel via intégrations existantes ; Software : code/tests/métriques et outils non Python si nécessaires.
- [ ] Science : unités/hypothèses/simulation/reproductibilité ; IA : évaluations/embeddings/inférence, ressources/GPU et téléchargements explicites.
- [ ] Fiches, duplication, personnalisation, import/export contrôlé et diagnostic.
- [ ] Sélection Auto parmi profils autorisés avec choix visible ; aucune installation ou privilege escalation automatique.
- [ ] Changement d'env ouvre nouveau kernel ; transfert par artefacts validés, pas copie aveugle du namespace.
- [ ] Pack de compatibilité Prime conservé ; profils additionnels ne retirent pas sa composition libre.

**UI/UX :** profil au popover Compute/runtime, fiches dans Auto Compute, dépendances et besoins matériels visibles.

**Validation :** Général/Data/Math validés d'abord, puis les quatre autres avant clôture du périmètre complet ; conflits/ressources manquantes expliqués.

### F22 — Checkpoints, reprise, compaction et branches

**But :** cohérence du contexte, du kernel et des effets de bord. **Origine :** reprise/adaptation. **Dépendances :** F04, F06, F12–F15.

**Réalisations et travail :**
- [ ] Reprendre snapshots/manifests, limites, saved/skipped/failed et compatibilité Python/runtime/deps.
- [ ] dill est exécutable et non universel : données confiance uniquement, pas imports de snapshots inconnus.
- [ ] Artefacts/JSON explicites en préférence pour données durables ; snapshots avancés opt-in.
- [ ] Journal des admissions et statuts avec crash windows traités ; pas de promesse exactly-once des effets externes.
- [ ] Reprise identifie appels/cellules dont résultat est inconnu ; vérification utilisateur au lieu de retry aveugle.
- [ ] Compaction conserve kernel vivant et réintroduit inventaire/objectif/harness nécessaires.
- [ ] Réécriture/branche : interrompre/settle la famille concernée, restaurer checkpoint cohérent ou reset explicitement.
- [ ] Restaurer état Python ne restaure pas fichiers/DB/réseau ; coordonner avec checkpoints/worktrees existants.
- [ ] Références historiques restent consultables mais marquées comme antérieures/périmées.
- [ ] Sauvegarde complète/rétention/restore testés avec ownership du service.

**UI/UX :** bannière restoration complète/partielle/absente, liste variables manquantes, décision restore/reset et avertissement side effects.

**Validation :** crash pendant effet externe, snapshots corrompus/incompatibles, réécriture ancien message, restore partiel, compaction avec agents actifs.

### F23 — Objectifs, autonomie bornée et quality gates

**But :** retrouver l'autonomie Prime sans boucle infinie. **Origine :** reprise/adaptation. **Dépendances :** F10–F13, F22.

**Réalisations et travail :**
- [ ] Objectif durable, progression, statuts active/paused/complete/failed et usage familial.
- [ ] Continuer uniquement selon policy hôte et priorités goal/autonomous/queue reprises du pin.
- [ ] Quality gates explicites (tests/vérifications), scope, résultats et retry windows.
- [ ] Distinction gate passée vs objectif global accompli ; audit du résultat avant complete.
- [ ] Pause/reprise/arrêt, consentement pour budgets augmentés et anti-stagnation.
- [ ] Unifier l'articulation avec Goal classique ; pas deux continuations qui se déclenchent simultanément.
- [ ] Gates shell exécutent du code : mêmes permissions, timeouts et risques que les tools.

**UI/UX :** objectif et usage, activité, gates inspectables, statut limite/blocage et relance contrôlée.

**Validation :** gate insuffisante ne signifie pas succès total ; budget durable, annulation, blocage, gate failure et erreur terminale testés.

### F24 — Heartbeats et tâches planifiées

**But :** travail long et réentrées contrôlées. **Origine :** reprise/adaptation. **Dépendances :** F12, F23.

**Réalisations et travail :**
- [ ] Reprendre stores/jobs/heartbeat Prime, locks et ownership.
- [ ] Créer, modifier, désactiver et supprimer ; timezone, cadence et occurrence suivante visibles.
- [ ] Politique explicite pour retard, sleep, DST, redémarrage et jobs concurrents.
- [ ] Budgets par job/famille, permissions encore valides et pas de réveil après arrêt explicite sans accord.
- [ ] Journal d'admission/idempotence ; effet externe inconnu = à vérifier, pas replay assuré sans preuve.
- [ ] Ne pas archiver/supprimer une session avec jobs actifs sans action dédiée.
- [ ] Si confirmation requise sans UI, pause job ou notification contrôlée.

**UI/UX :** Planification avec prochain passage, historique, suspendre tout et état du service nécessaire.

**Validation :** reboot/sleep/timezone, arrêt service, permissions révoquées, doubles clients et occurrence ratée testés.

### F25 — UI chat classique, création RLM et espace de travail

**But :** découvrir la puissance sans surcharger le composer. **Origine :** ajout. **Dépendances :** F02, F05–F07, F11–F13 ; sous-vues livrées avec features associées.

**UI/UX :** conserver le chat classique, proposer une création RLM explicite et révéler les détails dans un espace de travail contextuel. Les parcours et états sont spécifiés en section 7.

**Réalisations et travail :**
- [ ] Nouveau chat split-button : clic/raccourci classique, menu RLM expérimental.
- [ ] Setup court RLM : modèle compatible, environnement, limites et politique d'arrière-plan.
- [ ] Badge et metadata harness dans liste/en-tête ; nouvelle conversation pour autre harness en première version.
- [ ] Un seul Compute popover avec capacités, profil, env et limites ; runtime/autonomie adapté RLM.
- [ ] Carte Compute spécialisée, statut métier distinct de status technique ToolCard.
- [ ] Panneau Activité/Variables/Agents/Artefacts/Harness ; fermeture ne stoppe pas un travail sauf action explicite.
- [ ] Stop contextualisé et bouton urgence de famille ; confirmations reset/destruction sans gêner l'interruption rapide.
- [ ] États first-use/loading/offline/error/empty/permission/budget/recovery ; réessayer ne rejoue pas effet externe inconnu.
- [ ] Responsive aux petites fenêtres et remote, keyboard/focus/aria, reduced-motion, thèmes et virtualisation.
- [ ] Réutiliser styles existants ; extraire composants pour ne pas grossir ChatPane/Workspace monolithiquement.

**Validation :** parcours complet sans jargon requis ; classique préservé ; tous contrôles ont effet backend démontré ; pas de feature visible mais stubbed.

### F26 — Settings Auto Compute

**But :** centre de gestion des ressources partagées. **Origine :** ajout. **Dépendances :** F02–F07, F10, F21 ; implémentation incrémentale.

**Réalisations et travail :**
- [ ] Sections Général, Profils, Environnements, Sessions Python, Stockage et Diagnostics.
- [ ] Autorisations globales distinctes des défauts de nouveaux chats ; changements futurs vs sessions existantes explicites.
- [ ] Limites/capacités, installation consentie, packs/packages, réparations et état d'isolation.
- [ ] Sessions listées indépendamment du chat ouvert : propriétaire, workspace, statut, env, durée, RSS et dernière activité.
- [ ] Détails de cellules/variables/activités/artefacts/errors ; ouvrir chat, interrompre, reset, arrêter.
- [ ] Rétention/disque/purge et confirmation ; supprimer env/kernel ≠ oublier mémoire.
- [ ] Les features sensibles ne sont pas activées automatiquement par « Select all » des tools.
- [ ] Une seule autorité des settings et mêmes composants que le panneau chat.

**UI/UX :** hub de ressources avec aperçu global puis fiche détaillée, réutilisant les vues d'inspection du chat. Les paramètres et actions distinguent configuration globale, session vivante et suppression des données.

**Validation :** données live après switch conversation, dirty/save/errors cohérents, aucune action globale ambiguë, env actif protégé.

### F27 — Settings Agent RLM

**But :** gestion complète de l'agent comme demandé. **Origine :** ajout. **Dépendances :** F11–F24 ; écrans livrés avec backend correspondant.

**Réalisations et travail :**
- [ ] Configuration : activation, root/enfant models/thinking, profil/env et defaults.
- [ ] Harness : prompt layers, digest, ressources, provenance, personnalisation et versions.
- [ ] Agents/récursion : arbre, roster actif/sauvé, depth/concurrency, inspect/attach/pause/stop selon possibilités.
- [ ] Mémoire & apprentissage : scopes, entrées, sources, conflits, proposals, historique et rollback.
- [ ] Skills : liens vers gestion commune et création/test/promote.
- [ ] Autonomie : objectifs, budgets, gates et état des continuations.
- [ ] Planification : heartbeats/jobs, prochaine occurrence, history et suspension.
- [ ] Service : version/protocole, health, start/stop/restart, background/close policy.
- [ ] Compatibilité Prime : pin, composants, patchs, capacités validées et différences assumées.
- [ ] Export/import contrôlé, diagnostics et liens Auto Compute sans doubles réglages contradictoires.

**UI/UX :** navigation par domaines de gestion, listes synthétiques et détails à la demande ; liens directs depuis le chat et retour vers la conversation ou la famille concernée. La compatibilité et les différences Prime restent visibles.

**Validation :** aucune divergence entre dialogue, panneau et Settings ; capabilities expérimentales explicitement indiquées ; tous scopes et side effects visibles.

### F28 — Diagnostic, observabilité, export, rétention et remote

**But :** exploitation fiable et confidentialité. **Origine :** adaptation. **Dépendances :** F02, F04, F12 ; extension avec chaque feature.

**Réalisations et travail :**
- [ ] Health checks kernel/env/service/providers, correlation events et historique d'erreurs borné.
- [ ] Logs techniques expurgés, métriques locales de performance/usage et opt-in télémétrie si décidée.
- [ ] Aucun prompt/code/fichier/valeur mémoire/secret dans télémétrie externe par défaut.
- [ ] Export rapport/session/JSONL/artefacts/manifests, avec provenance et choix explicite des contenus sensibles.
- [ ] Archive et rétention des sessions/children/artifacts/checkpoints ; quotas par scope et purge sûre.
- [ ] Suppression retire aussi indexes/caches correspondants ; backup retention expliquée et purge configurable.
- [ ] Remote : nouveaux types d'événements/resync, affichage mobile des états, actions autorisées seulement via contrôles existants.
- [ ] Multi-fenêtres : même service et mutations concurrentes protégées ; endpoint local non accessible réseau par défaut.
- [ ] Pas de HTML/image/chemin non validé dans preview/export/import.

**UI/UX :** centre santé, diagnostic expurgé par défaut, liens vers session fautive et parcours d'assistance.

**Validation :** diagnostic sans secrets, purge n'efface pas session active, remote ne gagne pas de droits et anciens clients refusent proprement formats incompatibles.

### F29 — Parité Prime, tests E2E et benchmarks

**But :** vérifier les comportements repris et les gains réels. **Origine :** reprise/adaptation. **Dépendances :** transversal dès F01.

**Réalisations et travail :**
- [ ] Reprendre corpus/fixtures/tests pertinents de Prime ; vérifier source et adaptation au pin.
- [ ] Tests de protocole/host requests/prompts/harness/skills/roster/refinement/continuation.
- [ ] Tests différentiels déterministes sur mêmes inputs et état initial ; tests live isolés séparés.
- [ ] E2E UI desktop et remote : préparer → compute → mémoire → RLM → enfants → reprise.
- [ ] Tests sécurité, crash, concurrency, migration, filesystem et OS.
- [ ] Mesures classique/Compute/RLM avec modèle, tâche et budgets comparables ; Prime de référence si faisable.
- [ ] Inclure coût parents/enfants/retrieval/refinement, durée, succès vérifié, intervention et qualité de preuve.
- [ ] Définir corpus versionné et seuils d'acceptation avant mesures, pas après résultat.
- [ ] Ne pas exiger texte LLM identique ; parité des transitions/contrats/invariants et résultats vérifiables.
- [ ] Pas d'annonce « meilleur » ni de parité globale sans preuve de couverture.

**UI/UX :** matrice Compatibilité consultable ; tests accessibility/focus/rendering dans les thèmes existants.

**Validation :** chaque feature a scénario happy-path, refus, erreur, annulation et reprise si applicable ; différences documentées.

### F30 — Packaging, releases et maintenance upstream

**But :** distribution maintenable de composants repris. **Origine :** adaptation. **Dépendances :** F01, F03, F12, F29 ; préparé dès premières livraisons.

**Réalisations et travail :**
- [ ] Packager runtime Python/module/resources et uv/service si choix retenu, par OS/architecture supportés.
- [ ] macOS arm64/x64/universal : traiter Python natif par architecture, ne pas appliquer aveuglément lipo à une distribution Python.
- [ ] Vérifier SHA/signatures, licenses, provenance, caches, téléchargement explicite et premier lancement offline.
- [ ] CI toolchain verrouillée, Cargo.lock/Python lock cohérents, dépendances natives et baseline Linux.
- [ ] Updater coordonne drain/checkpoint/service/réattachement ; fallback explicite si env obsolète.
- [ ] Versionnage app/engine/runtime/protocole/env manifests et compatibilité migrations.
- [ ] Uninstall/disable : stopper service/jobs, expliquer conservation des données et proposer purge distincte.
- [ ] Pin upstream, patch ledger, audit de sécurité et rebase/sync périodique avec matrice de parité.
- [ ] Pas de transfert intégral de la TUI/CLI marketing ; licence/attribution disponibles dans About/notice.
- [ ] Documentation onboarding, API, troubleshooting, trust model et limitation d'apprentissage.

**Validation :** installer réel sur chaque cible, update avec tâches actives, downgrade contrôlé, uninstall sans worker orphelin et tests offline après préparation.

---

## 7. UI/UX détaillée et parcours

### 7.1 Création d'un chat

```text
[Nouveau chat] [▾]

  Chat classique
  Tools habituels et Compute facultatif

  Agent RLM                         Expérimental
  Contexte et agents orchestrés par code, fondé sur Prime Agent
```

- Clic principal et raccourci restent classiques.
- Préparation RLM : modèle disponible, environnement compatible, budget, confiance/isolation et service.
- Installation longue annulable avec étapes réelles, sans spinner indéfini.
- Conversation RLM créée avec versions/resources effectifs ; paramètres futurs ne changent pas silencieusement ses invariants.
- Pas de conversion destructive classique ↔ RLM en première livraison. Proposer « Créer un nouveau chat RLM avec une synthèse sélectionnée », avec consentement sur contenus transférés.

### 7.2 Composer et Compute

```text
[Act ▾] [Modèle ▾] [Thinking ▾] [Compute · Off ▾]

Compute — cette conversation
  Python persistant                 [off/on]
  Auto-compute                      [off/on]
  Orchestration depuis Python       [off/on]
  Profil                            Général ▾
  Limites                           Standard ▾
  Environnement                     Configurer…
  Ouvrir l'espace Compute
```

- Dans RLM : contrôle Runtime/Autonomie reprenant son état plutôt qu'un toggle qui rendrait le harness inutilisable.
- Si dépendance nécessaire, expliquer avant activation ; ne pas activer deux features sans information.
- Off veut dire capacité non disponible à l'agent, pas « processus tué et données effacées » ; options d'arrêt/reset distinctes.
- Ask rend execution indisponible côté UI et backend. Plan explique policy réellement imposée.
- L'ouverture d'un popover ferme les autres ; même look que composer__popover.
- Fenêtre réduite : compact menu, pas de labels tronqués sans tooltip/accessible name.

### 7.3 Carte de résultat

```text
Compute · Analyse des journaux                         En cours
4 cellules · 2 agents actifs · 38 s
Étape : comparaison des erreurs
[Voir les détails]                                    [Arrêter]
```

Après fin : synthèse, statut métier, preuves, artefacts, usage, travail restant. Erreur technique et résultat partiel ont rendus distincts. L'arrêt dans la carte précise worker/famille concerné.

### 7.4 Espace de travail RLM/Compute

- Vue fermée par défaut dans classique ; accessible dans RLM sans devenir obligatoire pour discuter.
- Onglets Activité, Variables, Agents, Artefacts, Harness selon capabilities.
- Header : owner/conversation, kernel/env, état, durée, RSS, usage et limites.
- Activité : cellules, stdout/stderr, traces, tasks/subprocesses et décisions d'admission.
- Agents : arbre de famille, statuses, noms/modèles/profondeur, messages et résultats consultables.
- Harness : ressources effectivement utilisées, digest et liens mémoire/refinement.
- Sauvegarder layout/onglet sans sauver valeurs sensibles dans localStorage.
- Virtualisation/chunks pour gros logs ; auto-scroll suspendu lors de lecture ; notifications groupées.
- Reset confirme perte de variables et conséquences, interruption rapide ne multiplie pas les confirmations.

### 7.5 Dialogue sur mémoire et apprentissage

Exemples de parcours à supporter :

1. « Qu'as-tu retenu de ce projet ? » → recherche réelle, scopes et sources, pas de souvenirs inventés.
2. « Retiens que ce projet utilise pnpm » → entrée projet et carte de mutation confirmée.
3. « Cette règle n'est vraie que pour les exports de ce logiciel » → correction et version précédente.
4. « Oublie cette préférence » → oubli dans source/index, politique backup expliquée si demandé.
5. « Analyse ton erreur et propose une amélioration » → refinement avec diff/preuves, pas engagement vague.
6. « Transforme cette méthode en skill Data » → proposition, tests, review et promotion explicite.

```text
Mémoire mise à jour                                  Projet
Utiliser pnpm pour ce workspace.
Source : instruction utilisateur · Version 1
[Voir] [Modifier] [Annuler]
```

```text
Amélioration proposée
Vérifier le format des dates avant l'agrégation.
Preuve : erreur de l'analyse précédente.
[Voir le diff] [Appliquer] [Ignorer]
```

Les Settings montrent les mêmes objets. « Pourquoi cette règle ? » renvoie les sources et policies observables, pas une prétendue exposition de pensées internes.

### 7.6 Accessibilité et design

Réutiliser typographie, spacing, thèmes, icônes et classes Claake Code. Ne pas redesign toute l'app. Keyboard/focus, aria labels, texte des statuts, reduced-motion et contrastes sont obligations. Les événements importants sont annoncés, pas chaque chunk stdout. Aucun badge ne dépend uniquement d'une couleur.

### 7.7 États UX obligatoires

Off, non préparé, installation en cours, prêt, occupé, attente d'enfant, attente utilisateur, offline, permissions refusées, limite, annulation, erreur, arrêté, restauration partielle, service indisponible, index incomplet et dépendance incompatible.

Chaque état indique : cause, données préservées/perdues, action sûre et conséquence. « Réessayer » ne signifie jamais rejouer automatiquement une mutation externe inconnue.

---

## 8. Stockage, mémoire et apprentissage

### 8.1 Sources de vérité

F01 fixe une ADR avant le schéma :

- **Option privilégiée si intégration Prime le permet :** conserver journaux/sessions/registre/harness canoniques Prime, indexer des projections SQLite pour UI/retrieval.
- **Alternative :** adapter vers stores Claake Code via contrats contrôlés, avec migrations et tests de comportement.

Ne pas synchroniser deux masters par écritures ad hoc. Projections rebuildables, outbox/journal fiable et version/lock utiles ; snapshots filesystem atomiques avec manifests validés.

### 8.2 Objets conceptuels

| Objet | Champs/relations requis |
|---|---|
| Environment | ID, interpréteur, arch, versions runtime/deps, manifest, confiance, état |
| Profile | ID/version, parent de définitions, skills, env requirements, permissions, limites |
| AgentSession | Root/parent, workspace/conversation/branch, profondeur, modèle, status, registry path |
| Kernel | Owner, environment revision, PID interne, state, dernier usage, checkpoint |
| Cell | Session/turn/branch, ID, source, dates, outcome, références sorties |
| Artifact | ID, path validé, type, source, hash/version, scope, rétention |
| MemoryEntry | Contenu, type, portée, statut, sources, versions, dates, expiration |
| MemoryIndex | Entry/version hash, modèle d'embeddings/version/dimension, état/rebuild |
| HarnessRevision | Base source, suppléments, digest, scope, diff, validation |
| Refinement | Trajectoire/preuves, plan/diff, statut, budget, gate/test, revision appliquée |
| SkillRevision | Source/code/doc, deps, tests, confiance, import, portée et version |
| Goal / Job | Owner, objectif/schedule, budgets, admission, états et prochaine occurrence |
| Usage / Audit | Opération, ownership familial, modèle/coût connu, mutation et résultat |

Ce tableau n'impose pas des tables SQL dupliquant les stores Prime. L'implémentation choisie précise où chaque champ fait autorité.

### 8.3 Organisation disque indicative

```text
Données utilisateur Claake Code/
├── configuration et store existant
├── prime-integration/manifest + notices + patches
├── environments/<id>/<revision>/
├── sessions/<id>/journaux et recovery
├── harness/ressources versionnées
├── skills/packages et manifests
├── artifacts/<owner>/
├── kernels/<owner>/checkpoints + manifests
├── indexes/projections reconstructibles
└── diagnostics/logs bornés
```

Les chemins réels dérivent des conventions de l'application et du format Prime retenu. Données privées hors workspace/git par défaut ; mémoire projet partageable exportée explicitement. Permissions fichiers, symlinks et sauvegardes considérés dans le threat model.

### 8.4 Circuit d'une mémoire

```text
Instruction explicite / observation / trajectoire
                 ↓
Candidate structurée + source + portée
                 ↓
Déduplication et contradictions
                 ↓
Validation selon politique
                 ↓
Commit canonique versionné
                 ↓
Indexation / digest / notification UI
```

Une instruction utilisateur explicite peut être enregistrée selon politique sans review identique à une inférence. Document web/tool result n'a pas cette autorité. Un score de similarité ou une confiance auto-déclarée ne constitue pas une preuve scientifique.

### 8.5 Retrieval et embeddings

Filtres permissions/scope → recherche lexicale/sémantique → sélection/contradictions → budget de contexte → références consultables. Le texte original reste autorité. Changement de modèle/dimension invalide ou reconstruit index ; version de l'entrée suit suppression/correction.

Le catalogue actuel d'embeddings Claake Code doit être audité pour vérifier l'exécution réelle avant intégration. Pas de serveur vectoriel distant obligatoire. Envoi cloud des textes opt-in ; modèle local implique poids/cache/mémoire à montrer séparément.

### 8.6 Apprentissage et limites

- Une mémoire conserve un fait/préférence/procédure avec conditions.
- Un refinement modifie des suppléments du harness et descriptions contrôlées.
- Un skill crée une capacité exécutée et validée.
- Un snapshot conserve une partie de l'état du travail, pas une connaissance universelle.
- Aucun entraînement LLM/LoRA/fine-tuning dans ce périmètre ; pas de poids « appris » par chaque conversation.
- L'agent ne peut pas réécrire sa sécurité, sa base immuable ou s'accorder des droits.
- La mémoire n'est pas un contexte infini ; toute lecture a un coût/budget.

### 8.7 Rétention, oubli et backup

Définir quotas et rétention par classe. Ne pas archiver une session active/job sans policy dédiée. Effacer une entrée retire digest/index/caches actifs correspondants ; historiques et backups ont politiques distinctes visibles. Ne pas garantir effacement forensic sur SSD ou chez un provider externe. Export/import contrôlés ; snapshots dill inconnus refusés ; secrets exclus par défaut, sans prétendre qu'une regex détecte tous les secrets.

---

## 9. Contrats, lifecycle et sécurité

### 9.1 API Prime à couvrir dans la matrice

- Tools modèle : bash, edit, ipython ; helpers internes à vérifier au pin.
- Kernel REPL : exécution, sorties, erreurs, done, interruption, shutdown et snapshots.
- RLM : spawn, find_models, collect, list_subagents, delete_subagent, create_session, progress_note.
- Harness CRUD ; agent_message.send ; agent_observe ; compact ; goal ; refine ; attach_image.
- Skills Markdown/Python, inventaire et packages réels.
- MCP programmatique compatible et confirmations adaptées.
- Daemon : roster, attach/detach, session workers, queue, arrêt, reprise et service health.

Ajouter des wrappers Claake Code n'autorise pas à changer silencieusement les valeurs de retour Prime. Réponses d'erreur/timeout/absence children testées.

### 9.2 États conceptuels

- Kernel : non préparé → stopped → starting → ready → executing/waiting → ready ; error/stopping/crashed/restore_partial.
- Agent : queued → running → waiting/idle → done/error/cancelled ; idle résident n'est pas destruction.
- Compute : pending/running/awaiting_user/completed/partial/blocked/cancelled/failed.
- Refinement : proposed/reviewing/accepted/applied/rejected/failed/rolled_back.
- Job : enabled/paused/running/missed/failed/deleted, selon mapping Prime retenu.

Une transition est persistée ou journalisée avant publication de succès là où sa durabilité est promise. Conserver la distinction état UI et état source Prime ; mapping explicite.

### 9.3 Sémantique des boutons d'arrêt

| Action | Effet attendu |
|---|---|
| Interrompre cellule | Stop de la cellule courante, état conservé si possible |
| Arrêter compute | Annuler le worker et sa délégation selon ownership |
| Arrêter tour RLM | Annuler requête modèle/outils du tour ; définir sort des enfants existants |
| Arrêter famille | Bloquer admissions et stopper root/enfants concernés |
| Reset kernel | Arrêt/recréation, perte variables, pas oubli de mémoire |
| Arrêter service | Politique de drain/checkpoint/stop de tous workers/jobs |
| Fermer panneau | Aucun arrêt implicite |
| Fermer application | Selon politique explicite continuer/pause/stop |
| Supprimer conversation | Stop/settle si nécessaire, traite children/jobs/artifacts selon confirmation |
| Oublier mémoire | Mutation du store mémoire/index ; pas kill du kernel |

### 9.4 Politique minimale harness/mode

| Mode | Classique augmenté | RLM |
|---|---|---|
| Ask | Compute exécutable interdit | Analyse seulement, runtime non exécutable ; pas de parité unrestricted revendiquée |
| Plan | Pas de garantie de read-only via simple prompt ; capacités dangereuses restreintes | Python seulement si isolation/policy réellement compatible, sinon refus explicite |
| Act | Capacités autorisées et consentements | Agent Prime adapté aux mêmes plafonds |
| Goal | Continuation classique contrôlée | Goal/autonomous Prime, une seule politique de continuation |

F09 doit arrêter une policy exacte pour Plan avant livraison. Une résolution UI ne remplace pas le contrôle à l'admission et à l'exécution hôte.

### 9.5 Contrats d'événements et IPC

- Événements avec owner/family/session/branch/cell ID, sequence et versions.
- Snapshot autoritaire puis deltas ; reconnect détecte trous et resync.
- Traces techniques bornées séparées du contenu modèle ; prévenir streams qui remplissent replay buffers.
- Mutations settings/mémoire/version utilisent contrôle de concurrence et IDs de commande.
- Clients remote/multi-fenêtres reflètent même source, permissions, confirmations et policy.
- Preview de variables/artefacts sanitized et bornée ; ne pas lancer repr arbitraire côté renderer.

### 9.6 Effets de bord et reprise

La durabilité d'une requête ne prouve pas que son effet externe est exécuté une fois. Une mort après write/API et avant journal de réponse produit un résultat inconnu. Persister l'intention et la correlation, proposer vérification, utiliser idempotency fournisseur si disponible, ne pas rejouer des installs/edits/DB writes automatiquement.

Compaction ≠ rewind. Restore kernel ≠ restore workspace. Changement d'env ≠ migration sûre des objets Python. Ces différences apparaissent dans UI et tests.

---

## 10. Carte des zones de code concernées

### 10.1 Backend existant à adapter

| Zone | Travail |
|---|---|
| `crates/claakecode-core/src/provider.rs`, message/model/tool/stream | Adapters Prime et capabilities si nécessaires ; préserver clients existants |
| `crates/claakecode-app/src/python.rs` | Conserver one-shot, ajouter facade persistante distincte |
| `agent/context.rs`, `turn.rs`, `tool_dispatch.rs`, `cancel.rs` | Ownership/runtime refs, tools classiques, admission/annulation ; ne pas forcer tout RLM dans run_turn |
| `agent/events.rs`, compaction/history | Mapping événements et contexte, sans double store |
| `store.rs` | Migrations/configuration et projections ; extraction dédiée plutôt que croissance monolithique |
| `subagent.rs`, `team/` | Adapter services existants, définir séparations sessions RLM/teams, write ownership |
| `skill.rs`, `mcp.rs`, `database*`, `tool_names.rs`, `tool_run.rs` | Skills/Python bridges et garanties existantes |
| `src-tauri/src/state.rs` | Facades/managers runtime, pas toute logique métier |
| `models.rs`, `conversations.rs`, `turns.rs`, `context.rs`, `workflow.rs`, `swarm.rs` | Contrats création/harness, effective settings, execution/estimate, non-régression |
| `remote.rs`, `updater.rs`, `platform.rs`, `lib.rs` | Resync, lifecycle/service/update, OS boundaries et registration |
| `scripts/prepare-sidecars.mjs`, Tauri configs/capabilities et release workflow | Packaging audité ; ne pas copier logique ripgrep pour Python sans adaptation |

### 10.2 Frontend

- `src/types.ts` et `src/lib/ipc.ts` : contrats miroir, erreurs/status et commands.
- `src/components/Workspace.tsx` : création de chat et espace Compute/RLM.
- `ConversationList.tsx` : metadata harness et activité sans nouvelle sidebar obligatoire.
- `chat/ChatPane.tsx`, `ToolCard.tsx`, `stream.ts` : hooks composés, cartes/états/replay.
- `SettingsPane.tsx` : deux entrées et composants dédiés, pas de nouveaux milliers de lignes inline.
- Settings Skills/Embedding existants : raccord sans double configuration.
- `styles.css` : styles scoped et réutilisation design system.
- `remote/public` : mapping nouvelles fonctionnalités avec UI réduite conforme aux droits.

### 10.3 Modules proposés, à ajuster après ADR

Facades dédiées compute/environments/kernels/context/artifacts, adapter Prime RLM, memory/retrieval/harness/refinement et service client. Extraire en crates uniquement si responsabilité/dépendances le justifient. Pas de dépendances cycliques ou module dieu.

Composants proposés : ComputePopover, ComputeCard, ComputePane, KernelStateView, RlmAgentTree, NewChatMenu, AutoComputeSettingsSection, RlmSettingsSection, MemoryEntryCard, RefinementReview et EnvironmentDetails. Hooks d'abonnement/effective settings dédiés. Leur création doit mettre à jour `AGENTS.md`.

---

## 11. Ordre de livraison et dépendances

### 11.1 Lots livrables

**Ordre v2 (remplace l'ordre initial) :**

| Lot | Features / périmètre | Condition de sortie |
|---|---|---|
| P0 — Spike sidecar ✅ **fait** | F01 | `spikes/prime-acp/` : ACP 6/8 (récursion impossible en ACP), protocole daemon direct OK (spawn/collect/kill, sans orphelin) ; ADR P0 dans le README |
| P1 — Chat RLM minimal | F02, F11, F25 (création/badge), F08 (credentials), F09 (a), F30 (packaging sidecar + uv) | Client Rust **protocole daemon v7** (ACP en secours), chemins canonisés, conversation avec le vrai Prime, mapping des événements → messages/cartes, Stop, worktree par défaut, E2E avec provider `faux` |
| P2 — Supervision | F12–F13, tranche F22, F27 (Service/Modèles/État), F10 | Arbre d'agents, attach/detach/resync, reprise, budgets famille |
| P3 — Mémoire et apprentissage | F14–F16, F18–F19, F27 (Mémoire/Harness) | Lecture des stores Prime, cartes mémoire/refinement, review/rollback |
| P4 — Compute classique | F03–F07, F26 | REPL Prime via client Rust, auto-compute = session Prime headless, Settings Auto Compute |
| P5 — Extensions | F17, F20–F21, F23–F24, F28–F29, F09 (b) | Profils, retrieval, objectifs/planification UI, remote, parité/benchmarks, permissions patchées |

**Ordre initial (historique, remplacé par l'ordre v2) :**

| Lot | Features / périmètre | Condition de sortie |
|---|---|---|
| L0 — Référence et faisabilité | F01 | Pin, matrice, prototype de bout en bout et ADRs |
| L1 — Contrats et sécurité socle | F02, fondations F08–F10/F29/F30 | Defaults rétrocompatibles, policy et build validés |
| L2 — Python persistant | F03–F05, première F26/F28 | Envs/kernels/UI fiables, pause/stop et isolation annoncée honnêtement |
| L3 — Compute classique | F06–F07, F10 et UI F25 | Gros contexte, résultat structuré, usage et zéro régression off |
| L4 — Vrai RLM expérimental | F11–F13, tranche F22, F25/F27 | Engine Prime, host réel, récursion et lifecycle démontrés |
| L5 — Skills et harness | F14–F16 | Ressources durables et versionnées, source unique |
| L6 — Mémoire dialoguée et refinement | F17–F20 | Retrieval, dialogue, reviews, tests et rollback |
| L7 — Continuité complète | Compléments F12/F22, F23–F24 | Reprise, background, objectifs, gates et schedules |
| L8 — Profils complets et durcissement | F21, compléments F26–F30 | Sept profils validés, packaging, tests et benchmarks |

F12 n'est pas reportée entièrement à L7 : le superviseur minimal requis par les enfants doit exister dès L4. Restauration générale et service avancé sont complétés ensuite. Settings/UI/tests sont livrés avec chaque capability, pas en toute fin.

Général/Data/Math peuvent arriver plus tôt après leur socle. Les quatre autres sont bien prévus, pas supprimés du périmètre final. Le catalogue de profils ne doit pas retarder les mécanismes distinctifs de Prime.

### 11.2 Exécution du travail

**État P1 (première tranche livrée, non exposable en l'état)**

Fait et testé (`cargo test -p claakecode-app` 191 ✓, `-p claakecode` 23 ✓, `tsc` propre, test réel ignoré `PRIME_AGENT_BIN=… cargo test -p claakecode-app prime -- --include-ignored` ✓) :

- [x] **Transport daemon v7** (`crates/claakecode-app/src/prime.rs`) : `command_frame`/`call`, `Connection::send/receive` persistante, frames ≤ 8 Mio, timeout sans retry implicite, erreurs brutes Prime expurgées.
- [x] **Lifecycle sidecar** : `Sidecar::start/stop` (groupe de processus, env vidé puis minimal, `HOME` privé, télémétrie coupée, credentials injectés explicitement, `supervisor.log` 0600, `shutdown` puis kill, 0 orphelin). Socket dans `/tmp/ccp-*` (0700) à cause de la limite AF_UNIX ~104 octets.
- [x] **Mapping d'événements** : `map_session_event` → `PrimeEvent` (`agent_start`, `message_update/end` cumulatif, `tool_execution_*`, `agent_end` ; aborted/error jamais un succès) ; `RlmStream` → `AgentEvent` en deltas, sans doublon au replay.
- [x] **Sessions** : `create_session` (cwd canonisé), `run_prompt` (attach + prompt), `abort_session`.
- [x] **Store F02** : colonne `harness` (`classic` par défaut, migration v10 testée depuis v9), `create_rlm_conversation`, `conversation_harness`, immuable après création.
- [x] **Tauri** (`src-tauri/src/rlm.rs`) : `create_rlm_conversation`, `send_rlm_message` (refuse le non-RLM), `stop_rlm_turn`, `shutdown_rlm` à la sortie.
- [x] **UI** : bouton « RLM » (expérimental) à côté du « + », badge RLM, envoi/Stop aiguillés par harness. Compilé, **pas encore vérifié visuellement**.

Reste pour clore P1, dans cet ordre (les points 1 et 2 bloquent toute exposition publique) :

1. [x] **Worktree par défaut** — fait : `create_rlm_worktree` (git.rs) crée `claakecode/rlm-<tag>` depuis HEAD avant la conversation ; dépôt non git ou sans commit refusé ; Prime ne tourne que dans ce worktree ; table `rlm_bindings` (migration v11) ; bandeau `RlmBanner`. Test : `rlm_worktree_is_isolated_and_non_git_is_refused`.
   Initialement : pour chaque session RLM + bandeau « confiance locale » (F09 a). Aujourd'hui l'agent tourne dans le workspace sans restriction.
2. [~] **Packaging F30** — en grande partie fait : `scripts/prepare-prime-sidecar.mjs` compile `prime-agent` (`-p pa-cli`, `--locked`) au SHA complet `3358e0016bce…` par architecture, télécharge `uv` 0.12.22 avec SHA-256 figés, fusionne en universel macOS via `lipo` ; `src-tauri/tauri.prime.conf.json` (rg + prime-agent + uv) utilisé par la CI macOS/Linux (`CLAAKECODE_BUNDLE_PRIME=1`), Windows exclu ; `rlm.rs` place le dossier des sidecars en tête du PATH de Prime pour qu'il trouve `uv`. Vérifié en local (macOS Intel) : script complet OK (arm64 11 min 41 s, x86_64 13 min 36 s), `lipo` universel x86_64+arm64, `uv 0.12.22` / `prime-agent 0.9.8` répondent, 14 tests `prime` verts contre le binaire universel packagé (dont les 2 réels). Ajouté après ce run, non revalidé : suppression des symboles de debug (`CARGO_PROFILE_RELEASE_DEBUG=0`, `STRIP=symbols`), pour passer de 103 Mo universel à une taille estimée de moitié. Reste : lock Python du kernel (`cryptography<49` sur macOS Intel) à vérifier au premier lancement d'un build packagé, signature/notarisation (la CI actuelle désactive la signature macOS pour toute l'app), premier run CI réel.
3. [x] **Historique** — fait : tours user/assistant ajoutés à l'historique Claake ; `sessionFile` stocké et rouvert via `sessionPath` après redémarrage (Prime refuse `continueRecent`), validé contre le vrai binaire.
   Initialement : persister conversation → session Prime et recharger via `get_messages`.
4. [x] **Double envoi** — fait : tour RLM enregistré dans `active_turns` et la liste des tours actifs.
   Initialement : enregistrer le tour RLM dans `active_turns`.
5. [x] **Modèle** — fait : `set_model` à chaque tour avec le modèle du sélecteur du chat ; mapping Claake → Prime (`openai` devient `openai-codex` si connexion ChatGPT) ; refus explicite si le provider n'est pas connecté, jamais de bascule silencieuse.
6. [x] **Credentials F08 (mêmes que le chat de base)** — fait : réutilise les connexions OAuth existantes de Claake Code (Anthropic, OpenAI/ChatGPT) et les clés API (OpenAI, OpenRouter, Mistral). Avant chaque tour, Claake rafraîchit les tokens avec son propre code OAuth puis écrit `agent/auth.json` (0600, écriture atomique) ; **Prime ne reçoit que l'access token, jamais le refresh token** (pas de rotation concurrente). Daemon redémarré si l'ensemble des providers connectés change ; les sessions se rouvrent via `sessionPath`. Validé contre le vrai binaire (`real_sidecar_reads_auth_file_credentials`).
   Limite : **Google** n'est pas utilisable dans le chat RLM — la connexion Google de Claake est Gemini Code Assist/Antigravity, que Prime n'implémente pas ; refus explicite. Suite possible : patch du fork Prime ou clé API Gemini.
   Bug corrigé au passage : la variable d'environnement était `PRIME_AGENT_AGENT_DIR` (ignorée par Prime) au lieu de `PRIME_AGENT_CODING_AGENT_DIR`.
7. [x] **Reprise** — fait : constat dans les sources Prime, le daemon **ne rejoue jamais** les événements manqués (`create_daemon_replay_info` : `complete` seulement si rien n'a été manqué, sinon `unavailable` + snapshot). `run_prompt` démarre après le `lastEventSequence` de l'attach initial ; si le flux casse, il se reconnecte (3 essais max, backoff), réattache avec `resumeCursor {generation, sequence}` et **ne renvoie jamais le prompt** ; `RlmStream::resync` comble le trou depuis le snapshot : suffixe de texte manquant uniquement (jamais de doublon ni de réécriture), outils ouverts fermés, fin de tour/erreur/interruption si Prime ne streame plus ; changement de `generation` (daemon redémarré) = erreur « outcome unknown ». Tests : `parses_attach_snapshot`, `resync_*` (2), `run_prompt_resyncs_after_connection_loss` (faux daemon qui coupe en plein tour) ; tests réels toujours verts. Limite : un timeout d'inactivité (`max_idle`) reste un échec sans reprise ; redémarrage du daemon pendant un tour non repris.
8. [ ] **Windows** : transport à implémenter (named pipe ou TCP loopback authentifié) ; aucune parité annoncée d'ici là.
9. [~] **E2E** — partiel : branche `e2e-rlm`, `e2e` (tester-army) + Playwright contre le frontend avec un faux backend Tauri injecté (`tests/e2e/tauriMock.ts`) ; `npm run test:e2e` : 4 tests verts (création RLM + bandeau d'isolation + réponse streamée + routage `send_rlm_message` avec le provider du sélecteur ; échec de création visible ; section Settings « Python persistant » ; capture du chat RLM). Captures vérifiées visuellement (`.e2e/shots/`) ; corrigé : ligne de conversation RLM qui passait à la ligne (grille 4 colonnes quand badge). A révélé et corrigé un défaut : l'échec de création RLM n'était que dans la console. Limites : le backend est simulé (Rust testé séparément contre le vrai Prime), pas de test dans la vraie fenêtre Tauri, Stop/rechargement non couverts.
10. [x] **Python persistant dans Settings** — fait : section « Python persistant » (`PythonRuntimeSection.tsx`) : état du moteur, sessions actives, version Python, taille, emplacement du venv, providers, liste filtrable des packages, boutons Actualiser/Redémarrer. Backend : `prime::inspect_python_env` (lit `pyvenv.cfg` + `*.dist-info` sans exécuter Python, testé), commandes `get_python_runtime_status` / `restart_python_runtime`.

**Exigences produit (confirmées par l'utilisateur) :**

- **Mêmes providers et modèles que le chat classique** : le chat RLM utilise le sélecteur de modèle et les credentials existants de Claake Code (clés API et OAuth), sans configuration séparée. Les points 5 et 6 deviennent donc obligatoires pour P1.
- **Même rang que le chat classique** : le chat RLM n'est pas une fonction cachée. Création, liste, historique, sélecteur de modèle, Stop, cartes d'outils et états d'erreur ont la même visibilité et la même finition que le chat actuel.
- **Python persistant visible dans Settings** : l'environnement Python de Prime (REPL, venv, packages, état du kernel) est consultable dans Settings, dans la même section et sous la même forme que le Python persistant d'Auto Compute (F26/F27). Un seul endroit, un seul moteur.

Condition de sortie P1 : les 9 points cochés et les exigences produit ci-dessus respectées ; le chat RLM est alors exposé au même niveau que le chat classique. P2 → P5 suivent l'ordre v2 de la section 11.1.

Pour chaque feature :

1. Lire sources Prime épinglées et existant pertinent.
2. Rédiger décision/adaptation et scénarios.
3. Implémenter tranche backend + stockage + UI ensemble.
4. Reprendre/adapter tests source et ajouter tests de refus/erreur/annulation.
5. Mettre à jour compatibilité, documentation, données de migration et carte des fichiers.
6. Faire review ciblée sécurité et parité.
7. Livrer derrière activation explicite si expérimental ; pas de commandes UI branchées sur stubs.

Un fork maintenu et un pin doivent être préférés à des copies éparses sans provenance. Pas de chiffrage ferme avant L0 : toolchain, protocoles, providers et daemon conditionnent l'effort réel.

### 11.3 Maintien de ce plan

Chaque feature reste `[ ]` tant que son backend, UI, tests et documentation requis ne sont pas terminés. Une livraison partielle ne coche pas toute la feature. Répertorier PR/commit et preuve de validation dans la matrice dédiée créée en F01. Tout changement de périmètre doit préserver un historique de décision.

---

### 11.4 Reporté après la v1

Restent dans le périmètre final mais ne bloquent pas la première version : profils Web/Software/Science/IA (Général et Data d'abord), embeddings (FTS seul au départ), remote, tâches planifiées, auto-apply du refinement, interpréteur Python utilisateur, sandbox réelle (seul le mode local de confiance + worktree est livré d'abord).

## 12. Tests et définition de terminé

### 12.1 Matrice minimale de tests

| Domaine | Cas obligatoires |
|---|---|
| Compatibilité | Anciennes conversations/settings, capabilities manquantes et downgrade |
| Runtime | Namespace, await, stderr, erreurs, raw fd, frames invalides, flood et EOF |
| Annulation | Cellule sync/async, extension bloquée, modèle en vol, collecte, tasks et famille |
| Envs | Install interrupt, hash invalide, missing package, conflit, proxy/offline et architectures |
| Tools | Désactivé, Ask/Plan, fingerprint edit, MCP, confirmations DB/shell |
| RLM | Prompt layers/cache/digest, contexte variable, child réel, fan-in, messages et selector errors |
| Budgets | Admissions concurrentes, profondeur, usage cumulatif, coût inconnu et reprise |
| Mémoire | Provenance, scopes, correction/oubli, contradictions, prompt injection et succès du commit |
| Retrieval | Paraphrases, modèle/dimension changé, index périmé, fallback et suppression |
| Refinement | Proposal/reject/apply/rollback/conflict, auto policy et non-réécriture de base |
| Skills/profils | Import fail, package trust, deps conflits, promotion, test indépendant et GPU absent |
| Recovery | Crash windows, résultats inconnus, checkpoint incomplet, rewind et workspace drift |
| Jobs | Sleep/reboot/timezone/DST, occurrence ratée, revoke grant et suspend all |
| UI | Keyboard/focus, aria, thèmes, large output, window width, stop semantics et dirty states |
| Service | Multi-fenêtres, endpoint auth, reattach/resync, worker death et service shutdown |
| Remote | Clients anciens, droits, subscriptions/replay, confirms et mobile |
| Release | Installer réel, update en tâche active, rollback, offline prepared et uninstall |

### 12.2 Niveau de preuve

- Tests unitaires/fixtures déterministes pour contrats et transitions.
- Tests intégration avec vrai runtime et mocks providers.
- Tests E2E UI sur builds réels ; readiness observable, pas sleep fixe ou retry-to-green.
- Tests live modèles dans suite séparée, coûts et données contrôlés.
- Tests différentiels Prime sur mêmes entrées/fixtures ; comparer états/invariants, pas prose aléatoire du LLM.
- Benchmarks sur corpus versionné et budgets égaux ; publier gains et régressions honnêtement.

### 12.3 Contrôles techniques

Depuis `sinew/`, réutiliser typecheck/build frontend et checks/tests Rust des crates concernées. Étendre la CI aux nouvelles crates/service/runtime et tests Python. Quand des composants Prime sont repris, exécuter les gates source applicables ou documenter leur remplacement avec preuve équivalente. Ne pas déclarer une suite exécutée si seul un test documentaire a été fait.

### 12.4 Définition de terminé par feature

- [ ] Réalisation backend et erreurs/refus explicites.
- [ ] UI réelle, accessible, responsive et état de progression.
- [ ] Settings et scope cohérents si concernés.
- [ ] Contrats, migrations et non-régression testés.
- [ ] Permissions, budgets et données privées contrôlés.
- [ ] Arrêt/reprise cohérents selon feature.
- [ ] Parité Prime documentée, différence assumée identifiée.
- [ ] Documentation et provenance/licenses à jour.
- [ ] Aucun stub/endpoint absent/feature silencieusement inopérante.

### 12.5 Définition de terminé de l'ajout complet

Le périmètre est terminé quand F01–F30 et leurs critères requis sont couverts, pas seulement quand un chat RLM répond. Les trois expériences sont utilisables ; mémoire et refinement sont dialoguables/inspectables ; service et agents sont maîtrisables ; profils annoncés opérationnels ; gains mesurés et compatibilité traçable. Une livraison beta peut être utile avant, sans être présentée comme l'intégration complète.

---

## 13. Décisions ouvertes, risques et exclusions

### 13.1 ADRs à produire en priorité

| Décision | Pourquoi | Feature |
|---|---|---|
| Crates, sidecar ou portage — **v2 : sidecar confirmé en P0 ; transport = protocole daemon v7 (ACP ne permet pas la récursion)** | Détermine réutilisation et maintenance | F01 |
| Pin et toolchain — **v2 : toolchain propre au sidecar, Claake reste en 1.80** | Compatibilité/build/protocoles | F01/F30 |
| Permissions RLM — **v2 : (a) worktree + confiance locale, puis (b) patch `request_permission`** | Prime non restreint en ACP | F09 |
| Provider et credentials authority | Pas de double configuration ni fuite | F01/F08 |
| Stockage canonique | Pas de mémoire/roster divergents | F01/F02/F15 |
| Mode Plan et isolation | Ne pas mentir sur read-only | F09 |
| Budget precision/enforcement | Coûts en vol et limites OS | F10 |
| Session/famille sur Stop | Actions non ambiguës | F12/F13/F25 |
| Snapshots et rewind | État Python/fichiers/effets externes | F22 |
| Retrieval/index backend | Compatibilité, qualité et simplicité | F17 |
| Background/OS lifecycle | Mort GUI/logout/sleep et consentement | F12/F24 |
| Packaging uv/Python/service | Signature/architecture/disque/offline | F30 |

### 13.2 Risques à suivre

- Réécrire Prime sans besoin et perdre ses garanties.
- Deux stores/rosters qui se désynchronisent.
- Toolchain/deps ou protocoles incompatibles.
- Confondre venv/process isolation avec sandbox.
- Coûts explosifs par récursion/refinement/jobs.
- Variables et mémoire projet qui fuient entre sessions.
- Restaurer des snapshots exécutables ou effets de bord inconnus.
- Promouvoir une observation fausse en règle durable.
- UI trop dense, monitoring qui ralentit app ou affiche secrets.
- Packaging fragile, service oublié après fermeture/uninstall.
- Profils trop spécialisés qui détruisent la composition libre du RLM.

### 13.3 Exclusions explicites

Pas de fine-tuning/LoRA, entraînement GPU des poids, cloud compute obligatoire, vector DB distante obligatoire, reproduction de toute la TUI, auto-install de code non approuvé ni garantie de sécurité via prompt. Notebook IDE complet, conversion in-place des chats et chiffrement applicatif de bout en bout non promis par ce plan. La confidentialité de base et les permissions réelles restent obligatoires.

Les commandes/services commerciaux Prime non nécessaires sont hors parité sauf décision dédiée. Toute fonctionnalité importante source non couverte révélée par F01 doit être classée explicitement reprise/adaptation/exclusion, pas ignorée.

---

## 14. Checklist de couverture

| Exigence de la discussion | Couverture |
|---|---|
| Prendre en compte et réutiliser le travail Prime | F01, matrice/source map, F29–F30 |
| Chat actuel conservé | F02/F07/F25 et migrations |
| Tools activables | F07/F08/F26 |
| Python persistant optionnel | F03–F05/F07 |
| Détails Python dans Settings Auto Compute | F05/F26, parcours UI |
| Plusieurs environnements, sans confusion mémoire | F03/F21, architecture/stockage |
| Profils Général/Web/Data/Software/Science/Math/IA | F21 et lots |
| Agent RLM réel comme Prime | F11–F15/F22–F24, matrice API |
| Gestion du RLM dans Settings | F27 |
| Discussion directe mémoire/apprentissage | F18–F20 |
| Harness durable et refinement | F15/F19 |
| Skills exécutables et création | F14/F20 |
| Stockage ML/embeddings expliqué | F16–F17, section 8 |
| Pas d'entraînement des poids | Vision, F19, exclusions |
| UI/UX pensée de bout en bout | F25–F28, section 7 |
| Récursion, communication et sessions réelles | F12–F13 |
| Arrière-plan, reprise, objectifs et planification | F12/F22–F24 |
| Permissions, sandbox honnête et secrets | F08–F10 |
| Rewind/compaction/effets de bord | F22, section 9 |
| Budget familial et coûts | F10/F23/F29 |
| Export, oubli, rétention et diagnostics | F16–F17/F28 |
| Multi-fenêtres et remote | F12/F25/F28 |
| Tests/parité/performance | F29, section 12 |
| Packaging, update et upstream | F30 |
| Chaque feature a travail, UI, validation et dépendances | F01–F30 |

---

## 15. Sources techniques

Sources consultées pour les propositions ; F01 doit réexaminer leurs versions exactes au pin retenu.

### Prime Agent

- [Dépôt et README](https://github.com/WilliamPeynichou/prime-agent)
- [Révision candidate](https://github.com/WilliamPeynichou/prime-agent/commit/3358e0016bce7cf34a195af58bbd91a26e17d694)
- [Contrats et architecture AGENTS](https://github.com/WilliamPeynichou/prime-agent/blob/main/AGENTS.md)
- [Workspace Cargo](https://github.com/WilliamPeynichou/prime-agent/blob/main/Cargo.toml)
- [Runtime REPL et protocole](https://github.com/WilliamPeynichou/prime-agent/blob/main/prime-agent-runtime/src/rlm/repl.md)
- [Implémentation REPL](https://github.com/WilliamPeynichou/prime-agent/blob/main/prime-agent-runtime/src/rlm/repl.py)
- [Packages runtime](https://github.com/WilliamPeynichou/prime-agent/blob/main/prime-agent-runtime/pyproject.toml)
- [Scope pa-core](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-core/README.md)
- [Bootstrap kernel](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-core/src/kernel/bootstrap/mod.rs)
- [Protocole côté Rust](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-core/src/kernel/protocol.rs)
- [Host bridge RLM](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-core/src/session_engine/rlm_host.rs)
- [Prompt assemblé](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-core/src/prompts/system_prompt.rs)
- [Refinement](https://github.com/WilliamPeynichou/prime-agent/tree/main/crates/pa-core/src/refinement)
- [Skills](https://github.com/WilliamPeynichou/prime-agent/tree/main/crates/pa-core/src/skills)
- [Scope daemon](https://github.com/WilliamPeynichou/prime-agent/blob/main/crates/pa-daemon/README.md)

### Claake Code

Zones analysées : Cargo/package manifests, `AGENTS.md`, `python.rs`, `store.rs`, `agent/context.rs`, `agent/mode.rs`, `agent/events.rs`, `agent/tool_dispatch.rs`, `subagent.rs`, `team/agent_turns.rs`, Tauri state/context/conversations, ChatPane, ToolCard, ConversationList, SettingsPane, Workspace, types/IPC, embeddingSettings et prepare-sidecars.

**Conclusion directrice : intégrer d'abord les mécanismes et contrats Prime, puis construire l'expérience Claake Code autour. Les profils et Settings rendent cette puissance accessible ; ils ne remplacent pas la fondation RLM.**
