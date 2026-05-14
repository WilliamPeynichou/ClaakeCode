# Plan — Refactoring des trois plus gros fichiers

## Règle absolue
**Refactoring pur, zéro changement de comportement.**
Pas d'optimisation, pas de simplification d'algorithme, pas de renommage opportuniste, pas de petit fix "tant qu'on y est", pas de code mort supprimé. On déplace du code existant, c'est tout. Si quelque chose paraît améliorable au passage, on le laisse strictement tel quel.

## Périmètre
Trois fichiers exactement, et eux seuls :

- `src-tauri/src/lib.rs` (~6600 lignes)
- `crates/sinew-app/src/team.rs` (~4800 lignes)
- `crates/sinew-app/src/agent.rs` (~2600 lignes)

Aucun autre fichier du projet ne doit être modifié, en dehors des imports situés ailleurs qui pointent vers ces trois là et qui devraient idéalement continuer à fonctionner sans aucune adaptation.

## Approche, pour chacun des trois fichiers

1. **Cartographier les responsabilités présentes** : identifier les grands blocs thématiques qui cohabitent dans le fichier (par exemple un domaine fonctionnel ici, une catégorie d'opérations là, des helpers, des types de données, des points d'entrée exposés à l'extérieur, etc.).

2. **Découper de façon ambitieuse** : viser entre 8 et 12 sous-modules par fichier d'origine, chacun dans son propre fichier dédié, regroupés par responsabilité cohérente.

3. **Vider le fichier d'origine** au maximum : il ne doit plus contenir que les déclarations de sous-modules, d'éventuelles ré-exportations nécessaires pour préserver la surface publique, et tout au plus quelques éléments transverses qui n'appartiennent à aucun groupe.

4. **Préserver à l'identique** la surface publique (tout ce qui est appelé depuis l'extérieur du fichier) ainsi que toutes les signatures des fonctions et types utilisés ailleurs dans le projet.

## Règles strictes pendant le déplacement

- Ne pas modifier le corps d'une fonction, ne serait-ce que d'une ligne.
- Ne pas renommer une fonction, un type, une constante, une variable.
- Ne pas changer la visibilité d'un élément, sauf si le déplacement vers un sous-module l'exige strictement.
- Ne pas introduire de nouvelles abstractions (nouveaux traits, structures intermédiaires, alias de type), sauf cas exceptionnel où c'est strictement requis pour résoudre une dépendance circulaire entre deux sous-modules nouvellement créés.
- Ne pas factoriser des fonctions qui se ressemblent, même si c'est tentant.
- Ne pas supprimer du code mort apparent.
- Les imports peuvent évidemment être réorganisés, c'est inévitable.

## Validation après chaque fichier traité

1. La compilation passe sans erreur.
2. Le linter Rust strict signale **zéro avertissement** (état actuel à préserver).

Si l'un des deux critères n'est pas satisfait, le découpage de ce fichier est considéré comme cassé et doit être corrigé avant de passer au suivant.

## Ordre de traitement
Libre. L'agent choisit l'ordre qui lui paraît le plus sûr : il peut par exemple commencer par le plus petit pour roder l'approche, puis monter en taille.

## Livraison
Une passe complète par fichier, dans cet ordre :
- traitement du fichier
- vérification compile + linter
- commit dédié dont le message indique clairement qu'il s'agit d'un refactoring sans changement de comportement
- passage au fichier suivant

Trois commits au total, un par fichier traité.
