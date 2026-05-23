# Comparatif des harness de tool `glob`

Date d'analyse : 2026-05-22

Repos analysés :

- OpenCode : `/Users/hyrak/opencode/opencode`
- Pi : `/Users/hyrak/pi/pi`
- ClaudeCode : `/Users/hyrak/Downloads/ClaudeCode`
- Sinew, notre repo actuel

## TL;DR

Si on parle de **puissance globale du harness** — pas juste “qui liste le plus de fichiers”, mais aussi robustesse, permissions, gestion des gros repos, intégration système et qualité des garde-fous — le plus puissant est **ClaudeCode**.

Pourquoi : son `GlobTool` est très intégré au runtime : permissions de lecture, exclusions venant des règles utilisateur, gestion des chemins absolus dans le pattern, ripgrep embarqué/vendor/system, timeouts, retry en mode mono-thread si `rg` galère, sortie structurée, limite configurable par le contexte, et exclusions spécifiques internes.

En revanche, si on regarde uniquement “combien de résultats l'agent peut demander directement”, **Sinew** et **Pi** sont plus généreux par défaut : Sinew hard-cap à 1000 via `limit` obligatoire, Pi default à 1000 via `limit` optionnel. ClaudeCode et OpenCode sont plutôt calibrés à 100 résultats par appel.

Classement synthétique :

1. **ClaudeCode** — le plus complet et robuste côté harness.
2. **Sinew** — très propre, simple, rapide, bon contrôle de sortie, mais moins riche en permissions/stratégies.
3. **Pi** — excellent usage de `fd`, gros volume, bon respect des `.gitignore`, mais tool nommé `find` et harness moins sécurisé/intégré.
4. **OpenCode** — solide et simple, mais fixed limit 100 et moins de contrôle.

## Ce que j'appelle “harness” ici

Je ne compare pas seulement le glob pattern en lui-même. Je compare tout ce qui entoure le tool :

- le schéma d'entrée exposé au modèle ;
- la résolution des chemins ;
- le moteur utilisé (`rg`, `fd`, lib JS `glob`) ;
- le respect ou non de `.gitignore` ;
- la gestion des fichiers cachés ;
- les limites de résultats ;
- le tri ;
- les permissions ;
- la robustesse quand le repo est énorme ou quand le binaire manque ;
- le format de sortie donné au modèle.

## Tableau comparatif rapide

| Repo | Tool exposé | Moteur | Entrée | Limite | Ignore / hidden | Tri | Chemins hors workspace | Robustesse notable |
|---|---:|---|---|---:|---|---|---|---|
| OpenCode | `glob` | `rg --files` via `Ripgrep.files` | `pattern`, `path?` | 100 fixe | hidden inclus, `.git` exclu, respecte les ignore files de `rg` | mtime descendant, mais seulement sur les 100 premiers collectés | possible avec permission `external_directory` | binaire `rg` auto trouvé/téléchargé |
| Pi | `find` | `fd` | `pattern`, `path?`, `limit?` | 1000 par défaut, configurable | hidden inclus, respecte `.gitignore`, `--no-require-git` | ordre `fd` | oui, via résolution de chemin, pas de permission dédiée repérée | télécharge/cherche `fd`, support custom ops |
| ClaudeCode | `Glob` | `rg --files` | `pattern`, `path?` | 100 par défaut via contexte | hidden inclus par défaut, `.gitignore` ignoré par défaut (`--no-ignore`), deny rules ajoutées en exclusions | `--sort=modified` | oui mais permission read complète | `rg` system/builtin/embedded, timeout, retry EAGAIN, partial results |
| Sinew | `Glob` | `rg --files` | `pattern`, `path?`, `limit` obligatoire | hard-cap 1000 | hidden inclus, `.git/**` exclu, respecte les ignore files de `rg` | `--sort path` | absolus autorisés, même hors workspace | timeout 30s, stderr limité, streaming stdout |

## 1. OpenCode

Sources principales :

- `/Users/hyrak/opencode/opencode/packages/opencode/src/tool/glob.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/file/ripgrep.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/tool/external-directory.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/util/glob.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/test/util/glob.test.ts`

### Comment ça marche

Le tool `glob` prend :

```ts
{
  pattern: string,
  path?: string
}
```

Il demande une permission `glob`, résout `path` relativement à `Instance.directory` si besoin, vérifie les accès hors projet avec `assertExternalDirectory`, puis lance `Ripgrep.files` :

```ts
Ripgrep.files({
  cwd: search,
  glob: [params.pattern],
  signal: ctx.abort,
})
```

Sous le capot, `Ripgrep.files` utilise `rg --files`, ajoute `--hidden`, exclut `.git`, applique les globs fournis, et streame stdout.

### Points forts

- Simple, lisible, peu de surface de bugs.
- Utilise `rg`, donc très rapide sur gros repos.
- Permission explicite pour les dossiers externes.
- Le binaire `rg` est bien géré : système si dispo, sinon téléchargement dans le dossier global OpenCode.
- Sortie triée par date de modification descendante côté tool, ce qui est utile pour trouver les fichiers récents.

### Limites

- Limite **fixe à 100**. Le modèle ne peut pas demander 500 ou 1000 résultats.
- Le tri par mtime se fait **après** avoir collecté les 100 premiers résultats renvoyés par `rg`. Donc ce n'est pas forcément “les 100 fichiers les plus récents du repo”, mais plutôt “les 100 premiers matchés, ensuite triés par mtime”.
- Output en chemins absolus, potentiellement plus verbeux en tokens.
- `path` doit être un dossier valide.
- Moins de knobs que ClaudeCode ou Sinew : pas de `limit`, pas d'offset, pas d'option ignore/hidden exposée.

### Verdict OpenCode

Très correct, très pragmatique. C'est un glob “rapide et utile”, mais pas le plus puissant. Il privilégie la simplicité et une UX stable plutôt que la configurabilité.

## 2. Pi

Sources principales :

- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/find.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/src/utils/tools-manager.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/path-utils.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/test/suite/regressions/3303-find-nested-gitignore.test.ts`

Important : Pi n'a pas un tool nommé `Glob`. Son équivalent est **`find`**, décrit comme “Search for files by glob pattern”.

### Comment ça marche

Schéma :

```ts
{
  pattern: string,
  path?: string,
  limit?: number
}
```

Par défaut :

- `limit = 1000` ;
- moteur = `fd` ;
- `--glob` ;
- `--hidden` ;
- `--no-require-git` ;
- `--max-results <limit>`.

Quand le pattern contient `/`, Pi passe `fd` en `--full-path` et ajoute parfois un préfixe `**/` pour que des patterns comme `src/**/*.spec.ts` marchent contre le chemin absolu candidat.

C'est justement couvert par le test de régression `3302-find-path-glob.test.ts`.

### Points forts

- Très bon choix pour la recherche de fichiers : `fd` est ultra rapide et ergonomique.
- Limite configurable côté modèle, avec défaut à 1000.
- Bon traitement des patterns avec segments de chemin (`src/**/*.ts`, `**/parent/child/*`).
- Respect hiérarchique des `.gitignore` via `fd --no-require-git`, y compris hors repo git.
- Test de régression sur les `.gitignore` imbriqués : Pi a corrigé un vrai piège où un `.gitignore` d'un dossier pouvait fuiter sur un dossier frère.
- Possibilité de brancher des `customOps.glob`, utile pour déléguer à un système distant ou à une extension.

### Limites

- Ce n'est pas le tool `Glob` canonique, mais `find`. En mode “compat ClaudeCode”, le provider connaît le nom `Glob`, mais l'implémentation locale exposée ici est `find`.
- Pas de couche de permission dédiée repérée dans ce tool lui-même.
- Pas de timeout explicite dans `find.ts`, même si l'`AbortSignal` permet d'annuler.
- `fd` peut retourner des entrées qui ne sont pas strictement des fichiers selon le pattern et les options, vu qu'il n'y a pas de `--type f`.
- Le output est tronqué aussi par taille : 50 KB via `truncateHead`, donc `limit=1000` ne garantit pas que tout soit visible si les chemins sont longs.

### Verdict Pi

Pi est probablement le meilleur pour la **recherche brute de chemins par glob** si on aime `fd` et qu'on veut beaucoup de résultats. Par contre, son harness est moins riche en sécurité/permissions que ClaudeCode, et moins “tool glob standard” que les autres.

## 3. ClaudeCode

Sources principales :

- `/Users/hyrak/Downloads/ClaudeCode/tools/GlobTool/GlobTool.ts`
- `/Users/hyrak/Downloads/ClaudeCode/utils/glob.ts`
- `/Users/hyrak/Downloads/ClaudeCode/utils/ripgrep.ts`
- `/Users/hyrak/Downloads/ClaudeCode/utils/permissions/filesystem.ts`
- `/Users/hyrak/Downloads/ClaudeCode/tools.ts`
- `/Users/hyrak/Downloads/ClaudeCode/utils/bash/ShellSnapshot.ts`

### Comment ça marche

Schéma :

```ts
{
  pattern: string,
  path?: string
}
```

Le tool appelle :

```ts
glob(input.pattern, GlobTool.getPath(input), { limit, offset: 0 }, signal, permissionContext)
```

Puis `utils/glob.ts` prépare `rg` :

```txt
rg --files --glob <pattern> --sort=modified --no-ignore --hidden
```

Par défaut :

- `--no-ignore` est activé, donc ClaudeCode **ignore `.gitignore` par défaut** ;
- `--hidden` est activé ;
- ces deux comportements sont contrôlables par env vars :
  - `CLAUDE_CODE_GLOB_NO_IGNORE=false` pour respecter `.gitignore` ;
  - `CLAUDE_CODE_GLOB_HIDDEN=false` pour exclure les fichiers cachés.

Il ajoute aussi des exclusions venant des règles de permissions `Read` deny, plus des exclusions pour des caches/plugins internes.

### Points forts

- C'est le harness le plus complet.
- Permissions de lecture intégrées via `checkReadPermissionForTool`.
- Les deny rules ne servent pas juste à bloquer après coup : elles deviennent des `--glob !pattern` pour cacher les fichiers interdits dès la recherche.
- Support des patterns absolus : si `pattern` est absolu, ClaudeCode extrait la base statique et transforme le reste en pattern relatif, parce que `rg --glob` travaille mieux avec des patterns relatifs.
- Sortie structurée : `durationMs`, `numFiles`, `filenames`, `truncated`.
- Runtime `rg` très robuste : système, builtin vendor, ou embedded ; codesign si nécessaire ; timeout ; buffer max ; retry `EAGAIN` en mono-thread ; partial results si possible.
- `maxResultSizeChars: 100_000`, donc le framework sait gérer la taille du résultat.
- Certains builds ont des search tools embarqués : dans ce cas, `Glob/Grep` sont retirés et remplacés par des wrappers shell `find/grep` basés sur `bfs/ugrep`.

### Limites

- Limite par défaut à 100 résultats, non exposée directement dans le schéma du tool. Elle peut venir de `globLimits`, mais le modèle ne passe pas `limit` lui-même.
- `numFiles` représente les fichiers renvoyés après slice, pas le total global des matchs.
- `ripGrep()` bufferise la sortie complète avant de slicer, donc sur un très gros matchset ça peut consommer plus qu'un streaming avec arrêt précoce. Il y a cependant un max buffer de 20 MB et un timeout.
- Le choix `--no-ignore` par défaut est puissant mais surprenant : il trouve plus de choses, y compris ce que le projet voulait souvent ignorer.

### Verdict ClaudeCode

C'est le plus puissant globalement. Il ne gagne pas par la limite de résultats, mais par la qualité du harness autour : permissions, robustesse du binaire, règles d'exclusion, gestion des chemins, intégration runtime.

## 4. Sinew, notre implémentation

Sources principales :

- `crates/sinew-app/src/glob.rs`
- `crates/sinew-app/src/ripgrep.rs`
- `crates/sinew-app/src/workspace.rs`

### Comment ça marche

Schéma :

```json
{
  "pattern": "string",
  "path": "string?",
  "limit": "integer required, 1..1000"
}
```

Le tool lance :

```txt
rg --files --hidden --color never --no-messages --sort path \
  -g '!.git/**' -g '<pattern>' -- <target>
```

Il exécute `rg` depuis `workspace_root`, streame stdout ligne par ligne, convertit les chemins en chemins relatifs au workspace quand possible, compte tous les matchs, et n'affiche que les `limit` premiers.

### Points forts

- Schéma clair et strict : `pattern` + `limit` obligatoires, `path` optionnel.
- Hard cap explicite à 1000, ce qui évite les outputs ingérables.
- Le modèle sait combien il a demandé, et le résultat indique :
  - `matches: N` ;
  - `shown: M` si tronqué ;
  - puis la liste.
- Timeout de 30 secondes.
- Lecture streaming de stdout : pas besoin d'attendre tout le buffer pour commencer à traiter.
- `stderr` limité à 8 KB.
- `.git/**` explicitement exclu.
- Fichiers cachés inclus.
- Accepte les chemins absolus, y compris hors workspace. Si le fichier trouvé est hors workspace, il reste en chemin absolu dans la sortie.
- Très bonne gestion du binaire `rg` : env `SINEW_RG_PATH`, sidecars Tauri, PATH, fallback Homebrew.
- Tests utiles : limite, no match, hidden paths, path absolu workspace, path absolu externe, `limit` obligatoire.

### Limites

- Pas de permission gate dédiée repérée dans `GlobTool` lui-même pour les chemins absolus hors workspace.
- Tri par chemin (`--sort path`), pas par pertinence ou date de modification.
- Même avec `limit=10`, Sinew continue de lire toute la sortie pour compter `total_matches`. C'est bien pour informer le modèle, mais sur un énorme repo ça peut coûter plus cher qu'un arrêt précoce.
- Pas d'options exposées pour :
  - respecter ou ignorer `.gitignore` explicitement ;
  - inclure/exclure les hidden ;
  - choisir le tri ;
  - offset/pagination.
- Les chemins relatifs sont sécurisés dans le workspace, mais les absolus sont volontairement ouverts.

### Verdict Sinew

Notre version est très saine : simple, testée, déterministe, et plus contrôlable qu'OpenCode grâce au `limit` obligatoire. Elle est moins “grosse machine” que ClaudeCode, mais elle est plus lisible et plus facile à maintenir.

## Classements par critère

### Puissance globale du harness

1. **ClaudeCode**
2. **Sinew**
3. **Pi**
4. **OpenCode**

ClaudeCode gagne grâce à ses permissions, son runtime `rg` blindé et ses exclusions dynamiques.

### Volume de résultats contrôlable par le modèle

1. **Sinew** — `limit` obligatoire jusqu'à 1000.
2. **Pi** — `limit` optionnel, défaut 1000.
3. **ClaudeCode** — 100 par défaut, ajustable seulement par contexte interne.
4. **OpenCode** — 100 fixe.

### Respect naturel du projet et des `.gitignore`

1. **Pi** — très bon avec `fd --no-require-git` et tests dédiés.
2. **Sinew** — respecte le comportement ignore de `rg`, exclut `.git/**`.
3. **OpenCode** — idem `rg`, exclut `.git`.
4. **ClaudeCode** — volontairement `--no-ignore` par défaut, donc plus large mais moins respectueux du repo.

### Sécurité / permissions

1. **ClaudeCode**
2. **OpenCode**
3. **Sinew**
4. **Pi**

ClaudeCode est largement devant sur ce point : deny rules, ask rules, working dirs, chemins UNC/suspects, permissions Read, etc.

### Simplicité et maintenabilité

1. **Sinew**
2. **OpenCode**
3. **Pi**
4. **ClaudeCode**

ClaudeCode est puissant, mais c'est aussi le plus chargé conceptuellement.

## Le plus puissant, franchement

**ClaudeCode** est le plus puissant au sens “harness de production complet”.

Il ne fait pas juste un `rg --files`. Il sait :

- trouver ou embarquer `rg` ;
- survivre aux gros repos ;
- appliquer les permissions ;
- cacher ce que l'utilisateur a interdit ;
- gérer des chemins absolus dans le pattern ;
- limiter, structurer et renderer la sortie ;
- adapter son comportement selon le build avec des search tools embedded.

C'est moins élégant que Sinew, mais c'est plus blindé.

## Ce qu'on pourrait voler pour Sinew

Priorité haute :

1. **Permission/guard pour les chemins absolus hors workspace**  
   Aujourd'hui Sinew les accepte. C'est puissant, mais un prompt ou une règle explicite serait plus safe.

2. **Option de tri**  
   Garder `path` par défaut, mais permettre `modified` ou `modified_desc` serait utile.

3. **Mode arrêt précoce vs comptage total**  
   Exemple : `count_total: true/false`. Pour `limit=20` sur un monorepo, parfois on veut juste les 20 premiers vite.

Priorité moyenne :

4. **Options ignore/hidden explicites**  
   Par exemple :

   ```json
   {
     "respect_gitignore": true,
     "hidden": true
   }
   ```

5. **Pagination / offset**  
   Utile si `matches: 5000` et qu'on veut explorer la suite.

6. **Exclusions dynamiques**  
   ClaudeCode transforme les deny rules en `-g '!pattern'`. Si Sinew ajoute un système de permission, c'est le bon pattern.

Priorité basse :

7. **Sortie structurée en metadata**  
   Aujourd'hui la sortie texte est très lisible. Mais un `meta` avec `{ total_matches, shown, truncated }` serait plus facile à exploiter côté UI.

## Conclusion

- **Meilleur global : ClaudeCode**.
- **Meilleur compromis simplicité/contrôle : Sinew**.
- **Meilleur moteur de découverte de fichiers pur : Pi avec `fd`**.
- **Plus simple mais moins configurable : OpenCode**.

Sinew n'est pas loin d'un très bon niveau. Le gros gap par rapport à ClaudeCode n'est pas le glob lui-même : c'est surtout la couche de permissions, les options de comportement, et la robustesse runtime autour des cas extrêmes.
