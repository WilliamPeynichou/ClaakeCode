---
name: Motion_Design
description: Conçoit et produit de bout en bout des vidéos de motion design en code avec HTML, JavaScript, Playwright, Python et ffmpeg. Utiliser pour une publicité, un film de lancement, un teaser produit, un showreel, une vidéo sociale, une animation de marque ou l'adaptation stylistique d'une référence. Le skill impose un brief, une beat map, quatre stills validés, un moteur déterministe seek(t), un rendu avec motion blur, un mixage audio synchronisé et une boucle de contrôle visuel jusqu'à livraison du MP4.
---

Motion design autonome en code
Produis un film, pas seulement un premier rendu. Le prompt donne l'intention. Ce protocole fournit la direction artistique, la synchronisation, le moteur, le rendu, le son et le contrôle qualité.

Résultat attendu
Livre un projet reproductible et un fichier vidéo final. Utilise uniquement des outils gratuits sauf demande explicite de l'utilisateur.

Livrables minimaux dans le dossier du film:

<film>/
  BRIEF.md
  BEATMAP.md
  QA.md
  film.html
  render.py
  audio.py
  assets/
  probe/
  out/
    video.mp4
    audio.wav
    final.mp4
    contact.jpg
    phone.jpg
Ne déclare jamais la tâche terminée tant que out/final.mp4 n'existe pas, que les contrôles finaux n'ont pas réussi et que les limites éventuelles n'ont pas été signalées.

Contrat d'autonomie
Examine les fichiers existants avant de créer le projet.
Demande uniquement les éléments réellement bloquants: logo ou visuels obligatoires absents, accès à une interface privée, voix imposée, format ou durée impossibles à inférer.
Si un choix est réversible, prends une valeur raisonnable et consigne-la dans BRIEF.md.
Si une référence est fournie, analyse sa grammaire visuelle, jamais son contenu propriétaire.
Arrête-toi pour faire valider les quatre stills si l'utilisateur est disponible. Sans réponse possible, poursuis avec l'option la plus sobre et documente cette hypothèse.
Lance les rendus longs en tâche détachée si l'environnement le permet. Ne simule pas leur réussite.
Après chaque correction, ne recalcule que les secondes touchées lorsque le moteur le permet.
Outils et prérequis
Vérifie les commandes avant toute installation:

python --version
ffmpeg -version
ffprobe -version
Paquets Python usuels:

python -m pip install playwright numpy pillow
python -m playwright install chromium
N'installe rien sans respecter les permissions de l'environnement. Si ffmpeg n'est pas dans le PATH, essaie le binaire fourni par imageio-ffmpeg seulement si ce paquet est déjà disponible ou si son installation est autorisée.

Pipeline obligatoire
Suis ces phases dans l'ordre. Ne saute pas directement au rendu complet.

Phase 1: brief factuel
Établis dans BRIEF.md:

objectif et appel à l'action;
audience et canal de diffusion;
durée, ratio, résolution et cadence;
identité visuelle, logo, polices, palette et ton;
produit, fonctionnalités et données autorisées à l'écran;
langue, voix off et sous-titres;
photos, captures produit, musique et effets sonores disponibles;
référence visuelle éventuelle;
contraintes de licence, date et budget de rendu;
définition exacte du fichier final.
Valeurs par défaut si rien n'est précisé:

réseau social vertical: 1080x1920, 30 fps;
publication LinkedIn portrait: 1080x1350, 30 fps;
film paysage: 1920x1080, 30 fps;
rendu premium ou mouvement très rapide: 60 fps;
encodage H.264, yuv420p, AAC, BT.709, +faststart.
Choisis une seule idée centrale. Le spectateur doit comprendre le sujet dans les deux premières secondes.

Phase 2: référence et direction
Si une vidéo de référence existe:

Extrais une image toutes les 0.5 s et les images autour de chaque coupe.
Note palette, typographie, densité, durée des plans, cadrage, transitions, texture, rythme, caméra et traitement sonore.
Écris ce qui est réutilisable comme grammaire et ce qui ne doit pas être copié: textes, logos, personnages, musique, voix, composition distinctive ou données.
Convertis cette analyse en règles propres au nouveau film.
Sans référence, choisis une direction explicite parmi trois propositions courtes, puis retiens la plus cohérente avec la marque. Évite le défaut générique: texte centré, gradient décoratif, éléments qui apparaissent tous en fondu.

Phase 3: beat map et storyboard
Crée BEATMAP.md avant le code. Pour chaque scène, indique:

Champ	Contenu
Temps	début et fin en secondes
Beat	numéro de beat ou de mesure
Message	une seule idée lisible
Visuel	élément principal et composition
Mouvement	entrée, action, sortie, caméra
Audio	musique, impact, clic, souffle, voix
Transition	élément partagé avec la scène suivante
Règles:

chaque scène importante commence sur un beat ou une intention vocale;
le drop musical coïncide avec le moment visuel clé;
quelque chose de pertinent change toutes les 2 à 4 s;
aucune scène ne reste totalement immobile plus de 1 s, sauf choix dramatique documenté;
réserve du temps pour lire: estime la durée à partir du nombre de mots et vérifie au format téléphone;
utilise des éléments partagés entre scènes plutôt que des coupures gratuites;
place d'abord les messages, puis les mouvements, puis les effets.
Phase 4: quatre stills avant animation
Rends au minimum:

l'accroche, entre 0 et 2 s;
une scène explicative;
le moment clé ou le drop;
le plan final et l'appel à l'action.
Assemble-les dans probe/sheet.jpg. Examine réellement l'image à sa taille native et à 360 px de large.

Contrôle avant de poursuivre:

hiérarchie comprise sans lire le brief;
texte non coupé, non superposé et assez contrasté;
marges adaptées au format et aux interfaces sociales;
image de marque cohérente;
aucun faux chiffre ou écran inventé;
composition distincte d'une scène à l'autre;
appel à l'action visible mais non envahissant.
Corrige les stills avant de créer le rendu complet.

Moteur déterministe
Le film est un programme qui peint une image exacte pour un temps exact. Expose obligatoirement:

window.seek = async (t) => {
  // Tous les styles et contenus dépendent seulement de t et de constantes.
  renderFrame(t);
  await document.fonts.ready;
  return true;
};

window.ready = Promise.all(assetPromises).then(() => true);
Interdictions:

pas de setTimeout, setInterval, transition CSS ou animation CSS;
pas d'état dérivé des images précédentes;
pas de Math.random();
pas de bibliothèque qui ne peut avancer qu'en temps réel;
pas de dépendance au débit de la machine ou à l'heure système.
Une même valeur de t doit produire les mêmes pixels, même si les images sont demandées dans un autre ordre.

Primitives minimales
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = u => u * u * (3 - 2 * u);
const easeOut = u => 1 - Math.pow(1 - clamp(u), 4);

function progress(t, start, duration, easing = smooth) {
  return easing(clamp((t - start) / duration));
}

// Réponse fermée d'un ressort sous-amorti, déterministe et seekable.
function spring(tau, frequency = 3, damping = 0.65) {
  if (tau <= 0) return 0;
  const z = clamp(damping, 0.001, 0.999);
  const w = 2 * Math.PI * frequency;
  const wd = w * Math.sqrt(1 - z * z);
  const envelope = Math.exp(-z * w * tau);
  return 1 - envelope * (
    Math.cos(wd * tau) + (z * w / wd) * Math.sin(wd * tau)
  );
}

function springTargets(t, base, changes, frequency = 3, damping = 0.65) {
  let value = base;
  let previous = base;
  for (const [time, target] of changes) {
    value += (target - previous) * spring(t - time, frequency, damping);
    previous = target;
  }
  return value;
}

function mulberry32(seed) {
  return () => {
    let x = seed += 0x6D2B79F5;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
Utilise les ressorts avec retenue. Un mouvement premium accélère, dépasse légèrement sa cible et se stabilise. Évite les rebonds visibles sur le texte informatif.

Règles visuelles
Donne un z-index explicite aux couches importantes.
Anime le texte par masque, mot ou ligne, pas par simple opacité globale.
Ne redimensionne pas une copie bitmap de texte pendant un transfert; conserve une version nette ou fais un échange masqué.
Interpole le zoom caméra en espace logarithmique.
Ne fais pas immédiatement zoom avant puis zoom arrière sans intention.
Pour une nappe circulaire, calcule le rayon jusqu'au coin le plus éloigné avec une marge d'au moins 5 %.
Mesure le texte avec la police réellement chargée.
Dimensionne les scènes avec une fonction de layout pour pouvoir recadrer proprement plusieurs ratios. Ne transforme pas un format vertical en simple crop d'un format paysage.
Rendu Playwright
render.py doit au minimum proposer:

python render.py probe 0.5 4.0 8.0 12.0
python render.py range 4.0 7.5
python render.py full
python render.py qa
Algorithme de capture:

Lance un serveur HTTP local dans le dossier du film.
Ouvre Chromium avec une viewport exactement égale à la résolution de sortie.
Attends window.ready.
Pour chaque sous-image, appelle await window.seek(t) puis capture en JPEG de haute qualité ou en PNG.
Utilise des noms à largeur fixe et un dossier différent par version pour éviter les collisions.
Ferme proprement le navigateur et le serveur, même en cas d'erreur.
Temps d'une sous-image pour une sortie à fps et N sous-images:

t = (frame_index + (sub_index + 0.5) / subframes) / fps
Le décalage de 0.5 centre l'échantillon dans son intervalle. Conserve le FPS, la résolution, le nombre de sous-images, la graine et les temps exacts dans un manifeste de rendu.

Motion blur
Valeurs de départ:

N=1 pour les stills;
N=4 pour un aperçu;
N=8 pour le rendu final ou les mouvements rapides.
Une méthode ffmpeg possible, après capture à fps*N, est:

ffmpeg -framerate 480 -i sub/s_%06d.jpg \
  -vf "tmix=frames=8:weights='1 1 1 1 1 1 1 1',select='eq(mod(n\,8)\,7)',setpts=N/60/TB" \
  -r 60 -an -c:v libx264 -crf 14 -pix_fmt yuv420p out/video.mp4
Adapte 480, 8 et 60 ensemble. Vérifie la durée avec ffprobe; ne suppose pas que la commande est correcte parce qu'elle se termine avec le code zéro. Si tmix crée des images fantômes, réduis la durée d'obturation ou moyenne explicitement chaque groupe de sous-images dans Python. Ne descends pas silencieusement à quatre sous-images pour le rendu final d'un mouvement rapide.

Encodage final recommandé:

ffmpeg -i out/video.mp4 -i out/audio.wav \
  -map 0:v:0 -map 1:a:0 -c:v libx264 -crf 16 -preset slow \
  -vf "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 256k -movflags +faststart -shortest out/final.mp4
Audio synchronisé
La musique et l'image partagent la même timeline. Ne choisis pas des beats uniquement à partir d'une grille automatique.

Trouver le drop
Décode la piste au format PCM flottant.
Convertis-la en mono pour l'analyse.
Mesure l'énergie large bande et basse fréquence par mesure musicale supposée.
Repère les hausses candidates.
Zoome autour de chaque candidate avec des fenêtres de 20 à 50 ms.
Écoute et vérifie visuellement la meilleure candidate.
Place le début de la piste à drop_dans_la_musique - drop_dans_le_film.
Patron d'analyse locale:

for t in np.arange(candidate - 0.30, candidate + 0.30, 0.02):
    i0 = int(t * sample_rate)
    i1 = int((t + 0.02) * sample_rate)
    segment = lowpassed[i0:i1]
    db = 10 * np.log10(np.mean(segment ** 2) + 1e-12)
    print(f"{t:7.3f} {db:7.2f}")
Placer les SFX sur leur pic
Le temps visuel cible doit coïncider avec le pic perçu, pas avec le début du fichier:

mono_energy = np.max(np.abs(sfx), axis=1) if sfx.ndim == 2 else np.abs(sfx)
peak = int(np.argmax(mono_energy))
start = int(round(target_time * sample_rate)) - peak
Gère explicitement les indices négatifs et le dépassement de fin avant l'addition dans le mix. Normalise chaque source sans division par zéro, applique des fades courts et laisse de la marge pour éviter le clipping. Place les frappes de clavier selon les mêmes temps que les caractères animés.

Pour une voix off, atténue la musique pendant la parole plutôt que de réduire toute la bande-son. Aligne les sous-titres sur les timestamps de mots réels si disponibles.

Loudness final
Effectue un loudnorm en deux passes à -14 LUFS, TP=-1.5 dBTP, LRA=11. La première passe mesure; la seconde réutilise les valeurs mesurées. N'invente pas les paramètres mesurés.

Vérifie ensuite:

absence de clipping;
synchronisation des impacts à l'image;
intelligibilité de la voix;
durée audio compatible avec la vidéo;
absence de coupe brutale non intentionnelle.
Contrôle qualité obligatoire
Après le premier rendu, génère et examine:

ffmpeg -i out/final.mp4 -vf "fps=2,scale=270:-1,tile=6x5" -frames:v 1 out/contact.jpg
ffmpeg -i out/final.mp4 -vf "fps=1,scale=360:-1,tile=5x3" -frames:v 1 out/phone.jpg
ffmpeg -ss START -t DURATION -i out/final.mp4 -vf "fps=60,scale=320:-1,tile=12x1" -frames:v 1 out/strip.jpg
Adapte la grille au nombre d'images. Ne laisse pas ffmpeg tronquer silencieusement la fin d'un film long: crée plusieurs planches si nécessaire.

Analyse aussi la différence moyenne entre images successives. Signale les pics supérieurs à trois fois leur voisinage. Une coupe intentionnelle peut produire un pic; explique-la au lieu de la masquer.

Note de 1 à 10 dans QA.md:

accroche pendant les deux premières secondes;
lisibilité à 360 px;
qualité des mouvements;
variété toutes les 2 à 4 s;
composition et hiérarchie;
exactitude de la marque, du produit et des données;
synchronisation sonore;
fluidité des transitions;
qualité de la fin ou de la boucle.
Écris les trois problèmes principaux avec leurs timestamps. Corrige-les, rends uniquement les plages touchées, réassemble, puis recommence. Ne livre pas tant qu'une note reste sous 8/10, sauf limite technique objective clairement signalée.

Cherche notamment:

lettres ou cartes qui se chevauchent;
titres coupés par un masque;
texte flou pendant une transformation;
fondu générique sans intention;
mouvement linéaire ou trop uniforme;
plan mort;
flash involontaire;
image fantôme due au motion blur;
données ou intégrations inventées;
audio décalé;
couture visible dans une boucle.
Vérité, droits et références
Toute donnée illustrative porte à l'écran Données d'exemple, Exemple ou Illustration.
Vérifie les fonctionnalités et intégrations dans la documentation ou le produit réel.
Ne montre jamais un partenariat, une certification ou une compatibilité non prouvés.
N'affirme pas une seule prompt, fait en dix minutes, sans outil externe ou équivalent si ce n'est pas strictement vrai.
Utilise des médias dont la licence autorise l'usage prévu et conserve la source dans BRIEF.md.
Pour une référence, reprends le rythme, les principes de cadrage ou les types de transition, mais pas la musique, la voix, les personnes, les logos, les textes ni les plans distinctifs.
Pour une interface privée, capture le vrai produit avec autorisation. Si c'est impossible, demande des captures ou étiquette clairement la reconstruction comme illustrative.
Stratégie de correction
Quand l'utilisateur demande une modification:

Identifie les scènes et secondes touchées.
Préserve la beat map et les scènes non concernées.
Modifie la plus petite surface de code possible.
Rends une plage avec des poignées de sécurité avant et après.
Vérifie les coutures au raccord.
Réassemble sans réencoder les parties inchangées si les codecs et timestamps le permettent; sinon effectue un encodage final unique.
Rejoue les contrôles concernés et compare les scores avant/après.
Une amélioration locale qui dégrade trois autres scènes est rejetée.

Validation technique finale
Exécute des contrôles mesurés, pas seulement visuels:

ffprobe -v error -show_entries format=duration -show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_space,color_range -of json out/final.mp4
ffmpeg -v error -i out/final.mp4 -f null -
Vérifie:

vidéo et audio présents;
résolution, ratio, FPS et durée conformes au brief;
décodage complet sans erreur;
yuv420p, BT.709 et plage TV pour une livraison sociale standard;
pic et loudness conformes;
première et dernière images intentionnelles;
aucune valeur factice non étiquetée;
aucun asset manquant;
commande de reproduction documentée.
Rapport de livraison
Réponds avec:

le chemin de out/final.mp4;
la durée, la résolution, le FPS, les codecs et le loudness mesurés;
la direction créative en une phrase;
les trois corrections majeures effectuées après inspection;
les hypothèses, licences ou limites restantes;
les commandes exactes pour reproduire le rendu.
Reste factuel. Ne dis jamais que le film est terminé si le rendu, le mixage ou les contrôles n'ont pas été exécutés.
