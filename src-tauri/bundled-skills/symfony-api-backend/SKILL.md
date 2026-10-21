---
name: symfony-api-backend
description: Skill Symfony orienté API/backend — guide l'agent pour concevoir, modifier, auditer et améliorer une application Symfony côté serveur (contrôleurs API, services, Doctrine, validation, sécurité, erreurs, tests) en appliquant les pratiques officielles actuelles du framework.
type: project
---

# Skill — Symfony API / Backend

## Déclencheur

Activer ce skill quand la demande concerne :

- **Symfony** (framework PHP), une **API PHP**, un **backend Symfony**.
- **Doctrine** (entités, repositories, migrations, requêtes).
- La **sécurité Symfony** (authentification, autorisation, rôles, voters).
- Les **contrôleurs API**, la **validation**, les **services**, les **tests**.
- L'**architecture** d'une application Symfony.

**Comportement obligatoire** : avant de modifier un projet Symfony existant, **comprendre d'abord** :

- La **structure** du projet (`src/`, `config/`, `tests/`, `migrations/`).
- Les **conventions** déjà en place (nommage, organisation, formats de config).
- La **version** du framework (`composer.json`, `symfony/*`).
- Les **choix techniques** (API Platform, JWT, Messenger, sérialisation, etc.).

Suivre les conventions existantes du projet **prime** sur ce skill. Ne pas réorganiser une base de code sans raison.

---

## Orientation générale (API / backend)

Ce skill est orienté **API/backend**. Privilégier systématiquement :

- Les **réponses JSON** plutôt que le rendu de pages HTML.
- Les **contrôleurs légers** (validation → délégation → réponse).
- Les **services métier réutilisables**.
- L'**injection de dépendances** (jamais le conteneur en direct).
- Les **DTO / objets de requête** pour représenter les entrées API.
- La **validation systématique** des données entrantes.
- **Doctrine** pour l'accès aux données.
- Les **migrations** pour toute évolution de schéma.
- La **sécurité** par authentification, autorisation et contrôle d'accès.
- Les **tests** fonctionnels et d'intégration.
- Les **diagnostics** Symfony (`debug:*`, `lint:*`) pour comprendre routes, services, validations et erreurs.

---

## 1. Philosophie Symfony backend

Symfony repose sur un cycle simple :

```
Requête HTTP → Route → Contrôleur → Service(s) → Réponse HTTP
```

Une requête entre, une **route** choisit un **contrôleur**, le contrôleur **délègue** le travail aux **services**, puis une **réponse** est retournée.

Principes directeurs :

- Un **contrôleur ne contient pas** la logique métier principale.
- Les **services portent** les règles applicatives.
- Les **entités** représentent le modèle métier et restent **cohérentes** (pas d'état invalide).
- Les **repositories** sont dédiés à la recherche et aux requêtes de données.
- Les **données entrantes** sont **toujours validées** avant usage.
- Les **erreurs** sont transformées en réponses API **claires**.
- Les **décisions de sécurité** sont **explicites et testées**.

---

## 2. Routes et contrôleurs API

### Règles routes

- Définir des routes **claires, stables et prévisibles** (`/api/...`).
- Utiliser des **noms de routes cohérents** (ex. `api_product_show`).
- **Restreindre** chaque route aux **méthodes HTTP** attendues (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`).
- Utiliser des **paramètres typés et validés** (`requirements`, `Requirement::DIGITS`, `Requirement::UUID`).
- **Éviter** les routes ambiguës ou trop génériques (priorité, requirements pour lever les conflits).
- Déclarer le **format JSON** sur les routes API (`format: 'json'`) pour des erreurs renvoyées en JSON.

### Règles contrôleurs

- Contrôleur **court** : il valide, délègue, répond.
- Retourner des **réponses JSON cohérentes**.
- Utiliser les **bons statuts HTTP** :
  - `200` succès, `201` création, `204` suppression sans contenu.
  - `400` requête malformée, `401` non authentifié, `403` interdit, `404` absent.
  - `409` conflit métier, `422` entité non traitable (validation).
- Gérer proprement les **ressources absentes** (404 explicite).
- **Ne jamais** révéler de détails internes dans les messages d'erreur.

### Helpers contrôleur les plus utiles (par intention)

- **Générer une réponse JSON** → `$this->json($data, $status)`.
- **Rediriger vers une route** → `$this->redirectToRoute()` (rare en API pure).
- **Générer une URL** → `$this->generateUrl()`.
- **Refuser l'accès** → `$this->denyAccessUnlessGranted()`.
- **Erreur ressource introuvable** → `$this->createNotFoundException()`.
- **Récupérer l'utilisateur courant** → argument `#[CurrentUser]`.
- **Lire la requête** → argument typé `Request` (`query`, `getPayload`, `headers`, `files`).
- **Mapper une charge utile JSON** → `#[MapRequestPayload] Dto $dto`.
- **Mapper la query string** → `#[MapQueryString] Dto $dto` / `#[MapQueryParameter]`.
- **Mapper et valider les fichiers** → `#[MapUploadedFile]` avec contraintes.

---

## 3. Services et injection de dépendances

### Règles

- Créer un **service** pour toute logique réutilisable.
- **Injecter** les dépendances par le constructeur (type-hint).
- Préférer les **interfaces** quand plusieurs implémentations existent.
- Garder les services **privés** autant que possible.
- S'appuyer sur **autowiring + autoconfiguration** (config par défaut de `services.yaml`).
- Configurer **explicitement** seulement les cas ambigus (valeurs scalaires, choix d'implémentation).
- **Ne pas** mettre de logique métier durable dans les contrôleurs.
- **Ne pas** dépendre du conteneur (`$container->get()`) dans les classes métier.

### Usages Symfony utiles (services)

- **Injection automatique par type** : type-hinter l'interface/classe dans le constructeur.
- **Injection explicite** d'une implémentation : `#[Autowire(service: '...')]` ou config `arguments`.
- **Injection d'un paramètre** : `#[Autowire('%kernel.project_dir%')]` ou `getParameter()`.
- **Service selon l'environnement** : attributs `#[When(env: 'dev')]` / `#[WhenNot(...)]`.
- **Décoration** d'un service existant : `#[AsDecorator]` ou `decorates`.
- **Tags** pour enregistrer plusieurs implémentations (handlers, subscribers, extensions, stratégies) : auto-tag via interface + `!tagged_iterator`.
- **Diagnostic** : `php bin/console debug:autowiring`, `debug:container`, `lint:container`.

---

## 4. Doctrine et base de données

Doctrine est l'outil central : **entités**, **repositories**, **migrations**, **requêtes**.

### Règles

- Définir des entités au **modèle cohérent** (mapping par **attributs PHP**).
- Une **migration** pour **chaque** changement de schéma (`make:migration`).
- **Relire** la migration générée **avant** de l'exécuter (`doctrine:migrations:migrate`).
- Utiliser les **repositories** pour les recherches.
- Réserver les **requêtes personnalisées** aux repositories (pas dans les contrôleurs).
- Utiliser l'**EntityManager** pour créer, modifier, supprimer.
- Appeler `flush()` **une seule fois**, après que l'objet est prêt.
- Gérer les **transactions** quand plusieurs opérations doivent réussir ensemble.
- Surveiller les **performances** et le **nombre de requêtes** (N+1, jointures, `setMaxResults`).

### Méthodes Doctrine utiles (par usage)

- **Par identifiant** → `$repo->find($id)`.
- **Un élément selon critères** → `$repo->findOneBy([...])`.
- **Une liste selon critères + tri** → `$repo->findBy([...], ['champ' => 'ASC'])`.
- **Tous les éléments** → `$repo->findAll()` (attention aux volumes).
- **Requête dynamique** → `createQueryBuilder()` (filtres conditionnels).
- **Persister une nouvelle entité** → `$em->persist($entity)`.
- **Sauvegarder** → `$em->flush()`.
- **Supprimer** → `$em->remove($entity)` puis `flush()`.
- **Transaction** → `$em->wrapInTransaction(fn () => ...)` ou begin/commit/rollback.
- **SQL brut** (seulement si l'ORM n'est pas adapté) → connexion DBAL `executeQuery()`.
- **Mapping auto depuis la route** (cas simple) → `EntityValueResolver` (`{id}` ou `{slug:product}`), avec 404 automatique.

---

## 5. DTO, payloads et validation API

### Règles

- **Ne jamais** utiliser des données brutes sans validation.
- Représenter les entrées par des **objets dédiés (DTO)**.
- **Valider** les données **avant** d'appeler la logique métier.
- Placer les **contraintes proches de l'objet** (attributs `#[Assert\...]` sur le DTO).
- **Distinguer** : erreur de **validation** (422), d'**autorisation** (403), de **conflit** (409), de **ressource absente** (404).
- Retourner des réponses d'erreur **cohérentes** pour les clients API.
- **Éviter** les messages exposant l'implémentation interne.

### Familles de validation utiles

- **Présence** : `NotBlank`, `NotNull`.
- **Type** : `Type`.
- **Longueur** : `Length`.
- **Format** : `Email`, `Url`, `Uuid`, `Ulid`, `Regex`.
- **Choix** : `Choice`, `Country`, `Language`, `Locale`.
- **Nombre** : `Positive`, `PositiveOrZero`, `Range`, `GreaterThan`, `LessThan`.
- **Date** : `Date`, `DateTime`, `Time`.
- **Fichier / image** : `File`, `Image`.
- **Unicité métier** : `UniqueEntity`.
- **Conditionnelle** : `When`.
- **Objet imbriqué / collection** : `Valid`, `All`, `Collection`.
- **Personnalisée** : contrainte custom quand le standard ne suffit pas.

### Mapping + validation automatiques

- `#[MapRequestPayload] CreateUserDto $dto` : désérialise et valide le corps JSON, renvoie `422` en cas d'échec.
- `#[MapQueryString] SearchDto $dto` : mappe la query string.
- Déclarer la route en `format: 'json'` pour des erreurs JSON.
- Pour PATCH partiel : attention, seules les contraintes des champs soumis sont évaluées.

---

## 6. Sécurité backend

### Couvrir

- **Création et chargement** de l'utilisateur (`make:user`, user provider via Doctrine).
- **Hachage** sécurisé des mots de passe (hasher `auto`, `UserPasswordHasherInterface`).
- **Form login** quand l'application est session-based.
- **JSON login** pour les API (`json_login`, retour `401` si échec).
- **Authentification par jeton** pour les API **stateless** (access token / JWT).
- **Séparation** claire entre **authentification** (qui es-tu ?) et **autorisation** (as-tu le droit ?).
- **Rôles** (`ROLE_USER`, `ROLE_ADMIN`) pour les accès simples.
- **Voters** pour les règles fines liées à une ressource.
- **Limitation des tentatives** de connexion (`login_throttling`, rate limiter).
- **CSRF** quand des formulaires/sessions sont utilisés (inutile pour API stateless pure).
- **Limiter** les informations renvoyées lors des échecs (`error.messageKey`, jamais `error.message`).
- **Récupérer l'utilisateur** : `#[CurrentUser]` en contrôleur, service `Security` en service.
- **Déconnexion** et invalidation selon le mode d'authentification.
- **Ne jamais** stocker ou comparer un mot de passe en clair.

### Règle voters

Privilégier un **voter** dès que la règle **dépend de la ressource** (ex. un utilisateur ne peut modifier que ce qu'il **possède**). Ne pas encoder ce type de règle avec de simples rôles ou de longues expressions inline.

### Usages sécurité utiles

- **Utilisateur courant** → `#[CurrentUser]` / `Security::getUser()`.
- **Vérifier une permission** → `isGranted()` / `#[IsGranted(...)]`.
- **Refuser l'accès** → `denyAccessUnlessGranted()`.
- **Hacher un mot de passe** → `UserPasswordHasherInterface::hashPassword()`.
- **JSON login** → firewall `json_login`.
- **Jeton** → access token authenticator.
- **Déconnexion** → firewall `logout` / `Security::logout()`.
- **Throttling** → `login_throttling`.
- **Voter** → classe `Voter` + `#[IsGranted('PERMISSION', subject)]`.

---

## 7. Gestion des erreurs API

### Stratégie

- Erreurs de **validation** → réponse **structurée** (`422`).
- **Ressource absente** → `404` propre.
- **Conflit métier** → `409`, distinct des erreurs techniques.
- **Autorisation** → `403` explicite mais non bavard.
- Erreurs **internes** → ne pas exposer les détails serveur (`500` générique).
- **Exceptions métier** → converties en réponses API compréhensibles (listener `kernel.exception` ou `ExceptionListener`).
- **Logs** → conservent les détails de diagnostic **sans** les exposer au client.

### Structure d'erreur uniforme recommandée

```json
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "message": "La requête contient des champs invalides.",
  "errors": [
    { "field": "email", "message": "Cette valeur n'est pas une adresse email valide." }
  ]
}
```

- Un **statut** HTTP.
- Un **message** lisible.
- Un **code d'erreur** stable (utilisable côté client).
- Une **liste de champs invalides** quand pertinent.
- Une **trace** uniquement en environnement **dev**.

---

## 8. Architecture recommandée pour une API Symfony

Architecture de **responsabilité** (sans imposer une structure unique) :

- **Contrôleurs** : couche d'entrée HTTP (parse, délègue, répond).
- **Objets de requête (DTO)** : représentent les entrées.
- **Services d'application (use cases)** : exécutent les cas d'usage.
- **Services métier** : règles réutilisables.
- **Repositories** : lecture et recherche de données.
- **Entités** : cohérentes, protégées contre les états invalides.
- **Transformers / normalizers** : convertissent les objets métier en sortie API.
- **Tests** : autour des cas d'usage importants.

> Dans un projet existant : **suivre les conventions en place** plutôt que réorganiser sans raison.

Structure de répertoires Symfony standard (référence) :

```
src/
├─ Controller/
├─ Dto/            (ou Model/ Request/)
├─ Entity/
├─ Repository/
├─ Service/        (ou Application/ UseCase/)
├─ Security/       (Voter/, Authenticator/)
├─ EventSubscriber/
├─ Message/ MessageHandler/
└─ Command/
config/  migrations/  tests/
```

---

## 9. Sérialisation et réponses API

### Règles

- **Ne pas** exposer automatiquement toute l'entité si elle révèle trop de données.
- **Contrôler** les champs retournés (groupes de sérialisation, DTO de sortie).
- **Distinguer** modèles internes (entités) et modèles de réponse.
- Gérer **dates, identifiants, relations** de manière **stable** (formats constants).
- **Éviter** les boucles de sérialisation (références circulaires).
- Prévoir la **pagination** des listes.
- Prévoir des **filtres et tris explicites**.
- Retourner des **statuts HTTP cohérents**.

### Collections

- **Pagination** (page/limit ou cursor).
- **Métadonnées** utiles (total, page courante, taille).
- **Liens / informations de navigation** si nécessaire.
- **Réponse vide valide** (`200` + liste vide) plutôt qu'erreur quand aucun résultat.

Exemple de réponse de liste :

```json
{
  "data": [],
  "meta": { "page": 1, "perPage": 20, "total": 0 }
}
```

---

## 10. Formulaires Symfony en contexte backend

### Quand les utiliser

- **Back-office** rendu serveur.
- **Administration interne**.
- Gestion de **formulaires HTML**.
- Cas où **mapping objet + validation + CSRF** sont utiles ensemble.

### Quand ne pas les privilégier

- **API JSON** simple.
- **Endpoint stateless**.
- Cas où des **DTO + validation directe** sont plus lisibles.

### Actions utiles autour des formulaires

- **Créer** depuis un type dédié → `createForm(TaskType::class, $obj)`.
- **Gérer la requête** → `$form->handleRequest($request)`.
- **Soumis ?** → `$form->isSubmitted()`.
- **Valide ?** → `$form->isValid()`.
- **Données transformées** → `$form->getData()`.
- **Champs non mappés** → option `mapped: false` + `$form->get('x')->getData()`.
- **Plusieurs boutons** → `getClickedButton()` / `isClicked()`.
- **Ajuster la validation** → `validation_groups` (y compris `false`).

---

## 11. Console, commandes et tâches backend

### Cas d'usage

- Traitements **asynchrones ou planifiés** (avec Scheduler/cron).
- **Import / export**.
- **Maintenance**.
- **Recalculs**.
- **Synchronisations externes**.
- **Tâches administratives**.

### Bonnes pratiques

- **Entrées validées** (arguments/options typés).
- **Sorties claires** (`SymfonyStyle`).
- **Logs utiles**.
- **Gestion des erreurs** (codes de sortie `Command::SUCCESS`/`FAILURE`).
- **Idempotence** quand possible.
- **Pas de dépendance interactive** inutile pour les tâches automatisées.

Créer une commande via `make:command`, attribut `#[AsCommand]`.

---

## 12. Messenger, jobs et traitements asynchrones

Messenger découple la **requête utilisateur** du **traitement métier**.

### Cas d'usage

- Envoi d'**emails** après une action.
- **Traitements longs**.
- **Appels externes**.
- **Notifications**.
- **Recalculs**.
- **Webhooks**.

### Recommandations

- Messages **petits et explicites** (DTO immuables).
- **Handlers dédiés** (`#[AsMessageHandler]`).
- Stratégie de **retry**.
- **Gestion des échecs** (failure transport).
- **Traçabilité** des traitements (logs, middleware).
- **Ne jamais** bloquer une requête HTTP pour un travail long → dispatcher un message.

---

## 13. Cache, performance et HTTP

- Utiliser le **cache** pour les données coûteuses à recalculer (cache pool PSR-6/contracts).
- Garder les réponses **cacheables** quand possible (HTTP cache, ETag, Cache-Control).
- **Éviter** de démarrer une session inutilement (firewall `lazy`, rester stateless).
- **Surveiller** le nombre de requêtes base de données (profiler, N+1).
- **Précharger / optimiser** les relations nécessaires (fetch joins, `EAGER`/`LAZY` maîtrisé).
- **Paginer** les listes.
- **Éviter** les traitements lourds dans les contrôleurs (→ services/Messenger).
- Utiliser le **profiler** en dev pour comprendre les lenteurs.
- Utiliser les **logs** pour observer la production.

---

## 14. Tests Symfony backend

### Stratégie

- **Unitaires** : règles métier simples (PHPUnit pur).
- **Intégration** : services via le conteneur (`KernelTestCase`, `static::getContainer()`).
- **Fonctionnels** : endpoints API (`WebTestCase`, `createClient()`).
- **Sécurité** : accès autorisés **et** refusés.
- **Validation** : payloads invalides.
- **Repository** : quand les requêtes sont complexes.
- **Smoke** : les endpoints principaux répondent (data provider d'URLs).
- **Authentifié** : `$client->loginUser($user)` quand nécessaire.
- **Base dédiée** : `.env.test` / `.env.test.local`, jamais les données réelles.

### À tester

- Les **statuts HTTP**.
- La **structure JSON**.
- Les **messages d'erreur**.
- Les **permissions**.
- Les **cas limites**.
- Les **ressources absentes**.
- Les **conflits métier**.
- Les **scénarios nominaux**.

### Usages de test utiles

- **Client de test** → `static::createClient()`.
- **Appeler un endpoint** → `$client->request('GET', '/api/...')`.
- **Statut** → `assertResponseIsSuccessful()`, `assertResponseStatusCodeSame()`.
- **Redirection** → `assertResponseRedirects()`.
- **JSON** → décoder `$client->getResponse()->getContent()` et asserter.
- **Utilisateur connecté** → `$client->loginUser($testUser)`.
- **Formulaire** → `$client->submitForm()` (si pertinent).
- **Service via conteneur** → `static::getContainer()->get(...)`.
- **Mock d'une dépendance** → `$this->createMock(...)` + `$container->set(...)`.
- **Emails / notifications** → assertions Mailer/Notifier.

---

## 15. Méthodes et fonctionnalités Symfony les plus utiles (par contexte)

### Contrôleur

- Réponse JSON → `$this->json()`.
- Rediriger → `redirectToRoute()`.
- Générer une URL → `generateUrl()`.
- Ressource absente → `createNotFoundException()`.
- Refuser l'accès → `denyAccessUnlessGranted()` / `#[IsGranted]`.
- Message temporaire (sessions) → `addFlash()`.
- Servir un fichier → `$this->file()`.
- Requête courante → argument `Request`.
- Utilisateur courant → `#[CurrentUser]`.
- Mapper une requête → `#[MapRequestPayload]` / `#[MapQueryString]`.

### Requête et réponse

- Paramètres d'URL → arguments de route typés.
- Query → `$request->query->get()`.
- Corps → `$request->getPayload()->get()`.
- En-têtes → `$request->headers->get()`.
- Fichiers → `$request->files->get()` / `#[MapUploadedFile]`.
- Cookies → `$request->cookies->get()`.
- Content-Type réponse → `$response->headers->set('Content-Type', ...)`.
- Statut → constantes `Response::HTTP_*`.
- Téléchargement → `BinaryFileResponse` / `$this->file()`.
- Stream → `StreamedResponse` / `EventStreamResponse`.

### Services

- Injection auto → type-hint constructeur.
- Ambiguïté → `#[Autowire(service: ...)]` / alias nommé.
- Valeur de config → `#[Autowire('%param%')]`.
- Lister les services → `debug:container`, `debug:autowiring`.
- Vérifier le conteneur → `lint:container`.
- Décorer → `#[AsDecorator]`.
- Tags → auto-tag par interface + `!tagged_iterator`.

### Doctrine

- `find()`, `findOneBy()`, `findBy()`, `findAll()`.
- `createQueryBuilder()`.
- `persist()`, `flush()`, `remove()`.
- Transaction → `wrapInTransaction()`.
- Migration → `make:migration` + `doctrine:migrations:migrate`.
- Résolution auto depuis route → `EntityValueResolver`.

### Validation

- Valider un objet → `ValidatorInterface::validate()`.
- Obligatoire → `NotBlank` / `NotNull`.
- Type → `Type`.
- Longueur → `Length`.
- Format → `Email`, `Url`, `Uuid`, `Regex`.
- Choix → `Choice`.
- Conditionnelle → `When`.
- Collection → `All` / `Collection`.
- Objet imbriqué → `Valid`.
- Personnalisée → contrainte + validateur custom.
- Diagnostic → `debug:validator`.

### Sécurité

- Utilisateur courant → `#[CurrentUser]` / `Security::getUser()`.
- Permission → `isGranted()` / `#[IsGranted]`.
- Refuser → `denyAccessUnlessGranted()`.
- Hacher → `UserPasswordHasherInterface`.
- JSON login → firewall `json_login`.
- Jeton → access token authenticator.
- Déconnexion → firewall `logout`.
- Throttling → `login_throttling`.
- Permissions fines → `Voter`.

### Tests

- Client → `createClient()`.
- Appel → `$client->request()`.
- Statut → `assertResponseIsSuccessful()` / `assertResponseStatusCodeSame()`.
- Redirection → `assertResponseRedirects()`.
- JSON → décoder et asserter.
- Connecté → `loginUser()`.
- Formulaire → `submitForm()`.
- Service → `static::getContainer()->get()`.
- Mock → `createMock()` + `$container->set()`.
- Emails/notifications → assertions Mailer/Notifier.

---

## 16. Anti-patterns (interdits / à décourager)

- ❌ Mettre toute la logique métier dans les contrôleurs.
- ❌ Récupérer les services manuellement depuis le conteneur (`$container->get()`).
- ❌ Valider les données uniquement côté client.
- ❌ Retourner directement des entités complètes sans contrôle des champs.
- ❌ Mélanger logique HTTP, logique métier et accès base de données.
- ❌ Ignorer les statuts HTTP (tout en `200`).
- ❌ Retourner des erreurs incohérentes selon les endpoints.
- ❌ Oublier la pagination des listes.
- ❌ Écrire des requêtes complexes dans les contrôleurs.
- ❌ Modifier le schéma de base sans migration.
- ❌ Stocker des secrets dans le code (utiliser env vars / secrets).
- ❌ Afficher des détails d'exception en production.
- ❌ Utiliser des rôles pour des règles fines qui nécessitent un voter.
- ❌ Ne pas tester les erreurs et les permissions.
- ❌ Faire des traitements longs pendant une requête HTTP (utiliser Messenger).

---

## 17. Checklist qualité (avant validation)

- [ ] Le contrôleur est court et centré sur HTTP.
- [ ] Les données entrantes sont validées (DTO + contraintes).
- [ ] Les erreurs API sont cohérentes (structure uniforme).
- [ ] Les statuts HTTP sont corrects.
- [ ] La logique métier est dans des services.
- [ ] Les accès aux données passent par des repositories ou services dédiés.
- [ ] Les migrations sont prévues pour les changements de schéma.
- [ ] La sécurité est explicite (authentification + autorisation).
- [ ] Les permissions fines utilisent une logique dédiée (voters).
- [ ] Les secrets ne sont pas exposés.
- [ ] Les endpoints de liste sont paginés.
- [ ] Les performances de requêtes sont raisonnables (pas de N+1).
- [ ] Les cas d'erreur sont testés.
- [ ] Les accès refusés sont testés.
- [ ] Les endpoints critiques ont des tests fonctionnels.
- [ ] Le style suit les conventions existantes du projet.

