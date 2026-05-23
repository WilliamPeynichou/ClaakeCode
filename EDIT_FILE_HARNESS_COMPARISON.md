# Comparatif des harness d’édition de fichiers

Analyse corrigée selon la précision : **uniquement les tools d’édition** — pas `write`, pas `apply_patch`, pas create/delete/move comme outils séparés.

Repos comparés :

- **Sinew** — repo actuel
- **opencode** — `/Users/hyrak/opencode/opencode`
- **pi** — `/Users/hyrak/pi/pi`
- **ClaudeCode** — `/Users/hyrak/Downloads/ClaudeCode`

Par “harness edit”, j’entends : le tool dont le rôle explicite est de modifier un fichier existant par remplacement ciblé, et toute la couche autour qui le rend fiable : schéma d’entrée, validation, matching, stale check, locks, permissions, diff, LSP, etc.

---

## TL;DR

**Si on compare uniquement les tools d’édition : le plus puissant globalement est Sinew.**

Pourquoi : notre `edit_file` peut faire en un seul call :

- plusieurs fichiers,
- plusieurs remplacements par fichier,
- `replaceAll` par remplacement,
- remplacements matchés sur le contenu original,
- rejet des overlaps,
- fuzzy fallback conservateur,
- protection stale par fingerprint fort `size + mtime + sha256`.

**opencode** a le matcher le plus agressif et le plus “magique”, donc il récupère mieux les approximations du modèle. Mais son `edit` principal ne fait qu’un fichier et un remplacement par call, sauf `replaceAll`.

**pi** a un edit très propre pour plusieurs remplacements dans un seul fichier, mais sans read-before-write/stale guard fort.

**ClaudeCode** est le plus blindé côté produit/permissions/UX, mais son `FileEditTool` public reste un seul remplacement ciblé par call, avec `replace_all`.

---

## Classement centré uniquement sur `edit`

| Rang | Repo | Tool analysé | Verdict |
|---:|---|---|---|
| 1 | **Sinew** | `edit_file` | Le plus complet : multi-fichiers + multi-remplacements + fingerprint SHA-256 + fuzzy safe. |
| 2 | **opencode** | `edit` | Le plus fort en matching approximatif, avec LSP/format/permissions, mais mono-remplacement. |
| 3 | **pi** | `edit` | Très bon design multi-remplacements sur un fichier, simple et propre, mais moins protégé. |
| 4 | **ClaudeCode** | `FileEditTool` | Très robuste côté garde-fous produit, mais limité à un remplacement par call. |

> Nuance : si “puissant” veut dire “capable de retrouver le bon bloc malgré un vieux `oldString` approximatif”, **opencode** passe #1. Si “puissant” veut dire “capable d’exprimer beaucoup de modifications d’édition en un seul call avec garanties fortes”, **Sinew** passe #1.

---

## Matrice rapide

| Critère edit-only | Sinew | opencode | pi | ClaudeCode |
|---|---:|---:|---:|---:|
| Multi-fichiers dans le tool edit | **Oui** | Non | Non | Non |
| Plusieurs remplacements ciblés | **Oui** | Non, sauf `replaceAll` | Oui | Non, sauf `replace_all` |
| Match sur contenu original, non incrémental | **Oui** | N/A | Oui | N/A |
| `replace all` intégré | **Oui** | **Oui** | Non | **Oui** |
| Read-before-edit sur fichier existant | **Oui** | **Oui** | Non | **Oui** |
| Stale guard fort | **SHA-256 + mtime + size** | mtime + size | Non | mtime + comparaison contenu si full read |
| Fuzzy matching | Conservateur | **Très large** | Moyen/large | Léger : quotes |
| Préserve line endings | Oui | Oui | Oui | Oui |
| Préserve BOM/encodage | BOM UTF-8 | Pas vu comme garantie centrale | BOM | utf8/utf16le + line endings |
| Lock / sérialisation | Lock workspace optionnel | Lock par fichier | Queue par fichier | Discipline sync dans section critique |
| Diagnostics LSP après edit | Non direct | Oui | Non direct | Oui |
| Permissions utilisateur | Via cadre tool/app | Oui | Via cadre agent/TUI | **Très complet** |
| Risque de faux positif fuzzy | Faible | Moyen | Moyen | Faible |

Notes de lecture :

- Pour `replace all`, la matrice dit seulement si la capacité existe. La nuance Sinew est meilleure en granularité : `replaceAll` est porté par chaque entrée `files[].edits[]`, donc on peut mixer dans un même call des remplacements uniques et des remplacements globaux.
- Pour `read-before-edit`, la ligne compare uniquement l’édition d’un **fichier existant**. opencode et ClaudeCode ont aussi un chemin création/remplissage via `oldString === ""` / `old_string === ""`, mais ce n’est pas compté dans ce comparatif edit-only.

---

# 1. Sinew — `edit_file`

## Fichiers analysés

- `crates/sinew-app/src/edit.rs`
- `crates/sinew-app/src/read.rs` pour les fingerprints utilisés par `edit_file`
- `crates/sinew-app/src/team/agent_turns.rs` pour le lock workspace dans certains flows
- `src-tauri/src/turns.rs` pour l’instanciation du tool

## Schéma d’entrée

```json
{
  "files": [
    {
      "path": "src/file.rs",
      "edits": [
        {
          "oldContent": "texte exact à remplacer",
          "newContent": "nouveau texte",
          "replaceAll": false
        }
      ]
    }
  ]
}
```

Aliases acceptés côté Rust :

- `oldText` peut aliaser `oldContent`,
- `newText` peut aliaser `newContent`.

## Capacités d’édition

Sinew est le seul des quatre, dans le tool edit principal, à supporter nativement :

- **plusieurs fichiers en un seul appel** ;
- **plusieurs remplacements dans chaque fichier** ;
- `replaceAll` optionnel par remplacement ;
- application de tous les remplacements sur le **contenu original**, pas sur le résultat des edits précédents ;
- rejet des remplacements qui se chevauchent ;
- output avec résumé et `file_changes`.

Ça rend le tool très expressif. Exemple : un refactor simple sur deux fichiers peut passer en un seul `edit_file`, avec plusieurs blocs dans chaque fichier.

## Matching

Le fonctionnement est :

1. normalisation LF pour matcher indépendamment de CRLF ;
2. recherche exacte de `oldContent` ;
3. si pas trouvé, fallback fuzzy conservateur.

Le fuzzy couvre :

- trailing whitespace par ligne,
- smart quotes,
- tirets Unicode,
- espaces Unicode spéciaux,
- line endings.

Le point fort : Sinew construit une correspondance entre texte fuzzy et texte original. Donc même si le match est fuzzy, il remplace la vraie tranche du fichier original, sans réécrire tout le fichier dans une forme normalisée.

## Garde-fous

### Read-before-edit fort

Sinew impose d’avoir lu le fichier avant édition. Le `read` fournit un fingerprint :

- chemin relatif,
- taille,
- mtime en millisecondes,
- SHA-256 du contenu.

Avant d’écrire, `edit_file` recalcule le fingerprint et refuse si ça ne matche pas.

C’est la meilleure protection stale des quatre. Un simple mtime peut mentir ou être imprécis ; le SHA-256 non.

### Unicité obligatoire par défaut

Si `replaceAll` est false/absent et que `oldContent` apparaît plusieurs fois, l’outil refuse et demande plus de contexte. Si `replaceAll` est true, l’outil remplace toutes les occurrences non chevauchantes.

### Overlap check

Les remplacements d’un même fichier sont triés par position et l’outil refuse ceux qui se recouvrent.

### Préservation du format

Sinew préserve :

- BOM UTF-8,
- line endings LF/CRLF du fichier.

## Limites

- Ne crée pas de fichier via `edit_file`.
- Ne supprime/renomme rien, mais ce n’est pas le sujet ici.
- Diagnostics LSP non remontés directement après edit.
- Lock workspace optionnel : utilisé dans certains flows team, pas forcément partout.
- Multi-fichiers non transactionnel au niveau filesystem : si une écriture échoue au milieu, il peut rester un état partiel.

## Verdict Sinew

**Meilleur tool edit global.** Il combine capacité d’expression et sûreté : multi-fichiers, multi-remplacements, `replaceAll`, non-overlap, fuzzy raisonnable, et fingerprint SHA-256.

---

# 2. opencode — `edit`

## Fichiers analysés

- `/Users/hyrak/opencode/opencode/packages/opencode/src/tool/edit.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/tool/edit.txt`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/file/time.ts`
- `/Users/hyrak/opencode/opencode/packages/opencode/src/tool/external-directory.ts`

> Exclu volontairement ici : `apply_patch`, `write`, et `multiedit`, parce que la demande corrigée porte sur le tool edit principal.

## Schéma d’entrée

```ts
{
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean
}
```

## Capacités d’édition

- Un fichier par call.
- Un remplacement ciblé par call.
- `replaceAll` pour remplacer toutes les occurrences de `oldString`.
- `oldString === ""` déclenche un comportement de création/écriture dans ce même tool, mais je ne le compte pas comme “puissance create tool” ici.
- Préserve LF/CRLF en convertissant `oldString`/`newString` vers le line ending du fichier.
- Après écriture : formatage, file watcher event, LSP diagnostics.

## Matching : le plus puissant des quatre

opencode a une fonction `replace()` qui tente une série de stratégies :

1. exact match ;
2. lignes trimées ;
3. anchors de bloc début/fin ;
4. whitespace normalisé ;
5. indentation flexible ;
6. échappements normalisés (`\
`, `\	`, etc.) ;
7. frontières trimées ;
8. contexte approximatif ;
9. multi-occurrences pour `replaceAll`.

C’est le matcher le plus permissif. Quand le modèle fournit un `oldString` un peu faux, opencode a plus de chances de quand même réussir.

## Garde-fous

### Read-before-edit

Pour un edit normal, opencode appelle `FileTime.assert(sessionID, filePath)` :

- le fichier doit avoir été lu avant ;
- l’outil compare `mtime` et `size` depuis la lecture.

C’est bien, mais moins fort que Sinew car pas de hash contenu.

### Lock par fichier

`edit` est exécuté dans `FileTime.withLock(filePath, ...)`, donc deux edits sur le même fichier sont sérialisés dans ce process.

### Permissions

`assertExternalDirectory` demande permission si la cible est hors instance/workspace. Le tool peut donc éditer hors workspace si autorisé.

### Diff / LSP / formatage

Avant écriture, opencode produit un diff et demande permission. Après écriture :

- `Format.file(filePath)`,
- event watcher,
- `FileTime.read` pour rafraîchir l’état,
- `LSP.touchFile`,
- diagnostics LSP dans l’output si erreurs.

## Risques

- Les fallbacks de matching sont puissants mais peuvent être trop permissifs. Le risque de faux positif est plus élevé que Sinew.
- Un seul remplacement ciblé par call : moins expressif que Sinew/pi pour des modifications dispersées.
- Le formatage automatique peut modifier des zones non demandées explicitement.
- Stale guard basé sur `mtime + size`, pas hash.

## Verdict opencode

**Meilleur matcher.** Si le modèle est approximatif, opencode est celui qui a le plus de chances de retrouver le bloc. Mais en capacité d’expression pure du tool edit, il est derrière Sinew : mono-fichier, mono-remplacement, sauf `replaceAll`.

---

# 3. pi — `edit`

## Fichiers analysés

- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/edit.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/edit-diff.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts`
- `/Users/hyrak/pi/pi/packages/coding-agent/src/core/tools/path-utils.ts`

## Schéma d’entrée

```ts
{
  path: string,
  edits: [
    {
      oldText: string,
      newText: string
    }
  ]
}
```

Il accepte aussi un input legacy avec `oldText` / `newText` au top-level et le convertit en `edits[]`.

## Capacités d’édition

- Un fichier par call.
- Plusieurs remplacements par call.
- Tous les remplacements sont matchés sur le contenu original.
- Rejet des overlaps.
- Rejet de `oldText` vide.
- Préserve BOM et line endings.
- Retourne diff d’affichage, patch unifié, et première ligne changée.
- Preview diff dans le TUI avant exécution.

Structurellement, c’est proche de Sinew mais limité à un seul fichier.

## Matching

`edit-diff.ts` fait :

1. normalisation LF,
2. exact match,
3. fuzzy match.

Le fuzzy normalise :

- Unicode NFKC,
- trailing whitespace,
- smart quotes,
- tirets Unicode,
- espaces Unicode spéciaux.

Différence importante avec Sinew : si un match fuzzy est utilisé, pi bascule sur un `baseContent` fuzzy-normalisé. Le résultat peut donc normaliser plus que la zone strictement remplacée. C’est pratique mais moins conservateur.

## Garde-fous

### Queue par fichier

`withFileMutationQueue` sérialise les mutations sur le même fichier, avec une clé basée sur `realpathSync.native` quand possible.

### Pas de read-before-edit fort

Le tool lit le fichier juste avant d’appliquer, mais ne vérifie pas que le modèle l’a lu auparavant ni que la vue du modèle est encore fraîche.

Donc si un fichier a changé entre le moment où le modèle l’a consulté et le moment où il édite, l’outil ne protège pas contre ça, sauf si `oldText` ne matche plus.

### Pluggable operations

Le tool peut recevoir des opérations custom : `readFile`, `writeFile`, `access`. C’est élégant pour remote/SSH ou autres filesystems.

## Risques

- Pas de fingerprint/stale guard.
- Pas de multi-fichiers.
- Pas de `replaceAll`.
- Fuzzy peut normaliser globalement le contenu utilisé pour l’édition.

## Verdict pi

**Très bon design d’edit multi-remplacements mono-fichier.** Simple, propre, facile à maintenir. Mais moins robuste que Sinew/ClaudeCode contre les fichiers modifiés depuis lecture.

---

# 4. ClaudeCode — `FileEditTool`

## Fichiers analysés

- `/Users/hyrak/Downloads/ClaudeCode/tools/FileEditTool/FileEditTool.ts`
- `/Users/hyrak/Downloads/ClaudeCode/tools/FileEditTool/utils.ts`
- `/Users/hyrak/Downloads/ClaudeCode/tools/FileEditTool/types.ts`
- `/Users/hyrak/Downloads/ClaudeCode/tools/FileEditTool/prompt.ts`
- `/Users/hyrak/Downloads/ClaudeCode/tools/FileReadTool/FileReadTool.ts` pour `readFileState`

> Exclu volontairement ici : `FileWriteTool` et les autres tools.

## Schéma d’entrée

```ts
{
  file_path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean
}
```

## Capacités d’édition

- Un fichier par call.
- Un remplacement ciblé par call.
- `replace_all` pour remplacer toutes les occurrences.
- `old_string === ""` peut créer un fichier inexistant ou remplir un fichier vide, mais ce n’est pas compté ici comme tool create séparé.
- Préserve encodage et line endings pour edit.
- Refuse `.ipynb`, redirigé vers `NotebookEditTool`.
- Taille max éditable : `1 GiB`.

## Matching

ClaudeCode est plus strict :

1. exact match ;
2. fallback avec normalisation des quotes curly vers quotes droites.

Ensuite :

- si plusieurs matches et `replace_all` false → refus ;
- si `replace_all` true → remplacement global ;
- `preserveQuoteStyle` réapplique des quotes curly dans `new_string` si le fichier utilisait ce style.

Il ne tente pas les gros fallbacks d’opencode ni le fuzzy whitespace/dash de Sinew/pi.

## Garde-fous

ClaudeCode est très fort autour de l’edit :

- permissions filesystem ;
- deny rules ;
- protection UNC Windows pour éviter fuites NTLM ;
- secret guard sur team memory ;
- validation spéciale des settings ;
- obligation de lire le fichier avant edit ;
- refus si la lecture était partielle ;
- stale check via mtime ;
- fallback comparaison contenu si le fichier a été lu entièrement ;
- file history backup ;
- LSP notifications ;
- VSCode diff notification ;
- mise à jour de `readFileState` après edit.

## Atomicité pratique

Dans la section critique du `call`, le code évite les `await` entre :

1. lecture/stale check,
2. calcul du patch,
3. écriture disque.

Ce n’est pas une transaction OS, mais c’est une bonne discipline pour réduire les races dans le process.

## Risques / limites

- Pas de multi-remplacements, hors `replace_all`.
- Pas de multi-fichiers.
- Matching strict : moins capable de récupérer les approximations du modèle.
- Stale guard sans hash systématique.

## Verdict ClaudeCode

**Meilleur harness produit autour d’un edit simple.** Permissions, historique, LSP, IDE, staleness : c’est très mûr. Mais comme tool d’édition pur, il est moins expressif que Sinew/pi, et moins tolérant qu’opencode.

---

# Comparaison par dimension

## 1. Expressivité du tool edit

| Repo | Expressivité |
|---|---|
| Sinew | Plusieurs fichiers + plusieurs remplacements par fichier + `replaceAll` granularisé par remplacement. |
| pi | Plusieurs remplacements, mais un seul fichier. |
| opencode | Un remplacement, un fichier, avec `replaceAll`. |
| ClaudeCode | Un remplacement, un fichier, avec `replace_all`. |

Gagnant : **Sinew**.

## 2. Matching le plus tolérant

| Repo | Matching |
|---|---|
| opencode | Beaucoup de stratégies : trim, anchors, whitespace, indentation, escapes, contexte. |
| Sinew | Fuzzy conservateur avec mapping vers original. |
| pi | Fuzzy Unicode/whitespace, mais normalise plus largement. |
| ClaudeCode | Exact + quotes curly. |

Gagnant puissance brute du matcher : **opencode**.

Gagnant sûreté du matcher : **Sinew**.

## 3. Protection contre fichier stale

| Repo | Mécanisme |
|---|---|
| Sinew | Fingerprint `size + mtime + sha256`. |
| ClaudeCode | `readFileState`, mtime, comparaison contenu si full read. |
| opencode | `FileTime.assert`, mtime + size. |
| pi | Pas de garde fort. |

Gagnant : **Sinew**.

## 4. Concurrence / locks

| Repo | Mécanisme |
|---|---|
| opencode | Lock par fichier via `FileTime.withLock`. |
| pi | Queue par fichier. |
| Sinew | Lock workspace optionnel dans certains flows. |
| ClaudeCode | Section critique sync sans `await`; pas vu comme lock générique. |

Gagnant technique sur lock direct : **opencode/pi**.

Mais si on combine avec stale guard, Sinew reste plus sûr contre les changements externes.

## 5. Feedback après edit

| Repo | Feedback |
|---|---|
| ClaudeCode | Patch structuré, LSP, VSCode, history, analytics. |
| opencode | Diff, LSP diagnostics, formatage, watcher. |
| pi | Diff d’affichage, patch unifié, première ligne changée, preview TUI. |
| Sinew | Résumé, file_changes, fingerprints mis à jour. |

Gagnant produit : **ClaudeCode**.

---

# Verdict final edit-only

## Le plus puissant comme tool edit : Sinew

Sinew gagne parce que son `edit_file` est le seul à combiner :

- multi-fichiers,
- multi-remplacements,
- `replaceAll` par remplacement,
- matching sur original,
- rejet overlaps,
- fuzzy conservateur,
- fingerprint SHA-256 avant écriture.

C’est le meilleur compromis entre **capacité d’expression** et **sécurité**.

## Le plus fort pour sauver un vieux `oldString` approximatif : opencode

Son `edit` a le meilleur moteur de recherche/remplacement fuzzy. Mais il est plus risqué : un matcher aussi permissif peut se tromper de bloc si le contexte est faible.

## Le plus clean mono-fichier multi-edit : pi

pi a un très bon design pour plusieurs remplacements dans un fichier. Il lui manque surtout un read-before-edit avec fingerprint.

## Le plus robuste produit autour d’un edit simple : ClaudeCode

ClaudeCode a la meilleure couche permissions/UX/LSP/historique, mais son `FileEditTool` est volontairement simple : un remplacement par call.

---

# Recommandations pour Sinew, en restant edit-only

Sans parler de `apply_patch` ou autres tools séparés, voilà ce qui renforcerait encore `edit_file` :

1. **Uniformiser le write lock** sur toutes les instanciations de `EditFileTool`, pas seulement certains flows team.

2. **Ajouter diagnostics optionnels après edit**, sans forcément formater automatiquement.

3. **Garder le fuzzy conservateur**, ne pas copier tous les fallbacks opencode. Ajouter éventuellement une tolérance indentation stricte, mais toujours avec unicité forte.

4. **Améliorer l’atomicité multi-fichiers** : plan complet déjà fait, mais on pourrait écrire via fichiers temporaires + rename ou prévoir un rollback best-effort en cas d’échec.

---

# Conclusion

En version corrigée, uniquement sur les tools edit :

- **Sinew** = meilleur tool edit global.
- **opencode** = meilleur matcher approximatif.
- **pi** = meilleur design simple multi-remplacements mono-fichier.
- **ClaudeCode** = meilleure couche produit autour d’un edit simple.

Donc oui frérot, en retirant `apply_patch`, `write`, create/delete/move et compagnie, **opencode ne gagne plus la comparaison globale**. Son `edit` est impressionnant sur le matching, mais notre `edit_file` est plus puissant comme outil d’édition structuré.
