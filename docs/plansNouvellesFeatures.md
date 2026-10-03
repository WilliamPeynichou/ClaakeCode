# Plan — Benchmark des modèles + Claaky

Statut : **proposition, rien d'implémenté**. Deux chantiers indépendants, livrables séparément.

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

### Risques
- Chiffres trompeurs : toujours n + avertissement.
- Données sensibles : on ne stocke ni prompts ni réponses dans `model_turns`, uniquement des compteurs.
- Poids : agrégation faite en SQL / en tâche bloquante, jamais sur le thread UI ; cache de résultat.

---

## Chantier B — Claaky, le petit personnage

> **État : implémenté (C1–C5)**, en 3D three.js construite en code (formes simples), pas en SVG seul. Claaky est le visage de l'agent : on lui parle, c'est lui qui code. Réglage on/off dans Settings > Claaky (persisté côté backend). Désactivé : anciens loaders, écran « Nothing open » et plus de persona dans le prompt. La persona est un court texte de ton (`CLAAKY_PERSONA`) placé après les règles `CLAAKE.md`, sans changer règles, outils ni langue ; elle s'applique aussi au chat RLM. Loaders : sprite SVG (pas de WebGL dans l'historique du chat). Écran vide : scène 3D (regard qui suit la souris, clignement, saut au clic, sommeil après 90 s) + 2 démarrages rapides ; repli SVG si WebGL indisponible ; `prefers-reduced-motion` = image fixe. three.js (0.170.0 épinglé) est un chunk séparé (177 Ko gzip). **Reste** : C6 (interactions), états `working`/`done`/`error` branchés sur le flux de l'agent (ils existent dans le sprite mais seuls `thinking` et `planning` sont utilisés), message d'accueil contextuel, variante visuelle pour le RLM.

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
