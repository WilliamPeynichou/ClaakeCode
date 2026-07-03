# Caveman optionnel dans ClaakeCode

Caveman est une intégration expérimentale optionnelle. Elle est conçue pour rester isolée du fonctionnement standard de ClaakeCode.

## Garanties

- Caveman est désactivé par défaut.
- Caveman n’est jamais utilisé automatiquement.
- Une installation sans Caveman reste valide.
- L’activation est manuelle et limitée à la tâche courante.
- En cas d’absence, mauvaise configuration, timeout ou échec de Caveman, ClaakeCode continue en mode standard.
- Caveman ne remplace pas le provider, le modèle, les outils ni les modes Act/Plan/Goal de ClaakeCode.

## Configuration

Ouvrir **Settings → Caveman**.

Champs disponibles :

- **Allow manual Caveman activation** : autorise l’affichage du bouton Caveman dans le composer. Off par défaut.
- **Manual activation only** : verrouillé à `on` par ClaakeCode.
- **Caveman executable** : commande à exécuter, par défaut `caveman` si vide.
- **Repository / working directory** : chemin optionnel vers le repo Caveman.
- **Extra arguments** : arguments ajoutés avant le prompt utilisateur.
- **Timeout** : durée maximale d’exécution pour une activation manuelle.

Le bouton **Check availability** lance un probe non bloquant (`--version`). Un échec de probe n’empêche pas ClaakeCode de fonctionner.

## Utilisation manuelle

1. Activer **Allow manual Caveman activation** dans les Settings.
2. Dans le chat, cliquer sur le bouton Caveman avant d’envoyer une demande.
3. Envoyer la demande.

Le bouton ne s’applique qu’au prochain message puis se réinitialise automatiquement.

## Retour au mode standard

Ne pas cliquer sur le bouton Caveman pour la tâche suivante. ClaakeCode reste alors en fonctionnement standard.

Si Caveman échoue pendant une tâche, ClaakeCode ajoute une information dans la conversation et poursuit avec le mode standard, sans perdre le contexte utilisateur.
