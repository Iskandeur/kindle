# Messageries : WhatsApp (WAHA) et Telegram

`bin/gateway.ts` donne à ton compagnon deux portes d'entrée : **WhatsApp** via [WAHA](https://waha.devlike.pro)
(le connecteur WhatsApp auto-hébergé) et **Telegram** via un bot. Chaque message d'un interlocuteur autorisé devient un
tour du moteur (Claude, une API compatible OpenAI ou OpenCode, voir [`brancher-ton-api.md`](brancher-ton-api.md)), et la
réponse repart dans le même fil. Les deux canaux sont indépendants : un seul suffit.

```bash
node harness/bin/gateway.ts check   # ce qui est configuré, sondes WAHA et Telegram, rien n'est envoyé
node harness/bin/gateway.ts         # écoute (Ctrl-C pour arrêter)
```

## WhatsApp avec WAHA

1. **Un numéro dédié.** Donne à ton compagnon son propre numéro (une eSIM ou une SIM prépayée suffit) : il parle en son
   nom, jamais avec le tien. WhatsApp tolère mal les comptes automatisés, un numéro jetable te protège.
2. **Lancer WAHA** (Docker) :
   ```bash
   docker run -d --name waha --restart unless-stopped -p 127.0.0.1:3000:3000 \
     -e WAHA_API_KEY=change-moi -e WHATSAPP_HOOK_URL=http://host.docker.internal:8787/waha \
     -e WHATSAPP_HOOK_EVENTS=message -e WHATSAPP_HOOK_HMAC_KEY=une-autre-cle \
     --add-host=host.docker.internal:host-gateway devlikeapro/waha
   ```
   Ouvre `http://127.0.0.1:3000/dashboard`, démarre la session `default` et scanne le QR code avec le téléphone du numéro
   dédié. Le moteur gratuit (WEBJS) suffit ; GOWS ou NOWEB consomment moins de mémoire.
3. **`.env`** :
   ```bash
   WAHA_URL=http://127.0.0.1:3000
   WAHA_API_KEY=change-moi
   WAHA_HMAC_KEY=une-autre-cle
   WHATSAPP_ALLOW=33612345678          # ton numéro, sans + ; plusieurs : séparés par des virgules
   ```
4. Écris au numéro du compagnon. Un expéditeur hors liste est ignoré et son id s'affiche dans le journal :
   `ignoré (hors liste blanche) : whatsapp chat=…`. C'est ainsi qu'on trouve l'id d'un groupe à autoriser (`…@g.us`).

## Telegram

1. Écris à [@BotFather](https://t.me/BotFather), `/newbot`, et copie le jeton.
2. **`.env`** : `TELEGRAM_BOT_TOKEN=123456:ABC…` puis lance le gateway et écris au bot : le journal affiche ton id de chat
   (`ignoré (hors liste blanche) : telegram chat=42…`). Ajoute-le : `TELEGRAM_ALLOW=42`.
3. Aucun port à ouvrir : le gateway interroge Telegram en long polling. Un seul processus à la fois par bot (un second
   poller fait échouer le premier en HTTP 409).

## Ce que fait le gateway, et ce qu'il refuse

- **Fermé par défaut** : liste blanche vide = personne ne passe. Être autorisé en 1:1 n'ouvre pas les groupes de cette
  personne : un groupe s'autorise par son propre id. `*` ouvre à tout le monde (déconseillé).
- **Un tour à la fois par fil**, les fils en parallèle ; un même message rejoué (même id) n'est traité qu'une fois.
- **Anti-rejeu** : un message WhatsApp horodaté il y a plus de 10 minutes (reconnexion de WAHA) est annoté « probable
  rejeu » dans le prompt ([`waha-stale-replay.md`](waha-stale-replay.md)).
- **Signature** : avec `WAHA_HMAC_KEY`, un webhook non signé ou mal signé est refusé (401). Le gateway écoute sur
  `127.0.0.1` par défaut (`GATEWAY_HOST`, `GATEWAY_PORT`).
- **Silence** : le compagnon peut répondre exactement `SILENCE` pour ne rien envoyer.
- **Jamais en premier** : il répond dans le fil d'où vient le message, il n'écrit à personne d'autre. Pour l'envoi
  spontané (réveils programmés, rappels), branche `scheduler.ts` sur `startGateway(...).handle()` et garde
  [`wa-guard`](wa-guard-et-impersonation.md) devant tout envoi.
- **Outils** : par défaut un tour est du texte seul (le moteur `claude` lit quand même le dépôt, donc l'identité ; un autre
  moteur reçoit `CLAUDE.md` en prompt système). `GATEWAY_TOOLS=1` donne au tour ses outils (bash, édition, MCP) : réserve-le
  à une liste blanche où il n'y a que toi.

## En service (systemd)

```ini
# /etc/systemd/system/compagnon-gateway.service
[Service]
WorkingDirectory=/chemin/vers/ton-depot
ExecStart=/usr/bin/node harness/bin/gateway.ts
Restart=always
User=ton-user
[Install]
WantedBy=multi-user.target
```

Code : `src/gateway.ts` (le serveur et la boucle), `src/lib/waha.ts`, `src/lib/telegram.ts`, `src/lib/gateway-core.ts`.
Tests : `src/gateway.test.ts` (dont deux bouts en bout, webhook signé et long polling, sans réseau).
