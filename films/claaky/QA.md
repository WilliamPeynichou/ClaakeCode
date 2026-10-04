# QA — Claaky (rendu 4 sous-images, sans audio)

Fichiers : out/final_portrait.mp4 (1080×1350), out/final_landscape.mp4 (1920×1080) — H.264, yuv420p, BT.709 plage TV, 30 fps, 24,000 s, aucune piste audio (demande utilisateur). Décodage complet sans erreur (`sh qa.sh`).

Notes (auto-évaluation sur planches contact, pas d'écoute ni de test mobile réel) : accroche 8 · lisibilité 8 · mouvement 8 · variété 8 · composition 7 · exactitude 9 (code marqué « illustration ») · son n/a · transitions 7 · fin 8.

Problèmes connus, NON corrigés :
1. Portrait, 9,6–16,8 s : le panneau de code recouvre le bas du bol de Claaky.
2. Portrait et paysage, ~16,8–18 s : pendant le saut, la tête de Claaky passe devant le titre « Tout doux. Tout squishy. ».
3. Flou de mouvement : 4 sous-images (le skill recommande 8 pour un rendu final rapide) ; léger flou visible sur le saut.

Reproduire : `node render.mjs portrait 4` puis `node render.mjs landscape 4` (≈ 35 min en parallèle), ré-encodage final et contrôles : voir qa.sh. Vérifications non faites : lecture sur téléphone, validité de l'URL affichée au-delà du site actuel.
