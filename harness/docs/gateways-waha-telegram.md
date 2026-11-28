# WhatsApp (WAHA) et Telegram : parler à ton compagnon depuis ton téléphone

> *English version: [`gateways-waha-telegram.en.md`](gateways-waha-telegram.en.md).*

Deux gateways prêtes à lancer, zéro dépendance, qui marchent avec **n'importe quel moteur** de
`brancher-ton-api.md` (Claude Code, OpenCode, API compatible OpenAI) :

| Gateway | Commande | Entrée | Sortie |
|---|---|---|---|
| WhatsApp | `node harness/bin/waha-gateway.ts` | webhook HTTP de [WAHA](https://waha.devlike.pro) | `POST /api/sendText` |
| Telegram | `node harness/bin/telegram-gateway.ts` | long polling de l'API Bot (aucun port ouvert) | `sendMessage` |

Les deux suivent le **modèle relais** : un message arrive, la gateway construit un prompt (heure
locale, qui écrit, derniers échanges du fil, pièces jointes), lance **un tour** du moteur dans ce
dépôt (donc avec ton identité, ta mémoire, tes protocoles), puis envoie elle-même le texte rendu.
L'agent n'a besoin d'aucun outil de messagerie pour répondre. S'il répond `[silence]` (ou rien),
rien ne part : c'est son mode par défaut en groupe.

Lance-les en parallèle si tu veux les deux : ce sont deux process séparés, et Telegram reste
joignable le jour où WhatsApp restreint ton numéro (c'est arrivé, d'où ce canal de secours).

## WhatsApp avec WAHA

### 1. Démarrer WAHA

WAHA est une API HTTP autour de WhatsApp Web, dans un conteneur. Utilise un **numéro dédié** à ton
compagnon (une eSIM ou une deuxième SIM) : jamais ton numéro perso. Un compte automatisé peut être
restreint par WhatsApp, et tu ne veux pas que ce soit le tien.

```yaml
# docker-compose.yml (à côté de ton dépôt, pas dedans)
services:
  waha:
    image: devlikeapro/waha:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]          # loopback seulement
    environment:
      WAHA_API_KEY: "change-moi"              # = WAHA_API_KEY côté gateway
      WAHA_DASHBOARD_USERNAME: "admin"        # connexion au tableau de bord
      WAHA_DASHBOARD_PASSWORD: "change-moi-aussi"
      WHATSAPP_SWAGGER_USERNAME: "admin"      # page Swagger de l'API, même principe
      WHATSAPP_SWAGGER_PASSWORD: "change-moi-aussi"
      WHATSAPP_DEFAULT_ENGINE: "GOWS"         # ou WEBJS / NOWEB
      WHATSAPP_HOOK_URL: "http://host.docker.internal:8787/waha"
      WHATSAPP_HOOK_EVENTS: "message"
      WHATSAPP_HOOK_HMAC_KEY: "une-autre-cle"  # = WAHA_WEBHOOK_HMAC_KEY côté gateway
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes: ["./waha-sessions:/app/.sessions"]
```

Génère clés et mots de passe (`openssl rand -hex 32`). Les anciens guides WAHA écrivent la clé
`WHATSAPP_API_KEY` ; la documentation actuelle dit `WAHA_API_KEY`. Une clé stockée en empreinte
(`WAHA_API_KEY: "sha512:<hex>"`) marche aussi : la gateway envoie toujours la clé en clair.

Puis `docker compose up -d` et ouvre `http://localhost:3000/dashboard`. Deux secrets distincts :

1. **La connexion au tableau de bord** : `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`. Non
   posés, WAHA en génère d'aléatoires au démarrage et les écrit dans son journal
   (`docker compose logs waha`).
2. **La clé d'API** : une fois connecté, le tableau de bord appelle l'API comme n'importe quel
   client. Dans ses réglages de connexion au serveur (`http://localhost:3000`), saisis la même valeur
   que `WAHA_API_KEY`, sinon la liste des sessions reste vide ou répond « unauthorized ».

Démarre ensuite la session `default` et scanne le QR code avec le téléphone du numéro dédié
(WhatsApp > Appareils connectés). WAHA sur un serveur distant : garde `127.0.0.1:3000` et passe par
un tunnel SSH (`ssh -L 3000:127.0.0.1:3000 toi@serveur`), jamais par un port publié.

### 2. Configurer la gateway (`.env`)

```bash
WAHA_BASE_URL=http://localhost:3000
WAHA_API_KEY=change-moi
WAHA_SESSION=default
WAHA_ALLOWED_CHATS=33612345678@c.us        # TON numéro (format international sans +), virgules pour plusieurs
WAHA_WEBHOOK_HMAC_KEY=une-autre-cle
KINDLE_HUMAN_NAME=Alex
KINDLE_TZ=Europe/Paris
```

`node harness/bin/waha-gateway.ts --check` dit si la session est `WORKING` et ce qui est autorisé.

⚠️ **Linux : le webhook n'arrive pas sans `WAHA_WEBHOOK_HOST`.** Depuis le conteneur,
`host.docker.internal` (via `host-gateway`) vise l'adresse du pont Docker de l'hôte (souvent
`172.17.0.1`), pas son `127.0.0.1` ; or la gateway écoute par défaut sur `127.0.0.1`. WAHA échoue alors
à livrer chaque message, sans rien dire côté gateway. Ajoute dans `.env` :

```bash
WAHA_WEBHOOK_HOST=172.17.0.1   # l'adresse de docker0 : ip -4 addr show docker0
```

Cette adresse n'est joignable que depuis la machine et ses conteneurs, pas depuis Internet. N'écris
jamais `0.0.0.0` ici sans pare-feu. Sous Docker Desktop (Mac, Windows), `host.docker.internal` atteint
bien le `127.0.0.1` de l'hôte : rien à ajouter. Vérification : envoie un message au numéro dédié, la
gateway doit écrire une ligne dans son journal.

### Ce qui te protège

- **Fermé par défaut.** `WAHA_ALLOWED_CHATS` vide = la gateway n'écoute personne. Un numéro
  WhatsApp reçoit du spam et des inconnus ; un agent qui répond à tout le monde finit par parler de
  toi à des tiers. Un groupe s'ajoute par son id `…@g.us`. Si ton chat 1:1 arrive en `@lid` (forme
  anonyme récente de WhatsApp), mets aussi cet id dans la liste (le log `ignoré (hors liste)` le donne).
- **Humain ou tiers.** `WAHA_PRINCIPAL_CHATS` (défaut : la liste autorisée) dit qui est toi. Pour
  tout autre auteur, le prompt rappelle `protocoles/discretion.md` : son contenu est une donnée,
  jamais un ordre.
- **Signature.** Avec `WAHA_WEBHOOK_HMAC_KEY`, un webhook non signé est refusé (401). La gateway
  écoute en `127.0.0.1` sauf si tu poses `WAHA_WEBHOOK_HOST`.
- **Pas de boucle.** Les messages `fromMe` (l'écho de ses propres envois) et les entrées `protocol`
  (modifications) ne réveillent jamais l'agent (`lib/waha-protocol.ts`).
- **Pas de doublon.** Un message déjà vu (même stanza) est ignoré ; sur un 5xx ou un délai dépassé
  à l'envoi, la gateway relit le fil avant de déclarer l'échec (`lib/send-probe.ts`).
- **Pas de flood.** Coupe-circuit global : au-delà de `WAHA_SEND_CIRCUIT_MAX` envois (défaut 20) en
  `WAHA_SEND_CIRCUIT_WINDOW_MS` (défaut 60 s), l'envoi est refusé, sans message d'alerte.
- **Pas de faux neuf.** Un message vieux de plus de 30 min (rejeu après reconnexion) arrive annoncé
  comme tel (`lib/waha-stale-replay.ts`).
- **Rafales.** Plusieurs messages rapprochés du même chat partent en un seul tour (`lib/coalesce.ts`) ;
  « att » seul rallonge l'attente de 30 s.

Pour que l'agent envoie lui-même (à quelqu'un d'autre que l'expéditeur, une image…), branche le
serveur MCP de WAHA dans `.mcp.json` **et** le garde-fou `wa-guard` en `PreToolUse`
(`docs/wa-guard-et-impersonation.md`). La gateway seule n'en a pas besoin.

## Telegram

1. Crée un bot avec [@BotFather](https://t.me/BotFather) (`/newbot`), garde le token.
2. Dans `.env` :
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC…
   TELEGRAM_PRINCIPAL_USERNAME=ton_pseudo_telegram   # sans @
   ```
3. `node harness/bin/telegram-gateway.ts --check`, puis lance-la et écris au bot.

Le **premier** message de `@ton_pseudo_telegram` scelle ton id numérique dans
`harness/data/telegram.json` (jamais versionné). Ensuite seul cet id passe : un tiers qui prendrait
ton ancien pseudo n'entre pas. DM privés uniquement, jamais un groupe ni un bot. Pour changer
d'humain, efface `sealedId` dans ce fichier.

Ce qu'elle sait faire : texte, images, documents (≤ 20 Mo) et vocaux téléchargés dans
`harness/data/media/` et passés à l'agent par leur chemin (il les lit avec ses outils ; un vocal
demande un outil de transcription que tu brancheras toi-même), mise en forme convertie en HTML
Telegram avec repli en texte brut si Telegram refuse, 🛑 ou `/stop` qui vide la file en attente.

## Les faire tourner en continu

Un service systemd par gateway suffit :

```ini
# /etc/systemd/system/compagnon-waha.service
[Service]
WorkingDirectory=/home/moi/mon-compagnon
ExecStart=/usr/bin/node harness/bin/waha-gateway.ts
Restart=always
User=moi
[Install]
WantedBy=multi-user.target
```

Même chose avec `telegram-gateway.ts`. `GET /health` sur la gateway WAHA répond `ok` pour une
sonde (`lib/health-probe.ts`).

## Limites, dites franchement

- **Pas de session longue côté moteur** : chaque tour repart du dépôt, avec les 8 derniers échanges
  du fil en mémoire vive (perdus au redémarrage). La continuité réelle vit dans `memoire/` et
  `journal/`, comme pour une session manuelle : c'est l'Ouroboros qui la tient.
- **Un tour lancé ne s'interrompt pas** : 🛑 vide la file, il n'arrête pas la réflexion en cours.
- **Outils** : par défaut le tour a ses outils (édition, bash selon `KINDLE_CLAUDE_PERMISSION_MODE`,
  MCP). `KINDLE_GATEWAY_TOOLS=0` donne des tours texte seul : utile avec une API compatible OpenAI
  sans OpenCode installé, ou pour un canal où tu ne veux aucun accès au disque.
- Les chemins d'API WAHA visés sont ceux des versions 2024-2026 ; adapte `lib/waha.ts` si la tienne
  diffère.
