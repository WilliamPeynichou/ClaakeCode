# Claaky3D — état actuel du prototype

## Objectif

Créer dans Blender une scène 3D représentant Claaky et son espace de travail, puis faire évoluer la scène selon l’activité de l’agent IA. Le projet doit d’abord être prototypé dans Claake Code ; une intégration sous forme d’extension VS Code pourra venir ensuite.

## Fichier principal

- `claaky_bureau.py` : script Python procédural Blender qui génère la scène du bureau/chambre.
- `plansClaaky3DforBlender.md` : plan général de conception et de réalisation.

Le script est conçu pour Blender 4.2+ et utilise `bpy`, sans asset externe. Il crée une nouvelle scène Blender sans supprimer les scènes existantes. Le rendu se lance avec F12 ; la timeline permet de tester une animation de frappe.

## Modifications réalisées

### Lit

Le lit a été déplacé vers le bas à gauche de la pièce en modifiant son centre dans `bed_and_rug()` :

```python
bx, by = -1.95, -1.82
```

Les éléments du lit (cadre, pieds, matelas, tête de lit, oreiller et couverture) sont placés relativement à ce centre.

### Meuble sous la fenêtre

Le meuble bas sous la fenêtre a été retiré du script. Son ancien bloc était dans `accessories()` et créait une bibliothèque, une plante et une lanterne sous un parent nommé `Meuble mur gauche`.

### Plante au sol

Une plante en pot a été déplacée près du lit, sur le parquet :

```python
plant(-2.55, -1.25, .12, .72)
```

### Oreilles de Claaky

Les oreilles triangulaires en maillage ont été remplacées par des ellipsoïdes arrondis, légèrement inclinés, dans `chair_and_character()` :

```python
for side in [-1, 1]:
    ear = sphere(
        'Oreille arrondie',
        (side * .56, .015, 1.38),
        (.27, .14, .40),
        'green',
        24,
        12,
    )
    ear.rotation_euler.y = math.radians(-side * 22)
    for polygon in ear.data.polygons:
        polygon.use_smooth = True
```

## Éléments déjà présents dans la scène

Le script construit notamment :

- une pièce isométrique avec parquet, murs et porte ;
- une fenêtre, des décorations murales et un tableau ;
- un bureau avec écran, clavier, ordinateur, tasse et lampe ;
- un fauteuil et Claaky, avec une boucle de frappe simple ;
- un lit, un tapis, des plantes, des bibliothèques et quelques accessoires ;
- une caméra orthographique, un éclairage et des réglages de rendu.

## Vérification visuelle de la scène (23/10)

Contrôlée sur des rendus Blender 4.5 de `claaky_etats.py` (frame 100 en 1000 px, frame 190 du clip `attente` en 320 px) et sur le `decor.png` exporté en 640 px :

- lit en bas à gauche : lisible ;
- table de chevet et lanterne à côté de l’oreiller : confirmé sur `decor.png` ;
- oreilles arrondies : silhouette lisible ;
- composition sous la fenêtre : équilibrée ;
- sourire face caméra (clip `attente`, frame 190) : net, bouche courbée et joues roses.

Non confirmé : la plante au sol `plant(-2.55,-1.25,.12,.72)` n’est pas visible sur `decor.png` ni sur les rendus. Elle est probablement masquée par le lit vu de la caméra. Il faut trancher : la déplacer ou la supprimer.

Aucun `.blend` de référence n’a encore été enregistré (`Sans nom.blend`, non suivi par Git, n’est pas validé comme référence).

## Prochaines étapes

Les états, les animations et l’intégration IDE existent déjà (voir plus bas). Restent : décider du sort de la plante au sol, contrôler une par une les planches réexportées dans l’IDE, puis brancher la salle du swarm aux événements réels.

## Scènes ajoutées (scripts Python)

Les 4 scripts doivent rester dans le même dossier (`claaky_etats.py` et `claaky_swarm.py` importent les deux autres).

| Fichier | Rôle |
|---|---|
| `claaky_rig.py` | Module partagé : personnages articulés, mouvements réutilisables, scènes et export PNG/JSON. |
| `claaky_etats.py` | Bureau/chambre, clips indépendants pour l'IDE (chaque clip commence dans la pose de fin des clips qui y mènent). |
| `claaky_swarm.py` | Salle du swarm avec 6 postes et scénario simulé. |
| `export_ide.sh` | Lance le rendu Blender puis copie les sprites et `clips.json` dans `sinew/public/claaky3d/bureau/`. |

Clips du bureau : 4 lieux (`bureau` assis, `tableau` debout en retrait, `lit` couché, `centre` face à l’utilisateur).
- Boucles : `travail_clavier`, `reflechir_tableau`, `dormir`, `attente`.
- Ponctuels : `autorisation`, `erreur`, `cafe` (bureau), `celebrer` (centre).
- Trajets : `<lieu>__<lieu>` pour les 12 couples (ex. `bureau__tableau`), via le centre.

Segments du swarm : `principal_entre`, `reunion_ouverte`, `agents_arrivent`, `travail_swarm`, `agent_remet_dossier`, `agent_leve_la_main`, `agents_terminent`, `reunion_close`.

- Oreiller aligné sur le plateau de la table de chevet.
- Tête principale en ellipsoïde dense lissée (48×32), même lissage sur la petite boule du crâne et le visage pour éviter les facettes visibles.
- Démarche ralentie (1,25 u/s) et rotation d’orientation douce. Le déplacement reste linéaire pour garder des trajectoires qui atteignent exactement les waypoints (pas de virage courbe à travers les meubles).
- Les poses se fondent progressivement sur 8 images avant que le personnage commence son prochain clip de réflexion.

### Commandes

```bash
./export_ide.sh                     # tout le bureau → IDE (≈ 1 h)
./export_ide.sh erreur,cafe         # seulement ces clips
blender --background --python claaky_etats.py -- --render --frame 100   # image fixe
blender --background --python claaky_swarm.py -- --save-blend
```

`--export` produit `decor.png` (pièce sans personnage, fond transparent), une planche PNG recadrée par clip (personnage seul, meubles en holdout : il passe derrière eux ; la couverture et la tasse du bureau sont rendues avec lui) et `clips.json` (fps, position et découpe de chaque planche, boucle, lieu de départ et d’arrivée). Sur Mac, l’export headless utilise le CPU si Blender ne rend pas le GPU Metal disponible ; fixer `SAMPLES=8` et `SIZE=320` pour les prévisualisations.

## Intégration dans Claake Code

La pièce remplace le Claaky 2D de l’écran d’accueil de l’éditeur (aucun fichier ouvert). Le petit Claaky 2D de l’en-tête du chat est conservé.

| Fichier (`sinew/src/components/claaky/`) | Rôle |
|---|---|
| `claakyAgentState.ts` | Publie en plus une « activité » : état, outil en cours, attente de réponse (outil `question`), nombre d’outils en échec. |
| `roomDirector.ts` | Machine à états : activité → lieu + boucle + libellé, enchaînement des clips, anti-aller-retour (lieu stable 0,9 à 2,5 s, 2,5 s minimum sur place), autorisation immédiate, sommeil après 5 min de calme suivant une tâche terminée. |
| `ClaakyRoom.tsx` | Canvas : décor + planche du clip en cours à 12 i/s, pause hors écran ou fenêtre cachée, libellé sous la pièce ; retombe sur le Claaky 2D si les images manquent. |
| `ClaakyEmpty.tsx` | Affiche `ClaakyRoom` à la place du Claaky 2D. |

Correspondance : outil en cours → bureau, clavier (libellé selon l’outil) ; réflexion / plan → tableau ; `question` → autorisation ; outil en échec → réaction `erreur` ; fin de tour → `celebrer` puis attente au centre ; 5 min sans activité → lit.

Plus tard : Claaky compagnon hors de l’IDE, puis extension VS Code (`roomDirector.ts` et les planches se réutilisent tels quels).

### Dernières corrections visuelles

La table de chevet de la scène fixe et celle de la scène animée ont maintenant leurs propres coordonnées explicites, à côté de l’oreiller. La prévisualisation de `claaky_etats.py` a confirmé que le lit est intact et que le chevet n’est plus au pied du lit.

**Sourire dans la scène animée :** le rig affiche un sourire plus large et lissé. Le rendu de prévisualisation de la frame 1 montre Claaky de dos, donc l’expression doit être validée dans un clip où il fait face à la caméra.

**Attention au cache local :** si Claake Code affiche encore les anciens sprites, fermer puis relancer `npm run tauri dev` pour invalider les images déjà chargées en mémoire.

### Vérifications après corrections

- Blender 4.5 génère la scène du bureau (978 objets, 864 frames) sans erreur.
- Prévisualisation Cycles du lit et du mobilier rendue ; plateau de chevet relevé.
- `npx tsc --noEmit` et `git diff --check` passent.
- Réexport complet du 23/10 (`export_ide.sh`, 640 px, 24 échantillons, GPU, ≈ 1 h 20) : `public/claaky3d/bureau/` contient `decor.png`, les 20 planches et `clips.json`. Le manifeste liste exactement ces 20 clips.
- `npx tsc --noEmit` et `npm run build` passent après le réexport.
- Salle du swarm : rendus de prévisualisation frames 1 et 200 avec `camera_scale` 12,5. La pièce est entière, le tableau, le compteur et les personnages sont lisibles, aucun ajustement nécessaire.

### Vérifié / non vérifié

Génération testée sous Blender 4.5 en arrière-plan ; rendus contrôlés pour le clavier, l’autorisation, le tableau, le sommeil, le réveil, la célébration, l’arrivée des agents et la remise de dossier.

Non vérifié : les planches réexportées n’ont pas été contrôlées une à une, et l’affichage dans l’IDE n’a pas été relancé (redémarrer `npm run tauri dev` pour vider le cache).

**Prévisualisations :** les variables `SAMPLES` et `SIZE` ne sont lues que par `export_ide.sh`. Pour un rendu `--render` rapide, régler `cb.CONFIG` dans un petit script appelant (taille et échantillons) au lieu de compter sur ces variables d’environnement.

**Limite connue, ombre :** l’ombre du personnage n’apparaît pas sur le décor dans les sprites. Un test avec shadow catcher sur le clip `erreur` n’a produit qu’une trace pâle au sol, sans ombre de contact nette ; il a été abandonné. Piste possible : une passe d’ombre séparée composée par `ClaakyRoom.tsx`, ou une ombre de contact dessinée sous le personnage dans le canvas.
