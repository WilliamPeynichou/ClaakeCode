---
name: Conformité_Software
description: Auditer et implémenter la conformité d'un logiciel open source gratuit, de son site, de ses téléchargements et de ses binaires lorsqu'il est distribué depuis la France vers l'Union européenne. Utiliser ce skill pour qualifier le caractère commercial, corriger les écarts et constituer un dossier de preuves vérifiable.
compatibility: "Claude Code; accès en lecture au dépôt, au site, à la CI/CD et aux artefacts; accès web recommandé pour vérifier les sources officielles"
---

# Conformité logicielle France et Union européenne

## 1. Mission, posture et limites

Audite puis aide à implémenter la conformité du code, du site, des binaires, des canaux de téléchargement et de l'organisation du projet.
Examine le produit réellement distribué, pas seulement le dépôt ou les déclarations.
Ne prétends jamais fournir un avis juridique.
Présente le résultat comme une analyse technique et documentaire à faire valider lorsque l'enjeu ou l'incertitude le justifie.
Ne garantis jamais une conformité absolue.
N'invente jamais :

- une identité, une adresse ou un représentant légal ;
- une forme juridique, une immatriculation ou un numéro de TVA ;
- un hébergeur, un sous-traitant, un DPO ou une autorité ;
- une base légale, une durée, un pays de transfert ou un contrat ;
- une licence, un titulaire de droits ou une certification ;
- une qualification réglementaire ou une date de mise en conformité.

Si une donnée manque, écris `NON FOURNI`, `NON OBSERVÉ` ou `À CONFIRMER` selon le cas.
Ces libellés signalent une lacune ; ils ne constituent jamais une donnée réelle.
Sépare toujours faits observés, déclarations, inférences, obligations, recommandations et questions ouvertes.
Ne remplace jamais une preuve absente par une hypothèse favorable.

## 2. Déclencheurs

Active ce skill pour :

- un audit réglementaire de logiciel distribué en France ou dans l'UE ;
- une publication open source, gratuite ou freemium ;
- des mentions légales, une politique de confidentialité ou une CMP ;
- des cookies, analytics, pixels, logs, crash reports ou de la télémétrie ;
- le RGPD d'une application web, mobile, desktop, serveur ou CLI ;
- une licence OSS, SPDX, un copyleft, une CLA, un DCO ou une marque ;
- une SBOM, une provenance, une signature, un updater ou `security.txt` ;
- le CRA, l'AI Act, le DSA, NIS2 ou le Data Act ;
- un logiciel visant la santé, la finance ou les mineurs ;
- une distribution par site, store, forge ou registre de paquets ;
- un dossier de preuves ou des contrôles de conformité en CI.

## 3. Principes impératifs

1. Qualifie les faits avant le droit.
2. Distingue open source, gratuit, hors activité commerciale et activité commerciale.
3. N'assimile jamais prix nul et absence d'activité commerciale.
4. N'assimile jamais licence OSS et exemption réglementaire.
5. Analyse séparément chaque texte et chaque rôle.
6. Observe le code, l'artefact et le réseau.
7. Vérifie les textes sur une source officielle à la date de l'audit.
8. Cite texte, article, version, URL et date de consultation.
9. Distingue obligation légale, exigence contractuelle et bonne pratique.
10. Supprime un traitement inutile plutôt que d'en complexifier la conformité.
11. Applique protection des données et sécurité dès la conception et par défaut.
12. Transforme toute incertitude en preuve demandée ou question à escalader.
13. Privilégie les corrections testables, minimales, réversibles et versionnées.
14. Ne publie pas de preuve contenant inutilement des données personnelles ou secrets.
15. Ne conclus jamais « conforme » sur une checklist déclarative seule.

## 4. Hypothèse de départ

Pars provisoirement de cette situation :

- distribution depuis la France ;
- téléchargement possible par des utilisateurs de l'UE ;
- code annoncé comme open source ;
- téléchargement principal gratuit ;
- site public et binaires disponibles ;
- aucun de ces faits ne crée une exemption générale ;
- RGPD applicable aux traitements entrant dans son champ ;
- règles françaises sur les traceurs potentiellement applicables au site et au logiciel ;
- obligations de licence indépendantes du prix ;
- CRA soumis à une qualification du produit, du rôle et de l'activité commerciale ;
- régimes sectoriels conditionnels jusqu'à vérification des fonctions et publics.

Confirme ou invalide chaque ligne et conserve la preuve.

## 5. Quatre notions distinctes

| Notion | Question | Ne prouve pas |
|---|---|---|
| Open source | La licence accorde-t-elle réellement les libertés annoncées ? | Gratuité, non-commerce ou conformité |
| Gratuit | Un prix monétaire est-il demandé pour obtenir ou utiliser le logiciel ? | Absence de contrepartie ou de revenus indirects |
| Hors activité commerciale | La fourniture est-elle réellement hors activité commerciale pour le texte examiné ? | Exemption générale ou automatique du CRA |
| Activité commerciale | Existe-t-il monétisation, avantage économique ou contrôle entrepreneurial pertinent ? | Illégalité ou régime uniforme |

Recherche :

- licences, support, hébergement, intégration ou formation payants ;
- abonnement, freemium, version entreprise ou achats intégrés ;
- publicité, affiliation, sponsoring contractuel ou marketplace ;
- dons liés à un avantage, une priorité ou une fonctionnalité ;
- exploitation de données au-delà de la sécurité et du fonctionnement ;
- distribution par une société dans son activité ;
- financement et gouvernance par un opérateur économique ;
- usage de la marque pour générer des prospects ;
- service facturé dépendant du logiciel ;
- contribution réellement bénévole et non contrôlée commercialement.

Ne conclus jamais à partir d'un indice isolé.
Qualifie séparément CRA, consommation, RGPD et tout régime fiscal pertinent.

## 6. Méthode d'inspection

### 6.1 Périmètre

- Note date, commit, tag, branche et état de l'arbre.
- Liste domaines, sous-domaines et environnements.
- Liste binaires, installateurs, images, extensions et stores.
- Identifie OS, architectures, versions et canaux.
- Sépare logiciel local, service distant et site.
- Identifie les propriétaires des comptes de publication.
- Ne modifie pas la production pendant l'exploration.
- Conserve sorties brutes, outil, version et heure UTC.

### 6.2 Dépôt

- Lis `README`, `LICENSE`, `NOTICE`, `COPYING`, `SECURITY`, `CONTRIBUTING` et le code de conduite.
- Inspecte manifestes, locks, vendoring, sous-modules et code copié.
- Inspecte build, release, signature, notarisation et mise à jour.
- Recherche SDK analytics, crash, publicité, authentification et paiement.
- Recherche URL, endpoint, WebSocket, DNS et webhook externes.
- Recherche stockage local, identifiants persistants, empreintes et journaux.
- Recherche données dans dumps, diagnostics et pièces jointes automatiques.
- Recherche export, suppression et désactivation de télémétrie.
- Recherche modèles IA, santé, finance, mineurs et objets connectés.

### 6.3 Site

- Cartographie pages, formulaires, scripts et ressources tierces.
- Capture le réseau dans un profil vierge avant interaction.
- Observe requêtes, redirections, cookies et tous les stockages navigateur.
- Identifie chaque domaine tiers et sa finalité.
- Vérifie pied de page sur mobile et bureau.
- Vérifie mentions, confidentialité, cookies, licence et sécurité.
- Vérifie contact, newsletter, dons et téléchargement.
- Vérifie boutons sociaux, vidéo, carte, police, CAPTCHA et CDN.
- Vérifie TLS, en-têtes de sécurité, erreurs et préproductions exposées.
- Vérifie pixels dans les courriels et confirmations.

### 6.4 Binaires

- Télécharge chaque artefact depuis son canal public.
- Calcule une empreinte cryptographique forte.
- Vérifie signature, certificat, notarisation et timestamp.
- Compare artefact, release, tag et source correspondante.
- Exécute dans un environnement isolé et instrumenté.
- Observe premier lancement, repos, crash, fermeture et update.
- Teste avec et sans compte, réseau et consentement.
- Inspecte fichiers créés, logs, caches, permissions et secrets.
- Vérifie désinstallation, résidus et reproductibilité ou provenance.

### 6.5 Prestataires

Pour chacun, consigne :

- fournisseur, entité contractante et service ;
- finalité, données, personnes et endpoint ;
- rôles RGPD présumés et sous-traitants ultérieurs ;
- régions de stockage, d'accès et de support ;
- mécanisme de transfert et durée ;
- contrat, DPA et configuration de minimisation ;
- moyen de désactivation et preuve technique.

## 7. Recherche officielle à jour

Avant toute conclusion sensible :

1. Note la date exacte de recherche.
2. Ouvre le texte consolidé sur EUR-Lex ou Légifrance.
3. Vérifie champs matériel, territorial, personnel et temporel.
4. Vérifie définitions, rôles, seuils et exceptions.
5. Vérifie entrée en vigueur, application et transition.
6. Recherche actes délégués, actes d'exécution et normes harmonisées.
7. Consulte CNIL, ANSSI, DGCCRF ou autorité sectorielle compétente.
8. Consulte le CEPD pour le RGPD.
9. Consulte la Commission après le texte, pas à sa place.
10. Archive titre, URL, date et passage pertinent.
11. Signale toute divergence de version ou traduction.

Hiérarchie :

1. texte consolidé EUR-Lex ou Légifrance ;
2. jurisprudence compétente ;
3. actes délégués et d'exécution ;
4. décisions et lignes directrices de l'autorité ;
5. CEPD, ENISA et autorités nationales ;
6. explications de la Commission et Service Public ;
7. normes harmonisées et standards référencés ;
8. doctrine privée, seulement comme éclairage.

Ne traite ni proposition, ni communiqué, ni FAQ comme un règlement adopté.

### URLs officielles de départ

| Sujet | URL |
|---|---|
| RGPD | https://eur-lex.europa.eu/eli/reg/2016/679/oj |
| RGPD CNIL | https://www.cnil.fr/fr/reglement-europeen-protection-donnees |
| Loi Informatique et Libertés | https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000886460 |
| ePrivacy | https://eur-lex.europa.eu/eli/dir/2002/58/oj |
| Cookies | https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies/que-dit-la-loi |
| Registre RGPD | https://www.cnil.fr/fr/RGPD-le-registre-des-activites-de-traitement |
| Transferts | https://www.cnil.fr/fr/les-outils-de-la-conformite/transferer-des-donnees-hors-de-lue |
| AIPD | https://www.cnil.fr/fr/RGPD-analyse-impact-protection-donnees-aipd |
| LCEN | https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000801164 |
| Mentions site professionnel | https://entreprendre.service-public.fr/vosdroits/F31228 |
| Consommation | https://www.legifrance.gouv.fr/codes/id/LEGITEXT000006069565 |
| Accessibilité 2019/882 | https://eur-lex.europa.eu/eli/dir/2019/882/oj |
| RGAA | https://accessibilite.numerique.gouv.fr/rgaa/ |
| CRA 2024/2847 | https://eur-lex.europa.eu/eli/reg/2024/2847/oj |
| Portail CRA | https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act |
| NIS2 | https://eur-lex.europa.eu/eli/dir/2022/2555/oj |
| DSA | https://eur-lex.europa.eu/eli/reg/2022/2065/oj |
| AI Act | https://eur-lex.europa.eu/eli/reg/2024/1689/oj |
| Data Act | https://eur-lex.europa.eu/eli/reg/2023/2854/oj |
| Dispositifs médicaux | https://eur-lex.europa.eu/eli/reg/2017/745/oj |
| ANSSI | https://cyber.gouv.fr/ |
| ENISA | https://www.enisa.europa.eu/ |
| DGCCRF | https://www.economie.gouv.fr/dgccrf |
| SPDX | https://spdx.dev/learn/handling-license-info/ |
| OSI | https://opensource.org/licenses |
| `security.txt` | https://www.rfc-editor.org/rfc/rfc9116 |

Teste les liens et remplace une URL morte par l'URL officielle actuelle.

## 8. Fiche d'identité réglementaire

| Champ | Valeur attendue |
|---|---|
| Audit | Date ISO, version et auteur de rôle |
| Version | Commit, tag et empreintes |
| Produit | Nom public et composants |
| Éditeur | Identité vérifiée ou `NON FOURNI` |
| Forme et établissement | Faits vérifiés ou `NON FOURNI` |
| Territoires et publics | France, UE, EEE, monde ; B2C, B2B, mineurs |
| Canaux | Site, forge, store, registre, miroir |
| Artefacts | Formats, OS et architectures |
| Licence | Identifiant SPDX et texte exact |
| Modèle économique | Gratuit, dons, freemium, payant, autre |
| Activité commerciale CRA | Oui, non ou incertain avec motifs |
| Services distants | Liste ou `NON OBSERVÉ` |
| Comptes | Obligatoire, optionnel ou aucun |
| Données | Catégories, sources et finalités |
| Traceurs site | Exemptés, soumis ou indéterminés |
| Télémétrie | Défaut, opt-in, opt-out ou aucune observée |
| Sous-traitants | Liste ou `NON FOURNI` |
| Transferts | Pays, mécanismes et incertitudes |
| Fonctions sensibles | IA, santé, finance, mineurs, IoT |
| Support | Durée et politique annoncées |
| Sécurité | Contact public et propriétaire interne |

## 9. Matrice et priorités

Utilise exclusivement :

- `OBLIGATOIRE` : obligation applicable établie ;
- `CONDITIONNEL` : dépend d'un fait, rôle ou seuil ;
- `RECOMMANDÉ` : mesure proportionnée non démontrée obligatoire ;
- `NA` : hors champ démontré et justifié.

N'utilise jamais `NA` pour « non vérifié ».
`À CONFIRMER` est un état de preuve, pas un statut juridique.

| ID | Domaine | Exigence | Statut | Fondement | Preuve | Écart | Priorité | Action | Échéance |
|---|---|---|---|---|---|---|---|---|---|
| Structure à supprimer | Domaine | Exigence formulée | CONDITIONNEL | Source à vérifier | NON FOURNI | À établir | P2 | Test précis | NON FOURNI |

Supprime la ligne de structure du rapport final.
Chaque ligne finale cite une source officielle, explique l'applicabilité, lie une preuve et définit un test.

| Priorité | Critère | Réponse |
|---|---|---|
| P0 | Danger grave immédiat, secret, compromission, traitement manifestement illicite ou distribution juridiquement bloquée | Contenir et escalader immédiatement |
| P1 | Obligation applicable non satisfaite avec risque élevé | Corriger avant publication ou délai court documenté |
| P2 | Écart modéré, preuve incomplète ou contrôle fragile | Planifier dans le cycle proche |
| P3 | Durcissement, documentation ou automatisation | Backlog avec test d'acceptation |

Évalue probabilité, impact, volume, sensibilité, exposition, réversibilité et dépendances.

## 10. Mentions légales

Qualifie le site comme professionnel, associatif, personnel ou indéterminé.
Vérifie le régime LCEN exact de l'entité.
Pour un site professionnel, vérifie selon le cas :

- identité ou dénomination de l'éditeur ;
- forme, adresse, capital, registre et immatriculation ;
- courriel, téléphone et TVA si requis ;
- directeur ou responsable de publication ;
- nom, adresse et téléphone de l'hébergeur ;
- autorité et titre pour activité réglementée ;
- médiateur de la consommation si applicable ;
- propriété intellectuelle et liens vers vie privée et traceurs.

Pour un éditeur non professionnel, vérifie les conditions d'anonymat auprès de l'hébergeur au lieu de copier les mentions d'une société.
Ne publie pas l'adresse privée d'un mainteneur sans vérifier obligation, nécessité et risque.
Teste l'accès aux mentions depuis chaque page, sur mobile, sans script non nécessaire.

## 11. Cookies, stockage terminal et CMP

Inventorie cookies, localStorage, sessionStorage, IndexedDB, caches, service workers, ETags, pixels, liens décorés, fingerprinting et SDK.
Pour chacun, note finalité, déposant, durée, destinataire et exemption invoquée.
Ne qualifie « nécessaire » que ce qui est strictement nécessaire à la communication ou au service expressément demandé.

Applique :

- blocage de tout traceur soumis avant consentement ;
- finalités présentées avant le choix ;
- accepter et refuser aussi simples et visibles ;
- aucune case précochée ni accord par poursuite de navigation ;
- choix granulaire et retrait permanent accessible ;
- retrait aussi simple que l'accord ;
- preuve proportionnée sans suivi supplémentaire ;
- nouveau choix en cas de nouvelle finalité ;
- respect sur routes, sous-domaines et appareils concernés ;
- service essentiel fonctionnel après refus.

### Tests des quatre états

État 1, visite neuve sans choix :

- utilise un profil vierge ;
- vérifie zéro lecture, écriture ou appel soumis ;
- vérifie information visible et boutons symétriques ;
- conserve capture réseau et écran.

État 2, acceptation :

- accepte toutes les finalités ;
- vérifie uniquement les traceurs annoncés ;
- compare domaines, finalités, durée et preuve du choix ;
- teste ensuite le paramétrage fin.

État 3, refus :

- refuse toutes les finalités non nécessaires ;
- vérifie l'absence des traceurs et appels soumis ;
- navigue, recharge et vérifie la persistance ;
- teste fonctions essentielles et téléchargement.

État 4, retrait ou modification :

- pars d'un état accepté puis retire ;
- vérifie l'arrêt des nouvelles collectes ;
- traite les identifiants lorsque requis ;
- vérifie effort égal et choix granulaire.

Répète sur mobile, bureau et un navigateur sans extension.

## 12. Traceurs et télémétrie du logiciel

Traite comme potentiellement personnelles : IP, UUID, device ID, configuration rare, logs, chemins, stack traces, compte, position et usage fin.

Pour chaque flux sortant :

- identifie le déclencheur et le payload ;
- relève domaine, fournisseur, pays et protocole ;
- vérifie minimisation, base légale et information ;
- vérifie opt-in, nécessité et désactivation ;
- vérifie durée serveur et comportement hors ligne ;
- vérifie le crash et l'updater séparément.

Préférer :

- télémétrie non nécessaire désactivée par défaut ;
- consentement explicite, granulaire et révocable ;
- agrégation locale et absence d'identifiant stable ;
- événements rares et documentés ;
- prévisualisation d'un rapport de crash ;
- commande simple pour supprimer les données locales.

Ne limite jamais l'analyse aux cookies du navigateur.

## 13. RGPD complet

### 13.1 Registre et gouvernance

- Cartographie site, application, support, sécurité, communauté, dons et RH.
- Identifie responsable, responsables conjoints et sous-traitants.
- Consigne finalité, personnes, données, destinataires, transferts et durées.
- Consigne sources, sécurité, propriétaires et preuves.
- Tiens un registre dès que l'exception n'est pas clairement démontrée.
- Date les versions et lie chaque traitement au comportement réel.

### 13.2 Bases légales

- Choisis une base par finalité avant traitement.
- N'utilise pas le consentement s'il n'est pas librement révocable.
- N'invoque pas le contrat pour une donnée non nécessaire au service.
- Documente le test de mise en balance de l'intérêt légitime.
- Identifie précisément toute obligation légale.
- Sépare base RGPD et consentement ePrivacy.
- Escalade données sensibles, biométriques ou pénales.
- Interdis les bases alternatives non tranchées.

### 13.3 Information

Vérifie :

- identité et contact du responsable et du DPO applicable ;
- finalités, bases et intérêts légitimes ;
- catégories et sources en collecte indirecte ;
- destinataires, transferts et garanties ;
- durée ou critères ;
- droits, retrait et réclamation CNIL ;
- caractère obligatoire et conséquence du refus ;
- décision automatisée et logique utile.

Fournis l'information par couches au moment pertinent.
Aligne chaque mot sur le flux observé.

### 13.4 Droits

- Couvre accès, rectification, effacement, limitation et opposition.
- Couvre portabilité, retrait et décision automatisée si applicables.
- Couvre les directives post-mortem françaises si pertinentes.
- Journalise demande, identité, recherche, réponse et délai.
- Ne demande pas une pièce d'identité par défaut.
- Teste avec un scénario interne sans nouvelle donnée réelle.
- Vérifie sauvegardes, tiers, dérivés et réinscription.

### 13.5 Conservation

- Fixe durée ou critère par catégorie et finalité.
- Sépare base active, archive intermédiaire et sauvegarde.
- Automatise effacement ou anonymisation.
- Justifie logs de sécurité et comptes inactifs.
- Refuse « indéfini » ou « tant que nécessaire » sans critère.
- Teste la purge et documente les gels contentieux.

### 13.6 Sous-traitants et transferts

- Qualifie chaque rôle et vérifie l'article 28.
- Vérifie instructions, sécurité, assistance, audit et suppression.
- Inventorie les sous-traitants ultérieurs.
- Identifie stockage, support et accès distant.
- Vérifie adéquation, clauses types et mesures supplémentaires.
- Réalise l'analyse de transfert nécessaire.
- Ne confonds pas région UE et absence de transfert.
- Prévois sortie, restitution et effacement.

### 13.7 Sécurité

- Applique moindre privilège, chiffrement et séparation d'environnements.
- Évite les données réelles en test.
- Journalise les accès administratifs.
- Maintiens patching, sauvegarde et restauration testée.
- Gère secrets, revues de code et dépendances.
- Documente risques, contrôles, tests et obligations contractuelles.

### 13.8 AIPD et DPO

Évalue l'AIPD pour surveillance, profilage, données sensibles, grande échelle, personnes vulnérables, combinaison, innovation ou exclusion.
Consulte les listes CNIL et documente la décision de faire ou non l'AIPD.
Évalue le DPO selon l'article 37 et le droit applicable.
Ne nomme jamais un DPO fictif.
Si aucun DPO n'est requis, nomme le rôle « contact vie privée », pas DPO.

### 13.9 Violations

- Maintiens canal interne, grille de qualification et rôles d'urgence.
- Contiens sans détruire les preuves.
- Documente nature, volume, catégories, risque et remédiation.
- Tiens un registre de toutes les violations.
- Notifie la CNIL sous 72 heures lorsque requis et justifie le retard.
- Informe sans délai indu en cas de risque élevé, sauf exception.
- Coordonne les sous-traitants et le retour d'expérience.

## 14. Licence OSS et propriété intellectuelle

### 14.1 Licence et SPDX

- Inclue un texte complet et cohérent avec le nom annoncé.
- Utilise un identifiant SPDX valide.
- Vérifie métadonnées, en-têtes et titulaire des droits.
- Couvre code, documentation, assets, polices et modèles.
- Ne qualifie pas OSS une licence restreignant des usages essentiels.
- Sépare licence du code et politique de marque.

### 14.2 Compatibilité

- Inventorie dépendances directes, transitives, de build, vendues et copiées.
- Identifie licence et niveau de confiance.
- Lis les licences inconnues, custom ou modifiées.
- Vérifie compatibilité avec la distribution choisie.
- Vérifie notice, attribution, brevet, publicité et modification.
- Traite correctement les licences duales.
- Bloque une licence absente ou contradictoire jusqu'à résolution.

### 14.3 Copyleft et source correspondante

- Distingue copyleft faible, fort et réseau.
- Analyse lien, intégration, modification et accès réseau.
- Lie exactement source et binaire.
- Inclue patches et scripts exigés de build ou installation.
- Fournis avis ou offre écrite selon le mécanisme retenu.
- Vérifie portée et durée de l'offre.
- N'utilise pas une branche mouvante comme seule source.

### 14.4 Contributions, DCO, CLA et marque

- Publie procédure et licence de contribution.
- Choisis DCO ou CLA selon la gouvernance réelle.
- Vérifie la chaîne de droits historique.
- Justifie tout CLA plus large.
- Conserve attestations vérifiables.
- Sépare fork, usage nominatif et usage de marque.
- Vérifie licences des logos et captures.

## 15. Téléchargements et stores

- Affiche version, date, OS, architecture et prérequis.
- Affiche licence et source avec le téléchargement.
- Fournis empreintes via un canal authentifié.
- Fournis signature et procédure de vérification.
- Lie binaire, changelog, tag et source correspondante.
- Signale versions obsolètes et fin de support.
- Évite boutons trompeurs et bundles inutiles.
- Distingue conditions du store et droit applicable.
- Vérifie déclaration de données du store contre le trafic.
- Vérifie âge, permissions et coordonnées développeur.
- Vérifie crypto et export si pertinents.
- Documente retrait d'une version compromise.

## 16. Sécurité produit et supply chain

### 16.1 Politique et `security.txt`

- Publie périmètre, versions supportées, contact sécurisé et processus.
- Définis triage, sévérité, embargo, coordination et fin de support.
- Évite les délais promis impossibles.
- Place `/.well-known/security.txt` selon RFC 9116.
- Inclue `Contact` et `Expires`, puis envisage `Encryption`, `Policy` et `Canonical`.
- Teste URL, MIME, redirection, contact et expiration.
- Aligne avec `SECURITY.md` et les stores.

### 16.2 SBOM

- Génère une SBOM SPDX ou CycloneDX par artefact et release.
- Inclue versions, identifiants, relations et licences.
- Inclue composants vendus, statiques et conteneurs.
- Lie la SBOM à l'empreinte de l'artefact.
- Archive outil et version.
- Vérifie contre lockfile et binaire.
- Marque toute limite de complétude.

### 16.3 Provenance et signatures

- Construis dans un environnement éphémère et contrôlé.
- Épingle actions, images, compilateurs et dépendances critiques.
- Sépare build et publication.
- Protège les clés ou utilise une identité de workload.
- Atteste commit, paramètres et artefact.
- Signe artefacts, manifests et attestations.
- Vérifie dans un job distinct avant publication.
- Documente rotation, révocation et compromission.

### 16.4 Updater

- Vérifie TLS, signature, version et canal.
- Protège contre downgrade, replay et rollback non autorisé.
- Sépare stable, beta et nightly.
- N'exécute aucun payload non authentifié.
- Échoue de façon sûre et prévois la reprise.
- Minimise les métadonnées du check.
- Teste miroir compromis, paquet tronqué et mauvaise clé.

### 16.5 Vulnérabilités

- Scanne dépendances, code, images et secrets.
- Analyse exploitabilité et portée, pas seulement le score CVE.
- Corrige ou mitige selon risque et support.
- Publie un avis lorsque l'utilisateur doit agir.
- Gère faux positifs avec justification et expiration.
- Rejoue les tests après correction.

## 17. Cyber Resilience Act

Utilise le règlement (UE) 2024/2847 et relis sa version officielle consolidée.
Détermine si le produit comporte des éléments numériques, s'il est mis sur le marché et dans quelle activité.

Pour le logiciel libre :

- vérifie l'exclusion du développement ou de la fourniture hors activité commerciale ;
- examine fournisseur, revenus, avantages et gouvernance ;
- ne traite pas un don isolé comme preuve automatique de commerce ;
- examine dons conditionnés, support, hébergement et services payants ;
- examine monétisation de données au-delà des usages admis par le texte ;
- distingue fabricant, importateur, distributeur et steward OSS ;
- documente indices favorables et défavorables ;
- demande validation juridique si la frontière reste incertaine.

Si applicable, cartographie :

- exigences essentielles et analyse de risques ;
- sécurité dès la conception et absence de vulnérabilité exploitable connue selon le texte ;
- traitement des vulnérabilités et période de support ;
- instructions, documentation technique et composants tiers ;
- évaluation de conformité, déclaration UE et marquage CE ;
- signalements, conservation documentaire et coopération ;
- obligations propres au rôle dans la chaîne.

Dates repères à revérifier à chaque audit :

- `11 septembre 2026` : obligations de signalement annoncées ;
- `11 décembre 2027` : application générale annoncée ;
- toute date intermédiaire : relire le texte et les actes secondaires.

Vérifie notamment l'article 71 avant de reproduire ces dates.
Si une personne morale soutient durablement un logiciel libre destiné à des activités commerciales, évalue le statut d'open-source software steward.
N'applique pas mécaniquement au steward toutes les obligations du fabricant.

## 18. Droit de la consommation

Le périmètre peut être réduit pour un logiciel réellement gratuit, sans contrat payant ni contrepartie, mais jamais automatiquement `NA`.

Réexamine si :

- les données personnelles servent de contrepartie ;
- leur traitement dépasse fourniture du service ou obligation légale ;
- freemium, abonnement, achat intégré ou cloud existe ;
- don conditionné, publicité, affiliation ou marketplace existe ;
- un professionnel cible des consommateurs de l'UE.

Vérifie alors :

- information précontractuelle, caractéristiques et prix futurs ;
- durée, renouvellement, résiliation et support durable ;
- fourniture, conformité, garanties et mises à jour de sécurité ;
- rétractation et exceptions ;
- médiation de la consommation ;
- pratiques trompeuses, avis, classements et dark patterns ;
- résiliation électronique lorsqu'elle s'applique.

Ne rédige pas de CGV fictives pour une offre inexistante.

## 19. Accessibilité

Qualifie entité, service, public, exemption et calendrier.
Vérifie directive (UE) 2019/882, transposition française et obligations du secteur public éventuelles.
Étends l'analyse au site, application, installateur, documentation et support.
Ne déclare jamais un taux RGAA sans audit selon la méthode officielle.

Même hors obligation démontrée, vise :

- WCAG 2.2 AA comme cible technique à confirmer ;
- clavier, focus, ordre logique et contrastes ;
- alternatives, labels et erreurs accessibles ;
- zoom, reflow, sous-titres et transcriptions ;
- lecteur d'écran et documentation accessible.

## 20. E-mail et communauté

- Distingue transactionnel, sécurité, newsletter et prospection.
- Recueille le consentement lorsque requis et conserve sa preuve.
- Fournis désinscription simple et traite l'opposition.
- Évite les pixels ou applique le régime pertinent.
- Informe avant archivage public d'une liste.
- Protège les adresses dans tickets et archives.
- Définis modération, conservation et suppression.
- Informe que commits et archives peuvent être durables.
- Vérifie bots, webhooks et synchronisations marketing.

## 21. Régimes conditionnels

### IA

Déclenche l'AI Act si le logiciel peut répondre à la définition d'un système ou modèle d'IA.
Vérifie rôle, pratique interdite, haut risque, transparence, GPAI, calendrier et limites des exemptions open source.
Vérifie aussi droits d'auteur, documentation et gouvernance des données.

### DSA

Déclenche si le service transmet, met en cache ou héberge des informations d'utilisateurs.
Vérifie rôle, contact, conditions, notification-action, motivation, recours, transparence, mineurs et marketplace.
N'étends pas les exemptions des micro et petites entreprises aux obligations qui demeurent.

### NIS2

Déclenche selon secteur, taille, établissement et transposition française.
Vérifie entité essentielle ou importante, gouvernance, risques, supply chain, continuité et signalement.
Ne confonds pas NIS2, qui vise des entités, avec CRA, qui vise des produits et opérateurs.

### Santé

Déclenche si une finalité médicale influence diagnostic, prévention, pronostic, traitement ou surveillance.
Vérifie destination prévue, dispositif médical, classe, clinique, qualité, vigilance, HDS, AIPD et données sensibles.

### Finance

Déclenche pour paiement, crédit, assurance, conseil, investissement ou crypto-actifs.
Vérifie agrément, LCB-FT, sécurité des paiements, DORA, MiCA, information et profilage.

### Mineurs

Déclenche si les mineurs sont visés ou susceptibles d'utiliser le service.
Vérifie âge, langage, consentement, minimisation, privé par défaut, publicité, profilage, géolocalisation, modération et dark patterns.

### Data Act

Déclenche pour produit connecté, service connexe ou données générées par l'usage.
Vérifie accès, partage, information, secrets, sécurité, clauses B2B, cloud, interopérabilité et calendrier.

## 22. Documents publics et internes

Publics selon applicabilité :

- mentions légales, confidentialité et cookies ;
- licences, notices et source correspondante ;
- `SECURITY.md`, `security.txt`, support et fin de vie ;
- changelog, avis de sécurité et vérification des signatures ;
- conditions, CGV et médiation si justifiées ;
- accessibilité, marque, contribution, DCO ou CLA ;
- informations et déclaration UE CRA si applicables.

Internes selon applicabilité :

- fiche d'identité, matrice et décisions ;
- registre, bases, conservations, DPA, transferts et AIPD ;
- droits, violations et réponse aux incidents ;
- inventaire, SBOM, risques produit et dossier CRA ;
- licences, contributions, releases et accessibilité ;
- décisions sur chaque régime conditionnel.

Ne publie pas contrats, registres, AIPD ou détails sensibles par défaut.

## 23. CI/CD

| Contrôle | Fréquence | Blocage |
|---|---|---|
| Licences SPDX | Changement de dépendance | Inconnue ou interdite |
| SBOM | Release | Absente ou non liée |
| Secrets | Commit et release | Secret actif |
| Vulnérabilités | Build et quotidien | Seuil contextualisé |
| SAST | Pull request | Nouvelle faiblesse critique |
| Télémétrie | Pull request | Envoi avant choix |
| CMP réseau | Déploiement | Traceur soumis après refus |
| Provenance | Release | Absente ou incohérente |
| Signature | Artefact | Manquante ou invalide |
| `security.txt` | Quotidien | Expiré ou contact invalide |
| Liens légaux | Hebdomadaire | Page essentielle inaccessible |
| Accessibilité | Interface | Régression définie |

Épingle les outils, archive les rapports et protège secrets et données dans les logs.
Les scanners ne remplacent ni analyse manuelle ni observation réseau.

## 24. Dossier de preuves

Si plusieurs fichiers sont autorisés, adapte cette structure au dépôt :

```text
compliance-evidence/
  index.md
  scope/
  legal-sources/
  privacy/
  cookies/
  licenses/
  releases/
  security/
  accessibility/
  conditional-regimes/
  decisions/
