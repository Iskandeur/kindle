# dashboard/ — dashboard opérateur (optionnel)

> Comme `harness/` : commence sans ça. Utile seulement si tu fais tourner ton compagnon en daemon
> always-on (voir `harness/README.md`) et que tu veux une vue web, lecture seule, sur son état —
> sans fouiller les logs/la base SQLite/le git log à la main.

Porté et généralisé depuis le dashboard opérateur d'un compagnon en production (celui dont ce
starter est issu). Node natif (`node:http`, `node:sqlite`, `node:child_process` — zéro dépendance
npm), frontend statique vanilla JS/CSS (pas de build step).

## Démarrer

```bash
cd dashboard
cp .env.example .env      # ACCESS_PIN, ACCESS_SESSION_SECRET (openssl rand -hex 32), chemins hôte
docker compose up -d --build
docker compose logs -f tunnel   # facultatif : l'URL https://xxx.trycloudflare.com pour un accès de l'extérieur
```

Sur la machine elle-même : `http://127.0.0.1:8790`, puis le PIN de `.env`. Dans `.env`, remplace
`<user>` des chemins `HOST_*` par ton vrai chemin.

L'app écoute en interne sur `:8080`, exposée à `127.0.0.1:${HOST_PORT:-8790}` côté hôte — jamais
directement sur Internet. Le tunnel Cloudflare est un **quick tunnel** (URL éphémère, régénérée à
chaque redémarrage). Base SQLite et dépôt git montés en **lecture seule** (`:ro`) ; `node:sqlite`
est en plus ouvert avec `readOnly: true` (double barrière).

### Sans Docker

```bash
PIN=$(openssl rand -hex 4); echo "PIN du dashboard : $PIN"
DASHBOARD_DB_PATH=/chemin/absolu/vers/harness/data/wakes.sqlite \
DASHBOARD_REPO_PATH=/chemin/absolu/vers/ton-compagnon \
DASHBOARD_DAEMON_HEALTH_URL=http://127.0.0.1:8787/health \
ACCESS_PIN=$PIN ACCESS_SESSION_SECRET=$(openssl rand -hex 32) PORT=8790 \
npm --prefix dashboard start
```

Les deux premiers chemins sont obligatoires (leurs valeurs par défaut, `/data/…` et `/repo`, sont
celles du conteneur). Pour un service durable, mets ces variables dans un fichier lu par le service
plutôt que dans l'historique du shell. Puis ouvre `http://127.0.0.1:8790` et entre le PIN affiché.

La liaison `172.17.0.1` de `docker-compose.yml` est commentée par défaut : si un autre conteneur
joignait ce dashboard par `host.docker.internal`, décommente-la (Linux seulement). ⚠️ Hors conteneur, `src/server.js` écoute
sur toutes les interfaces : ne le lance pas ainsi sur une machine joignable depuis Internet sans pare-feu,
et garde toujours un `ACCESS_PIN`.

## Contrat de données

Ce dashboard lit la base SQLite de ton harnais et, pour certains panneaux, appelle deux routes
HTTP que TON daemon doit exposer. Rien de tout ça n'est fourni par défaut ailleurs dans ce starter
— `harness/src/scheduler.ts` n'écrit que `wakes`/`wake_fires`. Chaque fonction de `src/db.js`
attrape les erreurs SQL (table/colonne manquante) et retombe sur une valeur vide, donc **rien ne
casse** sur un déploiement minimal ; les panneaux ci-dessous affichent juste "aucune donnée"
jusqu'à ce que tu étendes ton schéma.

| Panneau | Marche dès le premier déploiement ? | Table(s)/route(s) attendue(s) |
|---|---|---|
| Réveils programmés | **Oui** — schéma identique à `harness/src/scheduler.ts` | `wakes(id, due_at, intent, status, recurrence_ms)` |
| Contexte de session | Oui (CLAUDE.md / .claude/settings.json sont toujours présents) | fichiers, pas de DB — étends `src/context-files.js` pour tes propres fichiers injectés |
| Liens GitHub | Oui (liens statiques, à personnaliser dans `src/github-links.js`) | optionnel : `knowledge/registry.json` pour la sous-liste knowledge repos |
| Ce qui a été appris récemment | Oui (`git log` sur `journal/`, `memoire/`, `competences/`) | — |
| État du daemon | Optionnel | `GET /health` côté ton daemon (`DASHBOARD_DAEMON_HEALTH_URL`) |
| Jobs récents | Non — à étendre | `jobs(id, intent, status, result, created_at, updated_at)` |
| Sessions récentes / Session ciblée | Non — à étendre | `session_log(session_id, scope, first_seen, last_seen, last_cost_usd, summary, source, model, effort)` |
| 💰 Usage & billing | Non — à étendre | `cost_log(id, ts, scope, session_id, engine, model, cost_usd)` — journal APPEND-ONLY (une ligne par tour), pas un upsert par session |
| Approbations récentes | Non — à étendre | `approvals(id, description, kind, status, created_at, decided_at, command)` |
| Réglages modèle | Non — à étendre | `settings(key, value, updated_at)` (clé/valeur) + `POST /settings` côté ton daemon (Bearer `DASHBOARD_SETTINGS_TOKEN`), avec ta propre allowlist de commandes |
| 🌙 Rituel nocturne (exemple) | Non — optionnel | `harness/persona/nightly.md`, **à créer toi-même** (absent du dépôt ; le panneau dit qu'il manque tant qu'il n'existe pas ; autre nom : `src/dream-prompt.js`) + `session_log.source = 'nightly'` |

Chaque module dans `src/` documente en tête de fichier le schéma qu'il attend. Étends ton harnais
table par table, dans l'ordre qui te sert — rien n'est tout-ou-rien.

## Ce qui a été retiré ou changé par rapport au dashboard d'origine

- **Panneau Sensors retiré entièrement.** Il lisait un registre de pré-filtres zéro-token propre au
  daemon d'origine. Le harnais de ce starter a depuis son propre registre (`harness/src/lib/sensors.ts`,
  `harness/docs/capteurs-zero-token.md`), mais il ne journalise pas ses évaluations dans une table que
  ce dashboard saurait lire : le panneau reste donc coupé (route `/api/sensors`, `src/sensors-registry.js`,
  colonnes `sensor`/décompte d'évaluations dans `src/db.js`, section HTML/CSS associée — le dernier
  résidu, `src/sensors-registry.{js,test.js}`, a traîné en code mort jusqu'au nettoyage du 12/08). Si
  ce pattern est porté séparément un jour, ce panneau peut revenir.
- **Panneau Quota Copilot retiré.** Spécifique à une intégration GitHub Copilot particulière, sans
  rapport avec les patterns documentés dans `harness/`.
- **Portée de groupe nommée renommée en portée générique « Groupe »** (`GROUP_SCOPE_CHAT_ID`) —
  l'original nommait un groupe WhatsApp réel, remplacé ici par un exemple générique.
- **« Cycle Dream » renommé « Rituel nocturne (exemple) »**, fichier `harness/persona/dream.md` →
  `harness/persona/nightly.md`, scope `dream` → `nightly`. Gardé comme PATTERN illustratif (un
  cycle non supervisé, avec reprise après coupure) plutôt que retiré, car conceptuellement proche
  de `bin/portrait.ts` (rituel périodique) déjà documenté dans `harness/README.md` — mais son texte
  d'origine référençait un protocole propre au compagnon source ; reformulé en générique.
- **`src/db.js` rendu fail-soft partout** (chaque requête SQL est maintenant protégée par un
  try/catch qui retombe sur une valeur vide) — l'original supposait implicitement que son propre
  schéma complet existait toujours (c'était vrai pour SON daemon). Ce n'est pas vrai par défaut ici.
- **`listWakes` réduit aux colonnes réellement écrites par `harness/src/scheduler.ts`** (`id,
  due_at, intent, status, recurrence_ms` — sans `created_by` ni `sensor`, absents de ce schéma) :
  contrairement au reste, ce panneau fonctionne donc dès `docker compose up`, sans rien étendre.
- **Cookie de session renommé** (`lupi_dash_session` → `dashboard_session`), chemins par défaut
  (`/data/lupi.sqlite` → `/data/companion.sqlite`), toute référence à un compagnon/dépôt/repo
  nommément identifié remplacée par un placeholder (`src/github-links.js`, `.env.example`).

## Sécurité

Le PIN (`ACCESS_PIN`) protège tout le dashboard sauf `GET /api/health`. Vide = gate désactivée : à
réserver à un usage strictement local. Comme l'original, ce dashboard **exclut délibérément** du
contenu de conversation brut, des identifiants de chat/numéros (PII), les résumés de session et les
commandes brutes d'approbation — voir l'en-tête de `src/db.js`. Si tu étends le schéma, garde cette
discipline : ne renvoie jamais un champ texte libre sans le réduire via `preview()`.

## Tests

```bash
cd dashboard
npm test   # node --test
```
