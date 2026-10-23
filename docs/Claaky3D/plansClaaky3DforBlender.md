1. Définir précisément le résultat final
Ton extension affiche le lieu de vie d’un personnage qui représente ton agent de code.
Il possède deux espaces :
Espace	Contenu	Utilisation
Bureau / chambre	Bureau, ordinateur, tableau, bibliothèque, lit, coin café	Travail individuel et repos
Salle du swarm	Estrade, tableau principal, postes de travail	Coordination des sous-agents


Le personnage se déplace selon l’activité réelle de l’agent. Les animations sont accompagnées d’un petit libellé, par exemple « Modifie des fichiers », pour que l’information reste claire.
L’extension observe le travail de l’agent. Elle ne doit pas avoir besoin de lui envoyer des demandes supplémentaires pour fonctionner.
Première limite à accepter : la compatibilité se construit outil par outil. Tu pourras conserver le même univers graphique pour tous, mais chaque connecteur devra récupérer les événements disponibles.
2. Choisir une technique adaptée à ton niveau
Je recommande cette répartition :
Partie	Technologie	Rôle
Création des images	Blender	Créer les décors, personnages et mouvements
Automatisation graphique	Python dans Blender	Construire et exporter les éléments
Extension	TypeScript	Recevoir les événements et gérer VS Code
Affichage	Canvas 2D dans une Webview	Dessiner les décors et les personnages
Comportement	Machine à états en TypeScript	Décider où aller et quelle animation jouer
Connexion aux agents	Adaptateurs dédiés	Traduire leurs événements dans un format commun


Blender est gratuit et dispose d’une API Python. C’est ce qui permet à ton assistant de code de fabriquer une grande partie de la scène par script. www.blender.org
VS Code fournit les Webviews nécessaires pour afficher cette interface et échanger des messages avec l’extension. Visual Studio Code Extension API
Tu n’auras pas de serveur à héberger pour la première version, ni de modèle IA supplémentaire à faire tourner.
3. Apprendre seulement les bases utiles de Blender
Tu n’as pas besoin de commencer par une formation complète en modélisation.
Les premières compétences à acquérir sont :
Compétence	À quoi elle te servira
Tourner et déplacer la vue	Inspecter la scène
Sélectionner un objet	Choisir une chaise, un bras ou une lampe
Déplacer, tourner et redimensionner	Corriger un élément mal placé
Consulter les objets de la scène	Retrouver les éléments créés par le script
Lancer un script Python	Générer la scène
Lancer un rendu	Voir l’image finale
Enregistrer un fichier .blend	Garder une version modifiable


Ensuite seulement, tu apprendras la timeline et les images clés : une image clé indique la position ou la rotation d’un objet à un instant donné. Blender calcule le mouvement entre deux poses.
Ton premier exercice devrait être un cube qui lève un bras, pas une pièce entière avec dix animations. Il te permettra de comprendre le mécanisme sans te perdre dans le décor.
4. Fabriquer une première scène volontairement simple
Le premier décor doit contenir :
- Un sol et deux murs.
- Un bureau et un écran.
- Une chaise.
- Un tableau.
- Un lit.
- Une porte vers la future salle du swarm.
La caméra reste fixe, avec une projection orthographique : les objets éloignés ne deviennent pas plus petits. Cela aide à retrouver l’aspect isométrique de ta référence.
Pour le rendu :
- Formes simples et légèrement cubiques.
- Palette de couleurs limitée.
- Lumière douce.
- Résolution basse, à ajuster après un essai dans VS Code.
- Agrandissement sans lissage pour garder des pixels nets.
Attention : réduire la résolution d’une scène ne suffit pas à obtenir un beau pixel art. La silhouette, les couleurs et la lisibilité comptent beaucoup. On vise d’abord un rendu cohérent, puis on affine.
Le premier critère de réussite : à la taille réelle du panneau VS Code, tu distingues immédiatement le bureau, le tableau et le lit.
5. Créer un personnage facile à animer
Pour commencer, ton personnage peut être composé d’une dizaine de formes :
- Tête et cheveux.
- Torse et bassin.
- Deux bras.
- Deux mains si nécessaire.
- Deux jambes.
- Deux pieds.
On place les points de rotation aux épaules, aux hanches et au cou.
Pas besoin de peau déformable, de doigts articulés ou d’un visage détaillé. Les membres peuvent être des blocs rigides qui tournent autour de leurs articulations. Cela réduit énormément la difficulté.
L’IA peut écrire le script qui :
1. Crée les formes.
2. Les nomme proprement.
3. Organise leurs relations.
4. Place les articulations.
5. Ajoute les premières poses.
Tu vérifies surtout que le personnage reste lisible à petite taille.
6. Construire une petite bibliothèque de mouvements
Tu ne fabriques pas une animation complète pour chaque scénario. Tu fabriques des mouvements réutilisables.
Mouvement	Utilisation	Priorité
Attendre debout	Transitions, arrivée dans une pièce	Première version
Marcher	Tous les déplacements	Première version
Taper au clavier	Code et activité générique	Première version
Écrire au tableau	Planification	Première version
Dormir	Repos après cinq minutes	Première version
Regarder l’utilisateur	Demande d’autorisation	Première version
Célébrer	Fin d’une tâche	Ensuite
Lire un dossier	Lecture du projet	Ensuite
Boire un café	Repos éveillé	Ensuite
Réparer une machine	Correction d’erreur	Ensuite
Parler / faire un geste	Coordination du swarm	Swarm
Lever la main	Sous-agent bloqué	Swarm
Remettre un dossier	Sous-agent terminé	Swarm avancé


Pour les premières animations, quelques poses bien choisies suffisent. Une boucle peut contenir 8 à 16 images ; la marche ou certains gestes pourront demander davantage après essai.
Commence par deux directions de marche correspondant aux allées du décor. Tu ajouteras les autres angles quand ils seront réellement nécessaires.
7. Réduire le travail grâce à la mise en scène
Certains mouvements sont difficiles : s’asseoir naturellement, entrer sous une couverture, saisir une tasse…
Tu peux les simplifier sans casser l’illusion :
Action complexe	Solution accessible
S’asseoir	Le personnage arrive derrière la chaise, puis passe à une pose assise
Se coucher	Il rejoint le bord du lit, puis apparaît sous la couverture
Prendre un café	Une tasse est attachée à la main pendant l’animation
Changer de pièce	Il passe une porte, puis un court fondu révèle l’autre salle
Remettre un dossier	Geste court et petite icône de dossier


Ces raccourcis sont particulièrement efficaces dans un petit décor isométrique.
Le but est que l’action soit compréhensible et agréable, avec un volume de travail raisonnable.
8. Exporter les images proprement
La scène sera séparée en plusieurs éléments :
Élément exporté	Exemple
Décor arrière	Sol, murs, bibliothèque
Personnage animé	Marche, clavier, tableau
Mobilier au premier plan	Devant du bureau, bord du lit
Effets	Vapeur du café, voyants, bulle
Données de placement	Positions du bureau, du tableau et des portes


Cette séparation permet au personnage de passer derrière un meuble.
Point technique à prévoir dès le début : toutes les images doivent partager les mêmes réglages de caméra, d’échelle et de placement. Sinon, le personnage change de taille ou semble flotter entre deux animations.
Pour les sprites, on utilise un repère stable, généralement aux pieds. Les poses assises et couchées peuvent avoir des repères spécifiques.
Le script d’export doit produire les images et leurs informations de placement ensemble. Les ombres mobiles doivent également être prévues pour éviter qu’une ombre de personnage reste imprimée dans le décor fixe.
9. Faire fonctionner le décor avant de connecter un agent
La première application sera une simple page de développement avec des boutons :
Code · Plan · Attente · Autorisation · Erreur · Terminé · Swarm
Quand tu cliques sur « Plan », le personnage rejoint le tableau. Quand tu cliques sur « Code », il retourne au bureau.
Cela permet de travailler sur l’affichage sans dépendre du comportement d’un agent.
Critères de réussite :
- Le personnage se déplace correctement.
- Il passe devant ou derrière les meubles au bon moment.
- Les animations s’enchaînent sans saut visible.
- Un changement d’activité pendant un déplacement ne le bloque pas.
- La scène reste lisible dans un panneau étroit.
À cette étape, tu possèdes déjà une démonstration complète de l’idée.
10. Gérer les déplacements avec des chemins prédéfinis
Tu n’as pas besoin d’un système de navigation complexe.
Tu définis des points dans la pièce :
- Devant le bureau.
- Au centre de la pièce.
- Devant le tableau.
- Au bord du lit.
- Devant la porte.
Les trajets passent par ces points pour éviter les meubles.
Exemple : du bureau au lit, il recule vers le centre de la pièce, puis rejoint le lit.
La logique distingue :
- L’activité demandée : aller écrire au tableau.
- L’action actuelle : marcher jusqu’au tableau.
- L’animation affichée : boucle de marche.
Ainsi, recevoir un nouvel événement ne téléporte pas le personnage.
11. Définir les règles de comportement
Voici les règles que je fixerais avant l’intégration :
Situation	Comportement
Une tâche commence	Il se réveille si nécessaire et rejoint son poste
L’agent modifie des fichiers	Il tape au clavier
Un événement de planification est disponible	Il écrit au tableau
L’activité est connue mais peu précise	Il travaille au bureau avec un libellé générique
Une autorisation est requise	Il se tourne vers toi et attend
Un outil échoue	Réaction courte, puis reprise si le travail continue
La tâche est terminée	Il célèbre brièvement, puis passe au repos
Le repos dure cinq minutes	Il rejoint son lit
La connexion à l’agent disparaît	L’interface indique « Déconnecté »


Une absence d’événement ne signifie pas que l’agent est au repos. Le sommeil démarre après une fin de tâche confirmée, pas pendant un calcul silencieux.
Autre règle essentielle : éviter qu’il traverse la pièce à chaque lecture ou modification de fichier. Les activités brèves peuvent rester au bureau ; les changements de lieu doivent être regroupés et stabilisés pendant quelques secondes.
L’attente d’autorisation doit, elle, apparaître rapidement.
12. Créer un format commun pour tous les agents
Chaque connecteur traduit les événements de son outil vers une petite liste commune :
type AgentEvent = {
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  timestamp: number;

  type:
    | "task_started"
    | "activity_changed"
    | "permission_required"
    | "tool_failed"
    | "task_completed"
    | "subagent_started"
    | "subagent_completed"
    | "disconnected";

  activity?: "coding" | "planning" | "reading" | "testing";
};

C’est une proposition de format pour ton extension, pas une API existante.
L’affichage ne connaît ensuite que ces événements. Ajouter un nouvel outil ne demande pas de refaire les animations.
Il faut aussi distinguer :
- Une activité confirmée par l’outil.
- Une activité estimée, par exemple reconnaître une commande de tests.
- Une activité inconnue, affichée comme du travail générique.
On ne pourra pas détecter universellement la “réflexion interne” d’un modèle. Le tableau représentera surtout un mode plan ou une activité d’analyse observable.
13. Connecter un premier agent
Je choisirais le premier outil selon la facilité d’accès à ses événements.
Claude Code constitue une piste concrète : sa documentation décrit des hooks avant et après les outils, des demandes d’autorisation et des événements liés aux sous-agents. Il faudra vérifier ce que fournit exactement la version installée et le mode d’utilisation choisi. Claude Code Docs
La démarche :
1. Afficher les événements reçus dans un journal de développement.
2. Vérifier leur contenu sur une vraie tâche.
3. Les convertir dans ton format commun.
4. Les envoyer au moteur d’animation.
5. Tester les fins, erreurs, annulations et déconnexions.
Pour Codex ou Kilo Code, on étudiera ensuite leur interface disponible. L’existence d’un protocole ou d’une API ne garantit pas qu’on puisse observer directement une session déjà ouverte dans une autre extension.
Le premier connecteur doit prouver la faisabilité avant de promettre une compatibilité générale.
14. Construire le swarm en deux étapes
D’abord, un swarm simulé :
- Le personnage principal entre dans la salle.
- Trois personnages rejoignent leurs postes.
- Ils travaillent avec des animations légèrement décalées.
- L’un termine et rapporte un dossier.
- Un autre lève la main.
- Le principal revient à son bureau lorsque tout est fini.
Ensuite, un swarm relié aux événements réels :
Événement	Mise en scène
Création d’un sous-agent	Un personnage entre et rejoint un poste
Activité du sous-agent	Il travaille à son bureau
Demande d’intervention observable	Il lève la main
Fin du sous-agent	Il remet un dossier ou affiche une coche
Fin de l’ensemble	Le principal clôt la réunion


Prévois six à huit postes visibles au départ, puis un compteur pour les agents supplémentaires. C’est un choix de lisibilité, à ajuster après mesure.
Tous les personnages peuvent partager les mêmes images d’animation, avec quelques variantes de couleur. Inutile de modéliser un personnage différent pour chaque agent.
La version “réunion sur Teams” peut rester une alternative plus simple : le personnage reste au bureau et un écran affiche les participants. Je garderais l’estrade comme scène principale, puisque c’est l’idée la plus expressive.
15. Intégrer l’ensemble dans VS Code
Une fois la démonstration graphique stable :
- Ajouter une vue dans la barre latérale.
- Proposer l’ouverture dans un panneau plus large pour voir la salle du swarm.
- Charger les images locales dans la Webview.
- Transmettre les événements depuis l’extension.
- Ajouter les réglages essentiels.
Réglages utiles :
Réglage	Valeur initiale proposée
Délai avant sommeil	5 minutes
Animation	Activée
Sons	Désactivés
Taille des personnages	Automatique selon la vue
Changement automatique de pièce	Activé
Agents visibles	Limité
Mode démonstration	Accessible par commande


La déconnexion et le repos doivent rester distinguables. Le personnage peut dormir, mais le libellé doit préciser si aucun agent n’est connecté.
16. Vérifier les performances et la fiabilité
Les performances annoncées précédemment restent une attente raisonnable, à confirmer sur le prototype.
Points à mesurer :
- CPU pendant une animation.
- Mémoire après plusieurs changements de pièce.
- Consommation quand la vue est cachée.
- Taille totale des images.
- Comportement avec plusieurs personnages.
Bonnes pratiques :
- Arrêter la boucle de dessin quand la vue est masquée.
- Charger les sprites partagés une seule fois.
- Éviter les planches d’images immenses.
- Limiter les effets et les personnages visibles.
- Reconstituer l’état actuel à la réouverture du panneau.
Les tests les plus importants concernent le comportement : fin de tâche, annulation, événements répétés, sous-agent terminé avant son arrivée à son poste, nouvelle demande pendant le sommeil.
L’animation ne doit jamais ralentir ni bloquer le travail de l’agent. Si le pont d’événements ne répond pas, le travail doit continuer.
17. Utiliser l’IA avec une méthode qui évite de perdre du temps
Demande des modifications petites et vérifiables.
Par exemple, au lieu de demander toute la pièce :
Crée un script Python pour Blender qui génère seulement un sol, deux murs, un bureau et une caméra orthographique. Tous les objets doivent être nommés. Les dimensions et les couleurs doivent être regroupées dans une configuration.

Puis :
Ajoute un personnage composé de blocs rigides. Place les points de rotation aux épaules et aux hanches. Ne change pas la caméra ni le décor.

Puis :
Ajoute une animation de frappe au clavier. Conserve le personnage existant et exporte une prévisualisation.

À chaque étape :
1. Tu exécutes.
2. Tu inspectes le rendu.
3. Tu décris précisément le défaut.
4. Tu sauvegardes une version validée.
Garde les scripts dans Git, et des copies des fichiers Blender aux étapes importantes. Une modification du personnage peut obliger à réexporter ses animations : stabilise son apparence avant d’en produire quinze.
18. Suivre un ordre de réalisation concret
Étape	Livrable	Condition pour continuer
1	Pièce grise et personnage simple	Les proportions sont lisibles
2	Animation au clavier	Le pipeline Blender → images fonctionne
3	Décor et personnage dans Canvas	L’affichage convient à VS Code
4	Marche entre bureau et tableau	Les déplacements et les superpositions fonctionnent
5	Lit, sommeil et réveil	Le comportement complet fonctionne en simulation
6	Extension avec boutons de démonstration	Le panneau est stable
7	Premier connecteur réel	Les événements pilotent correctement la scène
8	Salle du swarm simulée	Plusieurs personnages restent lisibles
9	Swarm réel si les événements le permettent	Les arrivées et les fins correspondent aux agents
10	Finition artistique	L’ensemble fonctionne avant de le décorer davantage


Estimation de travail, pas une promesse : je prévoirais plusieurs week-ends pour une démonstration convaincante, puis plusieurs semaines supplémentaires pour une extension fiable avec un premier connecteur. La qualité artistique et les intégrations feront davantage varier la durée que le simple affichage des animations.
Le coût logiciel peut rester très faible avec Blender, les outils de développement et ton assistant IA existant dans les limites de ton abonnement. Tu pourras décider plus tard si quelques éléments graphiques achetés valent le temps gagné.
Le premier objectif concret : un personnage qui tape au bureau, rejoint le tableau sur un bouton et va dormir sur un autre. Quand ces trois actions fonctionnent avec un joli rendu, tu as validé toute la chaîne technique sur laquelle construire le reste.