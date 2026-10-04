# Plan — Benchmark des modèles + Claaky

Statut : **chantier A : B1 et B3 implémentés** (branche `feature/model-benchmark`) ; B2, B4, B5, B6 restent à faire. Chantier B (Claaky) : C1–C5 faits.

---

## Constats dans le code (vérifiés)

**Données déjà disponibles pour un benchmark**
- Chaque message assistant porte `meta.token_usage` (`attach_token_usage`, `agent/events.rs`) : `provider`, `model`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_creation_tokens`. Il est stocké dans `messages.message_json` : l'**historique existant** est exploitable sans rien ajouter.
- Événement `TokenUsage` en direct (avec fenêtre de contexte) et `TurnFinished { duration_ms }`.
- Une table `turn_checkpoints` et `rewriteFromHistoryIndex` : on sait quand l'utilisateur **réécrit ou revient en arrière** sur un tour.

**Données qui manquent**
- La **durée d'un tour n'est pas persistée** : `TurnFinished` est émis avec `duration_ms: None` dans plusieurs chemins (`turn.rs:833`, `turns.rs:470`).
- Aucun **temps jusqu'au premier token**, aucune **erreur par modèle**, aucune **grille de prix** dans le code (`grep price|cost` : rien dans `claakecode-core`).
- Le chat RLM (Prime) n'a pas le même flux d'usage : à traiter à part.

**Loaders et écran vide actuels**
- Loaders : `DotmSquare2` (dans `AIThinkingBlock`, « Thinking ») et `DotmSquare5` (dans `PlanningNextMoveBlock`, « Planning next moves »).
- Écran vide : `EditorPane.tsx` ~l.404, icône + « Nothing open » + « Click a file in the sidebar ».
- Réglages : `SettingsPane.tsx`, sections par fichier (`PythonRuntimeSection`, etc.).

---

## Chantier A — Benchmark de performance des modèles

### Ce que « benchmark » veut dire ici (à ne pas survendre)
Mesure **de l'usage réel** de l'utilisateur, pas un classement de qualité. Les chiffres dépendent de la difficulté des tâches, du prompt et de la charge réseau. Avec peu de tours, ils sont bruités. L'écran doit l'afficher : nombre de tours (n), et un avertissement sous un seuil (ex. n < 20).

### Métriques
| Métrique | Source | Disponible |
|---|---|---|
| Tours par modèle | `token_usage` des messages | oui, rétroactif |
| Tokens entrée / sortie / raisonnement | idem | oui, rétroactif |
| Taux de cache (`cache_read / input`) | idem | oui, rétroactif |
| Tokens moyens par tour | calculé | oui |
| Durée d'un tour, tokens de sortie / s | `TurnFinished.duration_ms` | **à persister** |
| Temps au premier token | stream | **à mesurer** |
| Taux d'erreur, d'interruption | événements `Error`, `Interrupted` | **à persister** |
| Taux de réécriture / retour arrière | `turn_checkpoints`, `rewriteFromHistoryIndex` | partiel |
| Appels d'outils échoués | `ToolResult.is_error` | oui, dans `message_json` |
| Coût estimé | tokens × prix | **prix à fournir** |

Le « taux de réécriture » est un **proxy de satisfaction**, pas une vérité : à libeller comme tel.

### Features

**B1 — Agrégation rétroactive (complexité : simple)**
Commande Rust `get_model_stats(period)` qui lit `messages.message_json`, groupe par `provider/model`, calcule tours, tokens, cache, appels d'outils en erreur. Aucune migration. Tests Rust sur un jeu de messages fixe.

**B2 — Persistance des mesures manquantes (moyenne)**
Nouvelle table `model_turns` (conversation, provider, model, harness classic/rlm, durée, premier token, tokens, statut `ok|error|interrupted`, horodatage). Migration versionnée avec défaut rétrocompatible. Enregistrement à la fin de chaque tour, aussi pour les sous-agents (étiquetés). Données **locales uniquement**, aucun envoi réseau.

**B3 — Page Settings « Performance des modèles » (moyenne)**
Nouvelle section dans `SettingsPane`. Tableau par modèle (tours, tokens/tour, tokens/s, cache, erreurs, réécritures), filtre de période (7 j / 30 j / tout) et de harness (classique / RLM), tri, mini-barres. État vide clair, mention de n et des limites. Bouton « Effacer les statistiques ». Export CSV.

**B4 — Coût estimé (simple, dépend d'une décision)**
Grille de prix **configurable par l'utilisateur** (pas de prix codés en dur qui deviennent faux). Sans grille : colonne masquée. Libellé « estimation ».

**B5 — Benchmark actif, optionnel (complexe, phase 2)**
Suite de prompts fixes lancée sur plusieurs modèles au choix, pour comparer à conditions égales (même prompt, même contexte). **Consomme des tokens** : écran de confirmation avec estimation du coût, bouton Stop, budget maximal. Résultats stockés à part des stats d'usage. Hors RLM au début.

**B6 — Intégration dans le sélecteur de modèle (simple)**
Dans le sélecteur du chat, affichage discret d'un résumé par modèle (tokens/s médian, n). Seulement si n suffisant.

### Ordre conseillé
B1 → B3 (valeur immédiate, sans migration) → B2 → B6 → B4 → B5.

### État B1 + B3 (implémenté)
- **B1** : `crates/claakecode-app/src/model_stats.rs` (agrégation pure, tests) + `AppStore::model_stats(since_ms, harness)`. Groupe par harness / provider / modèle : réponses (un message assistant avec `token_usage` = une réponse ; un tour avec outils en compte plusieurs), conversations, tokens entrée / sortie / raisonnement / cache, appels d'outils et appels en erreur (attribués au modèle via `tool_call_id`). Aucune migration.
- **`prompt_tokens`** : contexte complet cache compris, `total − output`. Nécessaire car `input_tokens` exclut le cache chez Anthropic et l'inclut chez OpenAI ; le taux de cache affiché est `cache_read / prompt_tokens`.
- **Période approximative** : les messages n'ont pas d'horodatage, le filtre garde les conversations dont `updated_at_ms` est dans la période. B2 corrigera.
- **B3** : Settings « Performance » (`src/components/ModelStatsSection.tsx`) : période 7 j / 30 j / tout, harness Tous / Chat / RLM, tri par colonne, mini-barres, badge « n faible » sous 20 réponses, notes sur les limites, export CSV (généré en Rust, `.csv` uniquement, cellules neutralisées contre les formules). Commandes Tauri `get_model_stats` / `export_model_stats_csv` (`src-tauri/src/stats.rs`, en `spawn_blocking`). Test e2e dans `tests/e2e/rlm-chat.e2e.ts`.
- **Pas fait** : bouton « Effacer les statistiques » (sans table dédiée, effacer reviendrait à supprimer l'historique : attend B2), taux de réécriture, durée / tokens/s / premier token (B2). Le chat RLM n'enregistre pas de `token_usage` : son filtre reste vide.

### Risques
- Chiffres trompeurs : toujours n + avertissement.
- Données sensibles : on ne stocke ni prompts ni réponses dans `model_turns`, uniquement des compteurs.
- Poids : agrégation faite en SQL / en tâche bloquante, jamais sur le thread UI ; cache de résultat.

---

## Chantier B — Claaky, le petit personnage

> **État : implémenté (C1–C5), refait en 2D.** L'ancienne version (logo Claake : tête ronde + deux pétales ; scène 3D three.js « squishy ») est **retirée** : `ClaakyScene.tsx` supprimé, dépendances `three` et `@types/three` désinstallées. Claaky est désormais un **SVG 2D unique** (`Claaky.tsx`) dessiné **uniquement d'après l'illustration de référence** `films/claaky/assets/image_6e11fda6-c86e-4997-88c2-ae134ace8245_0.webp` : corps crème menthe, oreilles en feuilles vertes, bille verte sur la tête, virgule verte sur le ventre, petits bras, yeux anime (fond sombre, iris vert éclairé en bas, cils, 3 reflets), joues roses. **Volume « pâte à modeler » mat** : calques de dégradés radiaux (bord ombré + reflet doux en haut à gauche) par pièce, **sans aucun filtre SVG**, seulement à partir de 48 px ; en dessous, aplats ; sous 40 px les bulles/effets sont masqués. Couleurs relevées sur l'image de référence. **7 poses en CSS** (transform/opacity, data-state, arrêt sous `prefers-reduced-motion`) liées à ce que fait l'agent : *idle* (respire, cligne, salue, oreilles qui bougent), *thinking* (main au menton, regard en l'air, tête qui penche, points), *working* (tape au clavier en alternance, rebond, bulle `</>`), *planning* (bras levé, balancement, liste qui s'écrit), *done* (saut avec écrasement/étirement, bras levés, yeux ^^, étoiles), *error* (oreilles basses, sourcils inquiets, bouche « o », goutte, tremblement), *sleeping* (yeux fermés, oreilles et bille tombantes, Zz). Affiché dans les loaders (26 px), l'en-tête du chat, l'écran vide « Que faisons-nous ? » (168 px) et Settings > Claaky (aperçu 168 px + poses cliquables). Prototype et planche de validation : `docs/claaky2d/` (`preview.html`, `claaky2d-preview.png`, `shoot.mjs`). Inchangés : réglage on/off persisté (`claaky_enabled`), persona `CLAAKY_PERSONA` après les règles `CLAAKE.md`, mapping état agent → pose (`claakyAgentState.ts`), démarrages rapides. Les vidéos `films/claaky/` ne sont pas modifiées (elles montrent encore l'ancien Claaky). **Reste** : mesurer le coût GPU des filtres dans la vraie fenêtre Tauri, message d'accueil contextuel, variante RLM, refaire les vidéos avec le nouveau Claaky.

### Performance (optimisation du Claaky 2D)

- **Mesure (WebKit headless, le moteur de Tauri sur macOS, Mac Intel i5, sans GPU)** : une page vide plafonne à 30 images/s dans cet environnement. Avec les filtres SVG, le grand Claaky tombait à **14 images/s** et 7 vignettes immobiles à **6** (WebKit calcule les filtres sur le CPU). Sans filtres : grand Claaky à **30 (le plafond)**, 10 loaders à 30, 7 vignettes animées à 23 (en vrai elles sont fixes). 40 loaders animés en même temps : 12 (cas de stress, jamais atteint dans l'app). Chromium : 60 images/s partout, sans image > 25 ms.
- **Aucun filtre SVG** : le volume vient de dégradés (bord ombré + reflet), les ombres, joues et occlusions sont des dégradés fondus. Le grain fin a été retiré avec les filtres.
- `React.memo` évite les reconstructions à props identiques pendant le streaming.
- Loaders <40 px : aplats, bulles et effets masqués, seul le rebond du corps reste animé.
- Vignettes Settings fixes et sans calques de volume ; grand aperçu animé.
- Pause CSS hors écran et document masqué : un seul observateur partagé, aucun timer/boucle JS par personnage.
- Gestes : frappe alternée (460 ms), rebond 920 ms, saut 1,15 s avec anticipation/réception ; fondus courts des expressions ; pas de `will-change` global.
- **Non mesuré** : la vraie fenêtre Tauri avec GPU sur la machine de l'utilisateur ; les mesures ci-dessus viennent d'un banc de test jetable (supprimé).

### Rôle
- **Remplace les loaders** de l'agent (« Thinking », « Planning next moves »).
- Occupe l'**écran vide** de l'éditeur quand aucun fichier n'est ouvert, avec un message « Que faisons-nous ? ».
- Un compagnon discret, pas un assistant parlant : il **reflète l'état** de l'agent.

### Décisions de conception
- **Création originale** (aucune mascotte existante ni licence tierce). Cohérente avec le logo `ClaakeCode` et les 4 palettes du site.
- **SVG inline + CSS**, pas de canvas ni de GIF : léger, net à toute taille, thémable par variables CSS. Plusieurs milliers de blocs peuvent être rendus dans un long historique : un seul sprite SVG réutilisé via `<use>`.
- **Accessibilité** : `role="status"`, texte alternatif, respect de `prefers-reduced-motion` (pose fixe, pas d'animation).
- **Désactivable** : réglage Settings « Afficher Claaky » (défaut : activé). Désactivé → on garde les loaders actuels.

### États
| État | Quand | Idée d'animation |
|---|---|---|
| `idle` | écran vide, rien en cours | respire, regarde autour |
| `thinking` | réflexion / `AIThinkingBlock` | tête qui penche, points de suspension |
| `working` | outils en cours | s'active (petit marteau / clavier) |
| `planning` | `PlanningNextMoveBlock` | carte / liste |
| `done` | tour terminé | petit saut, clin d'œil |
| `error` | erreur | tête basse, goutte |
| `sleeping` | écran vide inactif longtemps | dort |
| `rlm` | chat RLM | variante visuelle légère (lunettes ?) pour distinguer |

### Features

**C1 — Conception visuelle et sprite (moyenne)**
Dessin du personnage, grille de poses par état, palette thémable, tailles 16 / 24 / 48 / 96 px. Fiche de style dans `docs/`.

**C2 — Composant `Claaky` (simple)**
`src/components/Claaky.tsx` : props `state`, `size`, `label`. CSS d'animation par état, `prefers-reduced-motion`. Test e2e de rendu par état.

**C3 — Remplacement des loaders (simple)**
`AIThinkingBlock` et `PlanningNextMoveBlock` utilisent `Claaky` à la place de `DotmSquare2/5`, avec le même libellé. État `working` pendant les outils si une zone de loader existe déjà.

**C4 — Écran vide « Que faisons-nous ? » (simple)**
Dans `EditorPane`, remplace icône + « Nothing open ». Titre « Que faisons-nous ? », sous-titre actuel conservé, et **3 raccourcis** (ouvrir un fichier, nouveau chat, Auto Compute). Un message d'accueil varié selon l'heure ou le contexte (ex. dépôt git sans commit → suggestion). Texte par défaut simple d'abord.

**C5 — Réglage on/off (simple)**
Section Settings (apparence). Persisté dans `app_settings`. Défaut : activé.

**C6 — Interactions légères (optionnel)**
Clic sur Claaky → clin d'œil, ou petit message d'astuce. Pas de notification, pas de son.

### Ordre conseillé
C1 → C2 → C3 → C4 → C5 → C6.

### Risques
- **Perf** : animation en CSS pur sur éléments transformés (`transform`/`opacity`), pas d'animation JS par frame.
- **Lassitude** : il faut pouvoir le couper (C5) et ne jamais bloquer la lecture.
- **Qualité du dessin** : c'est le point le plus subjectif ; prévoir 2 propositions et une validation visuelle avant C3.

---

## Questions ouvertes (décision utilisateur)
1. **Benchmark** : usage réel seulement (B1–B4), ou aussi le benchmark actif qui coûte des tokens (B5) ?
2. **Prix** : saisis à la main dans Settings, ou pas de coût du tout ?
3. **Claaky** : quel animal / créature ? (idée : petit robot-chat, ou une forme douce qui évoque le logo.) Un nom court suffit, je propose le dessin.
4. **Claaky dans le RLM** : même personnage avec variante, ou même visuel ?
5. **Livraison** : un chantier par release, ou les deux ensemble ?

## Hors périmètre
Pas de fine-tuning, pas d'envoi de données à un serveur, pas de classement public des modèles.
