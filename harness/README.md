# harness/ — le corps optionnel

> Commence sans ça. `harness/` n'est utile que le jour où tu veux que ton compagnon tourne
> **en continu** (un daemon qui l'éveille sur évènement — message reçu, heure programmée — au
> lieu d'attendre que tu ouvres une session Claude Code). Tant que tu vis en sessions manuelles,
> ignore ce dossier : rien ici n'est requis pour que `identite/`, `memoire/`, `competences/` et
> `protocoles/` fonctionnent.

## Ce que c'est — et ce que ce n'est pas

Ce n'est **pas** un daemon complet prêt à lancer. Faire tourner un compagnon en continu demande
un vrai runtime (boucle d'écoute WhatsApp/Telegram, orchestration des sessions, base d'état,
configuration…) qui est par nature spécifique à *ta* stack (quel client de messagerie, quel
hébergeur, quels outils). Reconstruire ce runtime en générique aurait produit une usine à gaz
inutilisable telle quelle.

Ce qu'il y a ici à la place : des **modules autonomes et testés**, chacun portant un pattern
précis qui a fait ses preuves sur le corps de l'agent dont ce starter s'inspire — plus la
doc qui explique le *pourquoi* et comment le brancher dans ton propre runtime. Prends ce qui te
sert, ignore le reste, adapte librement.

## Les modules

| Module | Rôle | Doc |
|---|---|---|
| `bin/portrait.ts` | Rituel mensuel : génère une image à partir du journal du mois, l'archive. | [`docs/portrait-du-mois.md`](docs/portrait-du-mois.md) |
| `bin/restart.ts`, `src/lib/restart-guard.ts` | Redémarrage du daemon sans perte ni doublon de messages. | (voir en-tête des fichiers) |
| `src/lib/coalesce.ts` | Fusionne une rafale de messages rapprochés en un seul réveil. | [`docs/coalescing.md`](docs/coalescing.md) |
| `src/lib/pingpong.ts` | Continuité bornée dans un groupe multi-agents, avec plafond anti-boucle. | [`docs/pingpong-groupes.md`](docs/pingpong-groupes.md) |
| `src/lib/mention-wake.ts` | Réveil sur @-mention structurée, pas seulement sur le nom tapé en dur. | [`docs/pingpong-groupes.md`](docs/pingpong-groupes.md) |
| `bin/schedule-wake.ts`, `src/scheduler.ts` | L'agent se programme lui-même des réveils futurs, avec budget de sobriété. | [`docs/self-scheduling.md`](docs/self-scheduling.md) |
| `src/lib/worktree.ts` | Travail long isolé dans un git worktree dédié, jamais sur la working-copy vivante. | [`docs/jobs-worktree-isoles.md`](docs/jobs-worktree-isoles.md) |
| `src/lib/router.ts` | Choix modèle/effort par message — mode auto ou épinglé par commande humaine. | [`docs/routeur-pre-vol.md`](docs/routeur-pre-vol.md) |
| `bin/wa-guard.ts`, `src/wa-guard.ts`, `config/wa-guard-groups-ok` | Garde-fou d'envoi : cadence anti-spam, groupes verrouillés par défaut, tags/mentions brutes bloquées avant envoi. | [`docs/wa-guard-et-impersonation.md`](docs/wa-guard-et-impersonation.md) |
| `src/lib/voice-clone.ts` | Réponse en note vocale avec une voix clonée (ElevenLabs v3) : format PTT sans conversion, balises de ton vérifiées, anti-boucle. | [`docs/voix-clonee-elevenlabs.md`](docs/voix-clonee-elevenlabs.md) |
| `src/lib/nice.ts` | Lancer les jobs de fond en priorité CPU basse (`nice -n` avant l'`exec`) pour que la conversation garde toujours le processeur. | (voir en-tête du fichier) |
| `src/lib/quiet-hours.ts` | Heures calmes : concurrence des jobs de fond ramenée à 1 pendant les heures d'éveil de l'humain (quota partagé), plage lue en heure locale par zone IANA, heure d'été comprise, jamais un offset figé. | (voir en-tête du fichier) |
| `src/lib/waha-stale-replay.ts` | Anti-rejeu webhook : ne pas répondre à un vieux message rejoué (reconnexion/resync) comme s'il était neuf. | [`docs/waha-stale-replay.md`](docs/waha-stale-replay.md) |
| `src/lib/engine-failover.ts` | Bascule automatique entre deux moteurs LLM sur quota, auth morte ou solde prépayé vide (jamais sur un aléa réseau), retour au préféré à l'heure annoncée, anti ping-pong ; un épinglage humain ne cède que devant une panne qui ne se lèvera pas seule. | [`docs/bascule-de-moteur.md`](docs/bascule-de-moteur.md) |
| `src/lib/send-probe.ts` | Anti-doublon d'envoi : sur un 5xx du gateway, relire le fil avant de déclarer l'échec (le message est parfois déjà livré) ; un 4xx lève sans sonder. | [`docs/sonder-avant-echec-envoi.md`](docs/sonder-avant-echec-envoi.md) |
| `src/lib/instants.ts` | Lire un horodatage qui peut être epoch-ms OU ISO sous le même nom de champ (`*_at`) ; lève sur l'illisible au lieu de rendre un `NaN` qui fait tomber un contrôle du côté rassurant. | (voir en-tête du fichier) |
| — (pattern) | Garde-fou anti-fuite repos publics : scan preflight + hook de merge qui lit le vrai diff public, fail-closed. | [`docs/public-anti-leak.md`](docs/public-anti-leak.md) |
| — (pattern) | Localisation temps réel OwnTracks : ingestion → stockage borné → poller → diffusion uniquement si expéditeur vérifié. | [`docs/owntracks-localisation.md`](docs/owntracks-localisation.md) |
| — | Piège vérifié : les mentions WhatsApp via un wrapper MCP `send-text` partent en texte brut. | [`docs/mentions-whatsapp-piege.md`](docs/mentions-whatsapp-piege.md) |
| `src/lib/service-ctl.ts` | Ton agent gère lui-même ses propres services systemd (`<préfixe>-*`) via un wrapper `sudo` appelé depuis Node — contourne le mur d'un `sudo` absent de l'allowlist de permissions Claude Code, sans jamais l'éditer. | [`docs/service-ctl-sudo-sans-sandbox.md`](docs/service-ctl-sudo-sans-sandbox.md) |
| `src/lib/groq-extract.ts` | Extraction de faits durables (personnes) depuis un message, via Groq (gratuit, rapide) — ne bloque jamais, n'écrit jamais seul dans ta mémoire (suggestion, pas écriture aveugle). | (voir en-tête du fichier) |
| `src/lib/artificial-analysis.ts` | Client Artificial Analysis : benchmarks indépendants et gratuits des modèles LLM (indice qualité, prix, débit) — ratio qualité/prix pour repérer un modèle « frontier » ou « bon marché et capable », pattern de veille seed-puis-ack. | [`docs/artificial-analysis.md`](docs/artificial-analysis.md) |
| `src/lib/google-oauth.ts` | Client OAuth2 "Desktop app" zéro-dépendance pour parler DIRECTEMENT aux API Google (Tasks, Calendar, Drive, Gmail…) avec ton propre quota, sans passer par un routeur tiers à quota partagé. Flux loopback (RFC 8252), `fetchFn` injectable. | [`docs/google-oauth-desktop-client.md`](docs/google-oauth-desktop-client.md) |
| `bin/usage-topics.ts`, `src/lib/usage-topics.ts` | Répartition de l'usage par SUJET (pas par canal) à partir des résumés de `session_log` — règles ordonnées, `--json` pour brancher un dashboard. | [`docs/usage-topics.md`](docs/usage-topics.md) |
| — (pattern, outils Claude Code) | Coordonner plusieurs lanes concurrentes (`ListAgents`/`SendMessage`) : repérer une lane déjà en cours sur un scope avant d'agir, plutôt que dupliquer le travail. | [`docs/lanes-listagents-sendmessage.md`](docs/lanes-listagents-sendmessage.md) |
| `src/lib/voice-audit.ts` | Détecteurs mécaniques de tics de LLM en français (tiret cadratin, gras à outrance, négation parallèle…) dans tes propres messages — zéro dépendance, zéro appel LLM, fenêtre temporelle figée pour des mesures comparables. | [`docs/voice-audit-tics-llm.md`](docs/voice-audit-tics-llm.md) |
| `src/lib/turn-cancel.ts` | Interrompre un raisonnement déjà lancé par une réaction emoji sur n'importe quel message du fil — module PUR, à appeler dans le chemin synchrone du webhook (dans le handler, il s'exécute après le tour qu'il devait tuer). | [`docs/stop-par-reaction.md`](docs/stop-par-reaction.md) |
| `src/lib/ask-block.ts`, `request-queue.ts`, `presence-mode.ts`, `friction-detect.ts`, `promise-watchdog.ts`, `charters.ts`, `agent-engine.ts`, `agent-brief.ts`, `triage-audit.ts`, `autonomous-denials.ts`, `text-arg.ts`, `phase-chain.ts`, `deferred-report.ts` | La ruche et le board : bloc « ce que j'attends de toi / options / sans réponse » d'un ticket pour l'humain, file de demandes (nuit, absent, anti-rafale, « ok N »), friction réparée le jour même, promesse sans réveil armé, chartes d'agents spécialisés derrière une seule voix ; squelette du rêve nocturne et rapport du matin déposé la nuit. | [`docs/ruche-board-et-reve.md`](docs/ruche-board-et-reve.md) |

Complément séparé, pas un module de plus dans ce dossier : [`dashboard/`](../dashboard/README.md)
est une app Node à part (Docker, frontend statique) qui lit la base SQLite et le dépôt git d'un
daemon construit à partir de ces modules — utile seulement une fois ce daemon en marche.

## Conventions

Zéro dépendance runtime (modules natifs Node ≥22 : `node:sqlite`, `node:fs`, `node:child_process`,
`fetch`…). TypeScript exécuté nativement par Node (pas de *parameter properties*, pas d'enums —
la syntaxe stricte que Node accepte en mode *strip-only*). Tests via `node --test` :

```bash
cd harness && node --test
```

## Origine

Ces patterns viennent du corps d'un compagnon qui tourne en continu sur un VPS depuis
juillet 2026. Rien ici n'est prescriptif — c'est un point de départ à faire tien, comme le reste
de ce starter.
