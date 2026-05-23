# Comparaison des harnesses du tool `grep`

Analyse demandée sur 4 codebases :

- **OpenCode** : `/Users/hyrak/opencode/opencode`
- **Pi** : `/Users/hyrak/pi/pi`
- **ClaudeCode** : `/Users/hyrak/Downloads/ClaudeCode`
- **Sinew / notre repo actuel** : workspace courant

## Verdict rapide

Le harness `grep` **le plus puissant est celui de ClaudeCode**.

Pourquoi ? Parce qu’il ne fait pas juste “chercher une regex”. Il expose plusieurs modes de sortie, sait paginer, filtrer par type de fichier, gérer le multiline, respecter les permissions de lecture, masquer les chemins interdits, limiter le bruit, persister les gros résultats, gérer les timeouts et embarquer/fallback ripgrep proprement.

Classement global, en prenant en compte fonctionnalités + ergonomie + sécurité + robustesse :

1. **ClaudeCode** — le plus complet et le mieux intégré.
2. **Sinew** — très bon équilibre, modes de sortie utiles, API stricte, mais moins de flags avancés.
3. **Pi** — très bon pour “matching lines + contexte”, robuste contre l’injection, mais moins polyvalent.
4. **OpenCode** — simple et rapide, mais le moins riche côté modes et options.

---

## Sources inspectées

### OpenCode

- `packages/opencode/src/tool/grep.ts`
- `packages/opencode/src/tool/grep.txt`
- `packages/opencode/src/file/ripgrep.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/tool/external-directory.ts`
- `packages/opencode/test/tool/grep.test.ts`

### Pi

- `packages/coding-agent/src/core/tools/grep.ts`
- `packages/coding-agent/src/core/tools/truncate.ts`
- `packages/coding-agent/src/core/tools/path-utils.ts`
- `packages/coding-agent/test/tools.test.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/ai/src/utils/validation.ts`
- `packages/coding-agent/src/utils/tools-manager.ts`

### ClaudeCode

- `tools/GrepTool/GrepTool.ts`
- `tools/GrepTool/prompt.ts`
- `tools/GrepTool/UI.tsx`
- `utils/ripgrep.ts`
- `utils/permissions/filesystem.ts`
- `services/tools/toolExecution.ts`
- `utils/toolResultStorage.ts`
- `constants/toolLimits.ts`

### Sinew

- `crates/sinew-app/src/grep.rs`
- `crates/sinew-app/src/ripgrep.rs`
- `crates/sinew-app/src/workspace.rs`

---

## Tableau comparatif

| Critère | OpenCode | Pi | ClaudeCode | Sinew |
|---|---:|---:|---:|---:|
| Backend | `ripgrep` | `ripgrep` | `ripgrep` | `ripgrep` |
| Validation schéma | Zod | TypeBox + validation runtime | Zod strict | Serde + schema JSON strict côté descriptor |
| Regex | Oui | Oui | Oui | Oui |
| Recherche littérale | Non | Oui, `literal` | Pas d’option dédiée, mais regex ripgrep | Non |
| Ignore case | Non | Oui | Oui, `-i` | Non |
| Filtre glob | Oui, `include` | Oui, `glob` | Oui, `glob` | Oui, `include` |
| Filtre type langage | Non | Non | Oui, `type` / `rg --type` | Non |
| Multiline | Non | Non | Oui, `multiline` | Non |
| Lignes de contexte avant/après | Non | Oui, `context` | Oui, `-A`, `-B`, `-C`, `context` | Non, malgré le nom `context` qui groupe seulement les lignes matchées |
| Modes de sortie | Un seul mode contenu groupé | Un seul mode contenu | `files_with_matches`, `content`, `count` | `context`, `matches`, `files`, `count` |
| Pagination | Non | Non | Oui, `head_limit` + `offset` | Non |
| Limite par défaut | 100 résultats affichés | 100 matches | 250 lignes/entrées par défaut | `limit` obligatoire, hard-cap 500 |
| Troncature ligne | 2000 chars | 500 chars | 500 colonnes via `--max-columns` | 240 chars |
| Troncature globale | Oui via wrapper OpenCode, 50 KB / 2000 lignes | Oui, 50 KB | Oui, persistance disque dès 20 KB pour Grep | Oui par limite obligatoire + clipping, timeout 30s |
| Streaming parsing | Non, stdout bufferisé avant parsing | Oui, JSON line par line | Non pour `GrepTool.call`, helper bufferise puis post-traite | Oui, JSON line par line |
| Stop tôt au limit | Non | Oui, tue `rg` au limit | Non, limite appliquée après résultats | Non, lit tout pour calculer totals/counts |
| Permission lecture | Permission `grep` + permission dossier externe | Pas de couche permission dédiée visible dans le tool | Très avancée : read permissions, deny/ask/allow, symlinks, UNC, chemins internes | Pas de prompt permission dans le tool ; chemins relatifs bornés workspace, absolus autorisés |
| Résistance injection flags | Bonne, `--regexp` | Bonne, `--` avant pattern | Bonne, `-e` si pattern commence par `-` | Bonne, `--` avant pattern |
| Robustesse ripgrep | Télécharge/fallback rg si absent | Télécharge rg si absent | Système, builtin vendor, embedded, timeout, retry EAGAIN | Sidecar/env/PATH/Homebrew/local fallback |

---

## 1. OpenCode

### Fichiers principaux

- `packages/opencode/src/tool/grep.ts`
- `packages/opencode/src/tool/grep.txt`
- `packages/opencode/src/file/ripgrep.ts`

### Interface exposée au modèle

OpenCode expose un tool `grep` avec seulement :

```ts
{
  pattern: string,
  path?: string,
  include?: string
}
```

C’est volontairement simple : une regex, un dossier, éventuellement un glob de fichiers.

### Exécution réelle

Le tool construit une commande `rg` de ce style :

```bash
rg -nH --hidden --no-messages --field-match-separator='|' --regexp <pattern> [--glob <include>] <path>
```

Points importants :

- `--regexp` protège les patterns qui ressemblent à des flags.
- `--hidden` inclut les fichiers cachés.
- Le résultat est parsé via un séparateur texte `|`, pas via le JSON de ripgrep.
- Les matches sont triés par date de modification du fichier, les plus récents d’abord.
- Il affiche maximum **100 matches**.
- Chaque ligne matchée est tronquée à **2000 caractères**.
- Si OpenCode détecte une sortie trop grosse ensuite, le wrapper global peut tronquer et sauvegarder le résultat complet.

### Permissions et sécurité

OpenCode demande :

- une permission `grep` basée sur le pattern ;
- une permission `external_directory` si le chemin sort du workspace.

Côté injection shell, c’est propre : pas de shell string concaténée, arguments séparés, et pattern passé via `--regexp`.

### Points forts

- Très simple pour le modèle.
- Bon comportement sur les chemins externes grâce à `external_directory`.
- Tri par modification time utile pour trouver les fichiers récemment touchés.
- Troncature globale du framework OpenCode.

### Limites

- Pas de mode `files`, `count`, `matches only`.
- Pas d’`ignoreCase`, pas de recherche littérale, pas de multiline.
- Pas de contexte avant/après.
- Le parsing texte avec `|` est moins robuste que le JSON ripgrep.
- La sortie de `rg` est bufferisée avant traitement, donc une recherche très large peut coûter cher avant même la troncature.
- Le prompt dit explicitement : pour compter les matches, utiliser `Bash` avec `rg`. Ça rend le dedicated tool moins autonome.

### Résumé

OpenCode a un `grep` efficace, mais c’est surtout un **outil de découverte simple** : “donne-moi les lignes/fichiers où cette regex apparaît”. Il n’essaie pas d’être un mini-ripgrep complet.

---

## 2. Pi

### Fichier principal

- `packages/coding-agent/src/core/tools/grep.ts`

### Interface exposée

Pi expose :

```ts
{
  pattern: string,
  path?: string,
  glob?: string,
  ignoreCase?: boolean,
  literal?: boolean,
  context?: number,
  limit?: number
}
```

C’est plus riche qu’OpenCode, surtout grâce à :

- `ignoreCase`
- `literal`
- `context`
- `limit`

### Exécution réelle

Pi lance `rg` avec JSON :

```bash
rg --json --line-number --color=never --hidden [--ignore-case] [--fixed-strings] [--glob <glob>] -- <pattern> <path>
```

Le `--` avant le pattern est important : un pattern comme `--pre=evil.sh` reste du texte à chercher, pas une option ripgrep. Il y a même un test dédié contre cette injection.

### Gestion du limit

Pi a une bonne stratégie :

- limite par défaut : **100 matches** ;
- dès que le nombre de matches atteint la limite, il tue le process `rg` ;
- cela évite de continuer à scanner inutilement sur des recherches trop larges.

C’est plus efficient qu’un outil qui laisse `rg` finir puis coupe après coup.

### Contexte autour des matches

Si `context > 0`, Pi relit les fichiers matchés pour afficher les lignes avant/après :

```txt
file-10- ligne avant
file:11: ligne matchée
file-12- ligne après
```

Si `context = 0`, il évite ces lectures fichier et utilise directement le JSON de ripgrep. C’est un bon compromis performance/ergonomie.

### Troncature

- Ligne matchée tronquée à **500 chars**.
- Sortie totale tronquée à **50 KB**.
- Notice claire si :
  - limite de matches atteinte ;
  - sortie totale tronquée ;
  - certaines lignes sont tronquées.

### Points forts

- Très bon pour les recherches “montre-moi les lignes autour du match”.
- Supporte la recherche littérale, pratique pour éviter les problèmes de regex.
- Stoppe `rg` dès que la limite est atteinte.
- Résistant aux patterns qui ressemblent à des flags.
- `ensureTool("rg")` peut télécharger ripgrep si absent, sauf offline/Termux.

### Limites

- Un seul mode de sortie : du contenu textuel avec lignes matchées.
- Pas de `files only`.
- Pas de `count`.
- Pas de `matches only`.
- Pas de filtre `type` ripgrep.
- Pas de multiline.
- Pas de pagination `offset`.
- Pas de couche de permissions fichier aussi poussée que ClaudeCode dans le tool lui-même.

### Résumé

Pi est très fort pour le cas classique : “cherche ce pattern et montre-moi les lignes pertinentes avec un peu de contexte”. Il est performant et sain côté injection. Par contre, il n’est pas aussi polyvalent que ClaudeCode ou Sinew sur les modes de sortie.

---

## 3. ClaudeCode

### Fichiers principaux

- `tools/GrepTool/GrepTool.ts`
- `tools/GrepTool/prompt.ts`
- `utils/ripgrep.ts`
- `utils/permissions/filesystem.ts`
- `utils/toolResultStorage.ts`

### Interface exposée

ClaudeCode expose une interface très riche :

```ts
{
  pattern: string,
  path?: string,
  glob?: string,
  output_mode?: "content" | "files_with_matches" | "count",
  "-B"?: number,
  "-A"?: number,
  "-C"?: number,
  context?: number,
  "-n"?: boolean,
  "-i"?: boolean,
  type?: string,
  head_limit?: number,
  offset?: number,
  multiline?: boolean
}
```

C’est clairement le plus proche d’un vrai wrapper ripgrep utilisable par un agent.

### Modes de sortie

ClaudeCode a 3 modes :

1. `files_with_matches` — défaut, retourne seulement les fichiers.
2. `content` — retourne les lignes matchées, avec option de contexte.
3. `count` — retourne les counts par fichier.

Le mode par défaut `files_with_matches` est malin : il limite le bruit dans le contexte. L’agent peut ensuite lire seulement les fichiers utiles.

### Options avancées

ClaudeCode supporte :

- `glob` : filtre de fichiers ;
- `type` : filtre ripgrep par langage/type (`js`, `py`, `rust`, etc.) ;
- `-i` : ignore case ;
- `-A`, `-B`, `-C`, `context` : lignes autour du match ;
- `-n` : line numbers en mode content ;
- `multiline` : `rg -U --multiline-dotall` ;
- `head_limit` : limite les lignes/entrées retournées ;
- `offset` : pagination.

Le couple `head_limit + offset` est très important : ça permet de paginer une recherche large sans exploser le contexte.

### Exécution ripgrep

Le helper `utils/ripgrep.ts` est très travaillé :

- peut utiliser le `rg` système ;
- peut utiliser un `rg` vendor/builtin ;
- peut utiliser un mode embedded ;
- timeout par défaut : **20s**, **60s sous WSL** ;
- buffer max : **20 MB** ;
- retry en single-thread si erreur `EAGAIN` ;
- distingue “pas de match” d’un vrai timeout ;
- peut retourner des résultats partiels dans certains cas.

### Permissions et sécurité

C’est le gros point fort.

ClaudeCode branche `Grep` sur la logique de permissions de lecture :

- validation Zod stricte ;
- `validateInput` vérifie l’existence du path ;
- `checkReadPermissionForTool` applique :
  - deny rules ;
  - ask rules ;
  - allow rules ;
  - working directories autorisés ;
  - symlinks / chemins résolus ;
  - défense UNC paths ;
  - patterns Windows suspects ;
- les fichiers interdits par règles de lecture sont injectés comme `--glob !...`, donc ils sont cachés des résultats.

C’est plus qu’un simple “permission avant de lire” : le moteur essaie aussi de ne pas laisser apparaître des chemins interdits dans les résultats.

### Contrôle du bruit

ClaudeCode combine plusieurs niveaux :

- `head_limit` par défaut à **250** ;
- `head_limit = 0` possible pour unlimited, mais explicitement déconseillé ;
- `--max-columns 500` pour éviter les lignes minifiées/base64 énormes ;
- `maxResultSizeChars: 20_000` pour le GrepTool ;
- si le résultat est trop gros, il est persisté sur disque avec preview ;
- budget global par message de tool results.

### Points forts

- Le plus riche fonctionnellement.
- Meilleurs modes de sortie.
- Pagination native.
- Filtre `type` très utile.
- Multiline supporté.
- Permissions fichier très solides.
- Bonne robustesse ripgrep multi-plateforme.
- Ergonomie pensée pour économiser le contexte.

### Limites

- `head_limit` est appliqué après récupération des résultats, donc une recherche très large peut quand même faire travailler `rg` avant pagination.
- Le helper principal bufferise stdout, contrairement à un parser JSON streaming.
- L’interface est plus complexe pour le modèle : beaucoup d’options, donc plus de risques d’appel maladroit.

### Résumé

ClaudeCode est le plus puissant parce qu’il transforme `grep` en outil de recherche complet : découverte, contenu, comptage, pagination, permissions et gestion du contexte. C’est le harness le plus mature.

---

## 4. Sinew, notre repo

### Fichiers principaux

- `crates/sinew-app/src/grep.rs`
- `crates/sinew-app/src/ripgrep.rs`
- `crates/sinew-app/src/workspace.rs`

### Interface exposée

Sinew expose :

```json
{
  "pattern": "string",
  "path": ["string"],
  "include": "string",
  "limit": 100,
  "output_mode": "context | matches | files | count",
  "unique": false,
  "exclude_pattern": "string"
}
```

Points notables :

- `limit` est **obligatoire**.
- `limit` est hard-cap à **500**.
- `path` peut être un string ou une liste.
- les chemins relatifs sont résolus depuis le workspace ;
- les chemins absolus sont autorisés ;
- les chemins relatifs ne peuvent pas sortir du workspace.

### Modes de sortie

Sinew a 4 modes :

1. `context` — groupe par fichier et affiche ligne + contenu matché.
2. `matches` — affiche seulement les textes matchés par la regex.
3. `files` — affiche seulement les chemins de fichiers contenant un match.
4. `count` — affiche les counts par fichier.

C’est très bon pour un agent : selon l’intention, il peut demander exactement la granularité nécessaire.

Attention : dans Sinew, `context` ne veut pas dire “lignes avant/après le match”. Ça veut dire “sortie contextualisée par fichier + numéro de ligne”. Il n’y a pas encore d’équivalent `-A/-B/-C`.

### Exécution ripgrep

Sinew lance :

```bash
rg --json --line-number --color never --no-messages --with-filename [-g <include>] -- <pattern> <targets...>
```

Le parsing JSON est robuste et permet d’extraire :

- chemin ;
- numéro de ligne ;
- ligne complète ;
- submatches ;
- nombre d’occurrences.

### Gestion des paths

Sinew est assez propre ici :

- chemins relatifs normalisés ;
- `..` refusé ;
- absolus refusés dans le resolver workspace, sauf dans la branche explicitement prévue pour path absolu ;
- chemin relatif canonisé et vérifié dans le workspace ;
- chemins multiples dédupliqués.

Les tests couvrent :

- chemin absolu hors workspace ;
- chemins multiples ;
- déduplication ;
- output modes ;
- `unique` ;
- `exclude_pattern` ;
- `limit` requis.

### Troncature et limites

- `limit` obligatoire ;
- hard-cap à **500** ;
- lignes tronquées à **240 chars** ;
- stderr limité à **8 KB** ;
- timeout global : **30s**.

Le format de sortie commence par :

```txt
matches: N
files: M
shown: K
```

C’est très lisible pour l’agent : il sait combien il a vu et s’il doit raffiner.

### Points forts

- Très bonne API pour agent : `context`, `matches`, `files`, `count`.
- `limit` obligatoire, donc moins de risque d’exploser le contexte par accident.
- `matches` peut dédupliquer avec `unique`.
- `exclude_pattern` est pratique pour filtrer du bruit après match.
- Plusieurs paths en une seule recherche.
- Parsing JSON ripgrep robuste.
- Résolution workspace défensive.
- Tool relativement simple et lisible.

### Limites

- Pas d’`ignoreCase`.
- Pas de mode littéral.
- Pas de lignes avant/après (`-A/-B/-C`).
- Pas de filtre `type` ripgrep.
- Pas de multiline.
- Pas de pagination `offset`.
- Ne stoppe pas `rg` une fois `limit` atteint : il continue à lire toute la sortie pour calculer les totaux/counts exacts.
- Les chemins absolus hors workspace sont autorisés sans permission dédiée visible dans ce tool.
- Pas d’exclusion VCS codée en dur dans le tool ; comportement dépend surtout des defaults ripgrep / ignore files.

### Résumé

Sinew est déjà très solide. Il n’a pas autant d’options avancées que ClaudeCode, mais il a un design agent-friendly : modes de sortie précis, limite obligatoire, sortie compacte, parsing JSON, tests fournis. Pour beaucoup de workflows, il est plus pratique que Pi et OpenCode.

---

## Comparaison qualitative

### Puissance fonctionnelle

1. **ClaudeCode** : modes + contexte + type + multiline + pagination.
2. **Sinew** : très bons modes, mais manque flags avancés.
3. **Pi** : bon contexte autour des matches, mais un seul mode.
4. **OpenCode** : basique.

### Contrôle du contexte

1. **ClaudeCode** : defaults prudents, pagination, persistance disque, budget global.
2. **Sinew** : `limit` obligatoire + hard cap + sortie compacte.
3. **Pi** : match limit + 50 KB + clipping, très correct.
4. **OpenCode** : 100 matches + troncature globale, mais bufferise avant.

### Performance sur recherches larges

1. **Pi** : streaming JSON + kill de `rg` dès le limit.
2. **Sinew** : streaming JSON, timeout, mais lit tout pour les totaux.
3. **ClaudeCode** : timeout/retry très robustes, mais bufferise et limite après coup.
4. **OpenCode** : bufferise stdout et parse ensuite.

### Sécurité / permissions

1. **ClaudeCode** : clairement le plus avancé.
2. **OpenCode** : permissions tool + external directory.
3. **Sinew** : chemins relatifs bien bornés, mais absolus autorisés sans permission dédiée visible.
4. **Pi** : très bon contre l’injection flags, mais permission file moins intégrée au grep lui-même.

### Ergonomie pour un agent

1. **ClaudeCode** : le plus flexible, mais plus complexe.
2. **Sinew** : simple, strict, modes très clairs.
3. **Pi** : excellent pour lire autour d’un match.
4. **OpenCode** : simple, mais oblige parfois à basculer vers Bash/rg.

---

## Le plus puissant : ClaudeCode

ClaudeCode gagne parce qu’il coche presque toutes les cases :

- plusieurs modes de sortie ;
- pagination ;
- contexte avant/après ;
- filtre par type ;
- multiline ;
- gestion fine du contexte ;
- permissions avancées ;
- compat multi-plateforme ;
- timeouts et retries ;
- intégration UI/transcript.

En gros :

> OpenCode et Pi enveloppent `rg` pour un usage ciblé.  
> Sinew en fait un bon outil agent-friendly.  
> ClaudeCode en fait une vraie couche de recherche sécurisée, paginée et intégrée au runtime.

---

## Ce que Sinew pourrait reprendre

Si on veut rendre notre `Grep` plus puissant sans le rendre trop lourd, je recommanderais dans cet ordre :

### 1. Ajouter `ignore_case`

Simple à implémenter : passer `--ignore-case` à ripgrep.

```json
{
  "ignore_case": true
}
```

Gros gain ergonomique.

### 2. Ajouter `literal`

Permet de chercher une chaîne sans se battre avec les caractères regex.

```json
{
  "literal": true
}
```

Côté rg : `--fixed-strings`.

### 3. Ajouter du vrai contexte avant/après

Actuellement `context` groupe par fichier, mais ne donne pas les lignes autour.

On pourrait ajouter :

```json
{
  "before": 2,
  "after": 2
}
```

ou :

```json
{
  "context_lines": 2
}
```

### 4. Ajouter `type`

Très utile pour les gros repos :

```json
{
  "type": "rust"
}
```

Côté rg : `--type rust`.

### 5. Ajouter `offset`

Sinew a déjà `limit`, mais pas de pagination.

```json
{
  "limit": 100,
  "offset": 200
}
```

Ça permettrait de continuer une recherche sans refaire un pattern plus compliqué.

### 6. Optionnel : arrêter `rg` tôt selon le mode

Aujourd’hui Sinew continue de lire toute la sortie pour avoir des totaux exacts. C’est bien pour `matches/files/count`, mais coûteux sur une recherche énorme.

On pourrait ajouter une stratégie :

- mode rapide : stop dès que `limit` est atteint ;
- mode exhaustif : continuer pour compter précisément.

Exemple :

```json
{
  "exhaustive": false
}
```

Par défaut, pour un agent, le mode rapide est souvent suffisant.

---

## Conclusion

- **ClaudeCode** est le harness `grep` le plus puissant.
- **Sinew** est déjà très bien positionné, surtout grâce à ses modes `context/matches/files/count`, son `limit` obligatoire et son parsing JSON.
- **Pi** est le meilleur sur le couple “matches + contexte + arrêt rapide”.
- **OpenCode** est le plus simple, efficace mais limité.

Si l’objectif est d’améliorer Sinew, les deux features qui donneraient le meilleur ratio effort/gain sont :

1. `ignore_case`
2. `literal`

Ensuite : vrai contexte `before/after`, `type`, puis pagination `offset`.
