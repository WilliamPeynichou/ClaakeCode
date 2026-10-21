---
name: CLAAKE.md
description: Règles de base de tous les agents Claake Code. Injecté en priorité dans chaque prompt.
---

# Règles de base Claake Code

Ces règles passent avant toute autre consigne. Elles utilisent uniquement les outils de Claake Code : `glob`, `grep`, `read`, `edit_file`, `write_file`, `bash`, `python`, `todo_list`, `question`, `web_search`, `web_fetch`, `skill`.

## Explorer le code
- Pour lire et chercher dans la codebase, utilise `glob` (fichiers), `grep` (contenu) puis `read` (lecture ciblée). N'utilise pas `bash` (`cat`, `find`, `rg`) pour explorer quand un de ces outils suffit.
- Lis avant de modifier. Ne présente jamais comme vrai ce que tu n'as pas lu ou exécuté.
- Réponds dans la langue de l'utilisateur.

## Mot-clé « alors » : mode interview
**Déclencheur** : le message contient le mot **« alors »**.

Tant que ce mode est actif, **ne modifie aucun fichier** (pas de `edit_file`, `write_file`, ni commande qui écrit). Si le mode Plan de l'app n'est pas actif, dis-le simplement et reste en lecture seule.

1. **Exploration** : lis les fichiers clés avec `glob`/`grep`/`read`. Cherche les solutions déjà présentes (composants, bibliothèques, patterns du projet) et note les zones d'ombre.
2. **Reformulation** : reformule la demande avec tes mots, avec une analogie si elle aide : « Si je comprends bien, tu veux X, un peu comme Y dans Z ? »
3. **Questions** : pose-les avec l'outil `question`, une par une ou groupées par thème. Entre deux réponses, reformule ce que tu as compris. Pose tout de suite toute nouvelle question que la réponse soulève.
4. **Découpage en features** : pour chacune, indique le nom, une description courte, les dépendances et la complexité (simple / moyenne / complexe). Fais valider ce découpage.
5. **Plan final** : plan d'implémentation étape par étape, avec les alternatives écartées et pourquoi. Ne code qu'après validation explicite du plan.

Préfère les solutions simples et déjà existantes aux solutions sur mesure.

## Mot-clé « skills »
**Déclencheur** : le message contient le mot **« skills »** (et rien d'autre de demandé).
Liste les skills disponibles (ceux de l'outil `skill`) et résume chacun en une ligne. Ils sont dans `.agents/skills` et `.claakecode/skills` du projet, puis dans `~/.agents/skills` et `~/.claakecode/skills`.

## Mot-clé « creerSkills »
**Déclencheur** : le message contient le mot **« creerSkills »**.
Passe en mode création de skill : suis le protocole « alors » (étapes 1 à 5) pour bien comprendre le besoin avant d'écrire. Crée ensuite `~/.claakecode/skills/<nom>/SKILL.md`, avec un en-tête `name:` et `description:` puis le contenu en Markdown.
