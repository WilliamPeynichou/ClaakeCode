# Plan complet — performance et benchmark des modèles

Périmètre : `sinew/` uniquement. Les mesures sont locales. Aucun appel fournisseur payant n'est requis pour ce plan; B5 reste désactivé tant qu'il n'est pas explicitement implémenté et confirmé par l'utilisateur.

## État constaté (lecture du code existant)

- **Mesures rétroactives (B1)** : agrégation de l'historique d'usage (réponses, tokens, cache, outils), CSV généré en Rust; historique legacy daté approximativement via les conversations. Cette agrégation reste distincte des séries exactes.
- **Séries temporelles exactes (demande 2)** : `get_model_usage_series` agrège uniquement `model_turns` dans des buckets UTC `[startAtMs,endAtMs)` fournis par l'UI (calendrier local mensuel/annuel). Données manquantes/prix non configurés limitent ou rendent nul le coût estimé; ce n'est ni une facture ni une reconstruction exacte de l'historique legacy. Vérifier coverage/compteurs côté UI.
- **Mesures persistées (B2)** : `model_turns` capture les tours classiques, sous-agents et RLM, horodatage exact, durée, premier token, statut et compteurs disponibles; données sans contenu conversationnel.
- **Settings (B3)** : `ModelStatsSection.tsx`, réglages de période/harness, tri, fiabilité n, export/effacement et tarifs manuels. Un helper calendrier transforme les limites locales en epoch UTC.
- **Prix (B4)** : tarifs configurés par l'utilisateur; les coûts sont des estimations, incomplets quand l'usage manque.
- **Sélecteur (B6)** : résumé conditionné à un nombre minimal de mesures.
- **Benchmark actif (B5, première version)** : `benchmark.rs` fournit une suite fixe, exécution explicitement confirmée, contrôle d'un plafond budgétaire avant chaque requête et arrêt via commande. Les résultats sont stockés séparément sous `active_benchmark_runs`, sans contenu de prompt/réponse; ils ne font pas partie des statistiques d'usage. Les prix USD doivent être renseignés et restent des estimations, pas une facture. La reproductibilité est limitée au modèle/suite/version et aux entrées fixes; provider, réseau et disponibilité du modèle peuvent varier.

Limites déjà documentées : TTFT classique correspond au premier delta de contenu observé, RLM au premier texte; débits actuels concernent le tour entier, outils/attentes inclus. Les retries récupérés ne sont pas comptés comme erreurs de tour. RLM ne fournit pas actuellement les tokens au mapping. Les données legacy ne permettent pas un filtrage temporel exact par message.

## Plan priorisé

| Priorité | Feature / complexité / dépendances | Portée et critères d'acceptation | Tests attendus |
|---|---|---|---|
| P0 | **Filtres calendaires cohérents** — moyenne; dépend de B1/B2/B3 | Mois/année dans le fuseau local, convertis en `[startAtMs,endAtMs)` UTC; bornes complètes, start < end; applicables de façon identique aux mesures exactes et à l'historique legacy; export reprend exactement le filtre. Aucun décalage d'un jour à la frontière. | Dates de fin/début, inclusivité/exclusivité, année bissextile, DST, validation paire et ordre, export avec bornes. Tests ciblés UI/Rust. |
| P0 | **Intégrité des mesures existantes** — moyenne; dépend de B2 | Vérifier agrégations, attribution harness/modèle, statuts, effacement et séparation legacy/mesures afin d'éviter double comptage; préserver les anciens stores. Signaler toute divergence avant extension fonctionnelle. | Tests Rust de migrations et agrégations, scénarios erreurs/interruption/réécriture/sous-agent/RLM, tests UI pour filtres et CSV. |
| P1 | **Observabilité de performance** — complexe; dépend de mesures fiables B2 | Séparer p50/p95 TTFT, latence de tour et débit de génération (tokens de sortie / temps génération, sans outils/attentes). Afficher dénominateurs n et avertissement faible échantillon; retries, erreurs et interruptions séparés. Ne pas présenter débit tour comme débit génération. | Séries déterministes avec valeurs connues, absence de données, outliers, erreurs et interruptions; cohérence statistiques et libellés UI. |
| P1 | **Coûts historiques et comparabilité** — complexe; dépend de B4/B2 | Conserver version/date d'effet des tarifs pour recalcul reproductible ou préciser explicitement que l'estimation utilise le tarif courant. Comparer uniquement des configurations comparables : provider/modèle/version, paramètres, harness, prompt/contexte, outils et environnement réseau; étiqueter les changements connus. | Calcul tarifaire avec cache, absence de prix, changements tarifaires, comparabilité empêchée si configuration diverge. |
| P1 | **Qualité séparée de la performance** — complexe; indépendante du tableau d'usage | Suite déterministe et versionnée avec critères de scoring, résultats séparés des métriques de vitesse/coût; limiter les conclusions à la suite utilisée. Ne jamais déduire la qualité d'un usage réel ou d'un proxy de réécriture. | Fixtures fixes, répétabilité du score, versions de suite/rubrique et stockage isolé. |
| P2 | **Benchmark actif B5** — complexe; dépend de P1 comparabilité, suite qualité et sécurité budgétaire | Exécution opt-in sur modèles choisis et mêmes entrées/configurations; simulation d'estimation, écran de confirmation, plafond global, stop/annulation, arrêt sûr sur dépassement, suivi des coûts incertains. Stockage séparé, aucune exécution automatique, confirmation avant tout appel potentiellement payant. | Tests sans réseau avec faux fournisseur: budget, annulation, erreur/retry, estimation dépassée et isolation; pas d'appel réel pour valider. |
| P2 | **Confidentialité et export benchmark** — moyenne; dépend de B5 | Export minimal, explicite, local; exclusion par défaut des prompts/réponses/secrets, métadonnées de configuration documentées, aperçu avant export et effacement des résultats. | Tests de redaction, formules CSV neutralisées, absence de contenu sensible, effacement. |

## Ordre de réalisation

1. Finaliser et valider P0 calendrier/intégrité sans écraser le travail déjà présent.
2. Compléter P1 mesures réellement séparées (TTFT, latence tour, débit génération, retries/erreurs), libellés et tests.
3. Définir la politique des tarifs historiques et les clés de comparabilité; implémenter tests et affichage des limites.
4. Définir/valider la suite qualité déterministe indépendamment des statistiques de performance.
5. Concevoir B5 seulement après accord explicite : flux de confirmation, limites de dépenses et stop testés avec mocks avant tout appel réel.
6. Ajouter l'export/confidentialité dédiés B5, puis documenter les limites et résultats mesurés.

Les contrôles exécutés pour cette intégration : `npm run build`, `cargo check -p claakecode`, `cargo test -p claakecode --lib` (32 tests). Les tests Rust ne lancent aucun appel fournisseur. Limites non validées : le moteur benchmark n'a pas de tests avec fournisseur simulé; le plafond budgétaire dépend d'une réservation conservatrice fondée sur max output et 1000 tokens d'entrée; `estimate_tokens` et usage réel peuvent diverger, donc un budget USD saisi n'est pas une garantie de facture maximale. Les commandes ne vérifient pas un catalogue modèle dédié, seulement que le provider est disponible et que des tarifs sont configurés pour la paire provider/modèle.

- Aucun coût fournisseur utilisé pour les validations de cette livraison.
- Tout plafond backend est une estimation/réservation conservatrice, pas un plafonnement de facturation garanti par le provider.
- Le bench actif ne valide pas encore un catalogue modèle et n'a pas de tests faux-provider; ne pas considérer ces éléments comme certifiés.
- Ne pas appeler « classement » les statistiques d'usage réel; tâches, contexte, paramètres et réseau influencent les chiffres.
- Séparer clairement les métriques legacy approximatives des mesures exactes `started_at_ms`.
- Aucun contenu prompt/réponse dans les mesures persistées/exports par défaut; toute donnée exportée est locale et choisie par l'utilisateur.
- Pas de commit dans ce chantier.
