# Capteurs zéro token et hygiène des réveils

Un compagnon qui se réveille tout seul (réveils programmés, récurrents, alertes) coûte une **session LLM
à chaque réveil**. Cette famille de modules a un seul but : ne payer une session que quand elle sert, et
empêcher les automatismes de se dégrader en silence. Tout est pur ou à I/O injectée (`fetchFn`, `now`,
un magasin clé/valeur de réglages), zéro dépendance.

| Module | Rôle |
|---|---|
| `lib/sensors.ts` | contrat de capteur, registre, porte du scheduler, 2 capteurs d'exemple |
| `lib/prudence.ts` | plafond journalier des réveils « fail-open » |
| `lib/wake-meter.ts` | compteur de réveils : alerte une fois par jour, ne bloque jamais |
| `lib/wake-doublons.ts` | repère deux réveils ponctuels qui disent la même chose |
| `lib/wake-staleness.ts` | bandeau d'âge sur un ponctuel qui a dormi longtemps |
| `lib/dead-event-alert.ts` | nomme la lane morte, une clé d'alerte par lane |
| `lib/cold-peer-alert.ts` | ne pas jeter en silence la réponse à un fil que l'agent a ouvert |
| `lib/periodic-runner.ts` | la boucle d'entretien périodique, écrite une fois |
| `lib/veilleurs.ts` | une attente qui se lève seule en sondant l'état du monde |

## 1. Capteurs : le portier avant la session

**Capteur** = comparaison mécanique (ids, statuts, hachages) qui répond à « du neuf ? ». Gratuit.
**Veille** = jugement sémantique (« cette réponse est-elle une vraie question ? ») : une session, des
tokens. Le capteur est le portier ; la veille n'ouvre l'œil que si le portier a vu du neuf.

```ts
const registry = createSensorRegistry();
registry.register("blog", feedSensor({ url, key: "blog", fetchFn: fetch, store }));
registry.register("proj", githubReleaseSensor({ repo: "owner/repo", fetchFn: fetch, store }));
```

Un capteur est `() => Promise<{ changed: boolean; note?: string }>`. Les deux exemples suivent le motif
**amorçage puis différence** : le premier passage mémorise l'état courant *sans* réveiller (sinon le
premier tick déverse tout l'historique), les suivants ne signalent que le neuf. Pièges évités :

- clé de différence = **identifiant** de l'item (`guid`, `id`, tag de release), jamais sa date : une date
  peut manquer, changer de fuseau ou être réécrite ;
- une panne (HTTP en échec, flux vide, réponse sans `tag_name`) **lève** : « le portier est en panne » ≠
  « rien de neuf », et elle n'efface pas l'état mémorisé ;
- un dépôt sans release (404) n'est pas une panne ; la première release qui apparaît ensuite est signalée ;
- le jeton éventuel part en en-tête, jamais dans l'URL ni dans la note.

### Brancher la porte sur le scheduler

Le scheduler n'a pas de colonne « capteur ». Un réveil récurrent désigne son capteur par un préfixe
d'intent : `@sensor:blog regarde le nouveau billet` (`parseSensorTag`). `prefetchSensorGate` évalue
(asynchrone, une fois par nom de capteur et par tick) les capteurs des réveils dus et rend un `WakeGate`
synchrone que `processDueWakes` consulte **avant le budget** :

```ts
startScheduler(store, onEvent, 60_000, (due) => prefetchSensorGate(due, { registry, prudence }));
```

- capteur muet + réveil **récurrent** → réarmé sans session et **sans consommer de budget** ;
- capteur bavard → le réveil tire, avec l'intent débarrassé de la balise et la `note` ajoutée
  (« Ce qui a bougé : … ») pour que la session ne redécouvre pas à l'aveugle ;
- un réveil **unique** ignore un verdict muet : il n'a qu'un tir, le fermer en silence le perdrait ;
- capteur évalué **une seule fois par tick** même partagé par deux réveils : sinon le second verrait l'état
  déjà avancé par le premier et perdrait le changement ;
- si `prefetchGate` lève, le tick réveille sans porte (fail-open) plutôt que de ne rien faire.

### Fail-open, mais plafonné : `prudence`

Capteur inconnu (retiré du registre sans retirer son réveil) ou en échec → réveil **par prudence**,
préférable à un silence sur une alerte de sûreté. Mais chaque prudence est une session : sans plafond, un
capteur fantôme à cadence rapide coûte une session par tick, pour toujours, et seule la facture le dit.
`createPrudenceGate(store, { cap, alert })` compte ces seules branches (jamais un réveil légitime), alerte
**une fois par jour** au premier refus, puis dégrade en journalisation jusqu'au lendemain UTC. Le compteur
continue de monter pour que l'ampleur de la fuite évitée se lise.

### Un compteur, pas un plafond : `wake-meter`

Un « budget de N réveils par jour » cité dans la config mais que rien ne compte ne garde rien (mesuré :
dépassé chaque matin). `createWakeMeter(store, { threshold, alert }).record(origine)` à chaque réveil
émis : **une** alerte le jour où le total franchit le seuil, avec la ventilation par origine (le coupable
est nommé). Il ne bloque jamais : plafonner les réveils légitimes rendrait muettes les alertes de sûreté
derrière un capteur bavard. L'unicité de l'alerte vient de l'arithmétique (une seule valeur du total vaut
`seuil + 1` dans la journée), donc elle survit à un redémarrage sans drapeau. Le seuil est à calibrer
sur ton maximum quotidien observé.

## 2. Hygiène des réveils ponctuels

- **`wake-doublons`** — deux sessions répondent à la même phrase de l'humain, chacune pose son porteur
  dans la minute (la bonne discipline), aucune ne voit celui de l'autre : deux messages sur le même sujet.
  `trouverDoublons` compare les mots **rares** (présents dans ≤ 3 intents du corpus du jour) des ponctuels
  qui tombent le même jour ; ≥ 6 mots rares communs = paire suspecte. Il **trouve, ne tranche pas et ne
  supprime rien**. L'échappatoire vit dans l'intent (`CROISEMENT VÉRIFIÉ #<id>`), pas dans un drapeau, et
  le motif tolère la flexion. Piège : le texte ajouté en croisant deux intents devient lui-même du
  vocabulaire rare commun, donc sans échappatoire corriger une paire la rendrait plus suspecte. Le seuil
  vient d'une mesure sur un corpus donné : à re-mesurer sur le tien. Fuseau (`timeZone`) = celui de ton
  humain, pour décider du « même jour ».
- **`wake-staleness`** — un ponctuel dort, puis parle avec la même autorité qu'une consigne d'il y a cinq
  minutes. `withStalenessBanner(wake, now, texte)` préfixe un bandeau (âge de la **pose**, vérifications
  qui tranchent la prémisse) quand il a dormi ≥ 72 h ; récurrents exclus, date future ou corrompue = pas
  de faux bandeau. À appliquer au moment du tir, dans `onEvent`. Il ne juge pas la prémisse (aucun code
  ne le peut) : il rend visible ce que la base sait et que l'intent tait.

## 3. Alertes

- **`dead-event-alert`** — quand une lane de fond meurt, `deadEventOrigin(lane)` rend un libellé (« la veille
  du canal « x » a échoué ») et une **clé d'épisode par lane** pour ton alerte à escalade. Piège : un
  épisode global refermé par tout tour réussi est remis à zéro par la conversation de l'humain qui
  s'intercale, et l'escalade 1 h → 2 h → 4 h n'a jamais lieu (spam d'alertes identiques). Clés nominatives
  pour les canaux (ensemble petit), par *kind* pour tâches et jobs (ids sans fin = réglages qui grossissent).
  Exception : une authentification morte tue toutes les lanes, l'appelant force la clé globale.
- **`cold-peer-alert`** — un garde « principal seulement » jette les messages de tiers en 1:1. Juste, mais
  son refus **muet** laisse l'humain croire qu'un fil que l'agent a lui-même ouvert est vivant.
  `decideColdPeerAlert` (pur, I/O injectées) prévient une fois par chat et par 24 h si l'agent a écrit dans
  ce chat dans les 30 derniers jours ; lecture de l'historique en échec = on alerte quand même ; un inconnu
  à froid reste silencieux. Le créneau de dédoublonnage se réclame **en dernier** (un inconnu à froid n'en
  consomme pas). Le message reste jeté : pas de réveil, discrétion entière.

## 4. `periodic-runner` : la boucle d'entretien, une seule fois

Les entretiens (nettoyage disque, sauvegardes, synchronisations) réécrivent tous le même quatuor ; une
leçon apprise dans l'un doit être reportée à la main dans les autres. `periodicTick(spec)` fixe l'ordre,
non configurable :

`échéance → travail (try) → évaluation → ÉTAT → ALERTE → best-effort`

- **état avant alerte** : tout ce qui échoue sans faire avancer le curseur se répète à l'identique pour
  toujours ; le `try` autour de `run` transforme une exception en résultat compté comme un échec ;
- **alerte avant I/O accessoire** : une commande lente (miroir, indexation) ne doit pas retarder ni
  emporter le seul message qui comptait ; le best-effort a son propre `try` ;
- **verrou en vol** par nom : le poll est un `setInterval` qui n'attend pas le tick précédent ;
- `stampBeforeRun` (un daemon qui meurt au milieu ne rejoue pas en boucle serrée), `precheck` (disque
  plein : l'échéance est consommée, aucun échec compté), `blockingKind` (ce runner cède aux jobs qui le
  menacent — **le champ qui s'oublie en silence à la migration** : aucun test existant ne tombe).

`startPeriodic` pose `setInterval` + `unref` + premier `setTimeout` + `.catch` ; il accepte aussi un `tick`
nu pour les boucles à curseur.

## 5. `veilleurs` : une attente qui se lève seule

« Préviens-moi quand ce déploiement répond / quand cette PR est fusionnée. » Sans porteur, soit une session
ré-interroge un monde immobile à chaque tour, soit personne ne lève l'attente. Un veilleur = une sonde
déterministe (`url`, `commande`, `pr`, `custom`) + une cible + une limite (une semaine par défaut). `tour`
les évalue sans LLM ; vu → `levee.vu(veilleur, preuve)`, limite passée → `levee.pasVu(...)`. **`Levee` est à
toi** : commenter un ticket, réveiller l'agent, envoyer un message.

Pièges évités : une lecture qui échoue n'est pas un « pas vu » (réseau coupé ≠ déploiement absent) ; après
la limite on ne sonde plus ; une levée qui échoue ne range pas le veilleur (retenté) ; les commandes sont
un **préfixe exact d'argv sur liste blanche, sans shell, sans option après le verbe** (`git ls-remote
--upload-pack=…` exécute du code), revalidées à l'évaluation ; le registre est réécrit en relisant le
fichier (`fusionnerRegistre`) pour ne pas écraser un veilleur ajouté pendant un tour long ; écriture
atomique ; le même veilleur demandé deux fois n'est pas dupliqué.

## Ce qui n'est pas porté

Les capteurs concrets d'un déploiement particulier (tâches, mails, tarifs, santé, surveillance
d'infrastructure) restent privés : ils dépendent de ses comptes et de ses services. Les deux exemples
ci-dessus (flux, release) montrent le patron ; copie-en la structure pour les tiens.
