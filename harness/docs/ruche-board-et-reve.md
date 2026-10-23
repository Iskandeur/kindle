# La ruche, le tableau de tickets et le rêve nocturne

> Trois familles de modules qui servent le même but : qu'un système d'agents travaille **beaucoup** sans
> user l'attention de ton humain. Tous sont purs (I/O injectée), testés, et indépendants : prends ce qui te
> sert. Le tableau de tickets lui-même vient du plugin Alvearium (déjà branché dans ce dépôt) ; ces modules
> décrivent comment les agents l'utilisent bien.

## Le principe qui tient tout : l'attention de l'humain est la ressource rare

Un humain qui supervise plusieurs agents paie quatre coûts : surveiller (qui a besoin de moi ?), changer de
contexte (de quoi s'agit-il ?), trancher, puis exprimer sa consigne. Ajouter des agents fait monter le
premier coût même si chacun est autonome. Chaque module ci-dessous baisse l'un des quatre : un ticket qui
se suffit (contexte), une file qui groupe et respecte les absences (surveillance), un filet qui répare sans
attendre (consigne), un rapport qui arrive à l'heure choisie (surveillance).

## 1. Le ticket qui se suffit : `ask-block.ts`

Tout ticket assigné à l'humain commence par trois lignes :

```
Ce que j'attends de toi : choisir où héberger la sauvegarde.
Options : A) hébergeur X — 3 €/mois ; B) hébergeur Y — 1 €/mois, hors site (défaut : B)
Sans réponse : je pars sur B le 15, réversible.
```

- La ligne `Options` est absente pour une simple action ou un oui/non.
- `writeAskBlock` est strict (une forme canonique) ; `readAskBlock` est tolérant (gras markdown, puce,
  casse, `:` espacé à la française, version anglaise `Ask: / If no answer:`).
- `askBlockComplete` : une question, un « sans réponse », et au moins deux options s'il y a la ligne. Un agent
  de tri peut renvoyer (une fois) le ticket incomplet à son auteur avant qu'il n'atteigne la file de l'humain.
  Une urgence P0 passe toujours.
- `askBlockRule()` rend la règle d'écriture à coller dans la consigne de tes agents (une seule source) ;
  `askBlockFromArgs` lit `--attends / --options / --defaut / --sans-reponse` pour tes CLI.
- Piège : une phrase qui commence par « Options » n'est pas la ligne Options (elle doit être suivie de `A)`).
- Pourquoi « sans réponse » : c'est lui qui rend la décision par défaut possible. Une question nue force
  l'humain à répondre ; une question avec défaut + délai se tranche toute seule s'il ne dit rien.

## 2. Se taire quand il n'est pas là : `presence-mode.ts` et `request-queue.ts`

### `presence-mode.ts`

Un état partagé, posé quand l'humain le DIT : `normal`, `absent` ou `deborde`, avec une date de retour
(`until`) et un fuseau. Passé `until`, le mode redevient `normal` sans qu'aucun organe n'ait à réécrire
l'état. Une table unique, `whatMayBeSent(kind, état, instant)` : `urgent`, `summary` (le seul résumé du jour)
et `conversation` (réponse à son message) partent toujours ; `appointment`, `promotion`, `deadline`, `quick`
sont gelés.

Pièges évités :
- le fuseau est la moitié du problème : toujours un nom IANA résolu par `Intl`, jamais un offset figé
  (l'heure d'été change deux fois par an) ni l'heure UTC nue ;
- `clockRestartsAt` : le jour du retour, ne relance pas tout ce qui a « dormi 48 h » pendant l'absence ;
- une date impossible (`2026-13-40`) rend `null`, jamais une exception : chaque organe lit ce mode ;
- état illisible = `normal` mais **signalé** (`unreadable`), jamais silencieux.

Branchement : stocke le JSON où tu veux (fichier, table de réglages), lis-le avec `parseModeState`, passe
l'état à chaque organe qui écrit à l'humain.

### `request-queue.ts`

La politique d'ENVOI des demandes rapides (un pouce, un choix, une approbation). La demande est toujours
enregistrée par ailleurs (base, empreinte de l'acte) ; seul le message passe par la file :

- une demande urgente part tout de suite, à toute heure, en tout mode ;
- sinon la première part tout de suite ; les suivantes dans les 15 min attendent le créneau et partent
  ensemble en **un** message ; heures calmes optionnelles (`quiet-hours.ts`) ; absent/débordé = attend le retour ;
- une demande fermée ou périmée entre-temps ne part pas ;
- **une réaction sur un message groupé ne décide rien** : une réaction vise un message, pas une demande, donc
  un pouce ne dit pas laquelle. Le message demande « ok N » (`okNumbers` lit `ok 12 13`). Un pouce sur un
  paquet ferait passer d'un geste plusieurs actes lus en diagonale ;
- `bodyShowsAct` : si le texte en file ne montre plus l'acte enregistré, au caractère près, il n'est pas envoyé
  (une base retouchée ne fait pas lire à l'humain un acte différent de celui que le verrou laissera passer) ;
- `runnerAlive` : si le porteur (le daemon) n'a pas battu depuis 5 min, envoie tout de suite plutôt que de
  confier la demande à une file que personne ne vide.

`passFile(deps)` est le passage du daemon ; elle reçoit `send`, `drop`, `markSent` en dépendances.

## 3. Réparer le jour même : `friction-detect.ts` et `promise-watchdog.ts`

### `friction-detect.ts`

Une boucle d'amélioration qui ne tourne que la nuit laisse une friction de 9 h attendre 18 h. À la fin d'un
tour de conversation, le daemon lit le message de l'humain ; s'il porte un signal (silence, reproche,
insatisfaction), il enfile un **job de réparation** en session isolée. `openFrictionRepair(store, …)` fait
tout (détection, plafond quotidien, dédoublonnage) pour **toutes** les portes par lesquelles l'humain parle à
l'agent : si la détection ne vit que dans le canal principal, les pannes de ce canal, justement les heures où
l'humain s'agace le plus, restent sans réparation.

Les leçons, dans le code :
- **détection mécanique, jugement dans le job**. Le prompt exige de vérifier que la friction est réelle
  (« ne fabrique pas un correctif pour justifier ce job »), de remonter à la cause racine, et de ne pas
  écrire à l'humain sauf décision qui l'engage ;
- **un faux positif ne coûte pas un job, il coûte le correctif que ce job va fabriquer**. Les motifs ambigus
  se resserrent (« combien de fois » nu est un comparatif de quantité ; « tu dors » est aussi une question
  d'intendance) ; mesure chaque motif sur l'historique réel et lis chaque match ;
- **un reproche sur le coût ne se répare pas en dépensant** (`frictionIsAboutSpending`) : il va au rêve ;
- plafond quotidien : au-delà, c'est un sujet de fond, pas un incident ;
- un job de réparation tué par le plafond de budget laisse la friction **ouverte** : `isRepairJob` et
  `frictionReopenedNote` l'empêchent de se fondre dans le générique « job en erreur » (zéro reprise
  automatique, qui doublerait la dépense sans humain dans la boucle) ;
- regex JS : `\b` est ASCII (il ne voit ni « ç » en tête ni « é » en fin) ; utilise `(?<!\p{L})` et porte la
  limite de fin par alternative. Chaque motif a un test positif ET négatif, un motif qui se compile peut ne
  jamais mordre.

`DEFAULT_PATTERNS` est un point de départ français/anglais : remplace-le par le vocabulaire réel de ton
humain (`detectFriction(body, tesMotifs)`).

### `promise-watchdog.ts`

Un agent s'éteint entre deux réveils. « Je te tiens au courant » sans réveil armé est une promesse
intenable, et c'est toujours l'humain qui relance. Une note de mémoire récidive : il faut un mécanisme. Après
un tour qui envoie un message contenant une promesse de suivi, `shouldNudge` dit s'il faut **une** relance dans
la même session (le tour qui a promis est encore en contexte) : armer le réveil maintenant, ou dire pourquoi
ce n'en était pas une. Tu fournis `wakesCreatedDuringTurn` (un compteur de ta base) et le compteur du jour.

## 4. Les agents spécialisés : `charters.ts`, `agent-brief.ts`, `agent-engine.ts`

- **`charters.ts`** : un agent est une CHARTE (`chartes/<id>.md`, frontmatter étroit + `## Mission`,
  `## Leçons`) et un nom dans `nomenclature.json` (le seul endroit où un nom s'écrit). `validate` porte des
  garde-fous **déclaratifs** : un gardien observe au moins ; une sensibilité non `generic` interdit un moteur
  externe (la donnée sensible ne sort pas du périmètre) ; un rattachement désigne une entité connue ; un
  organe cité existe ; un agent pas encore actif dit à quelle étape il naît. `buildOrgChart` génère
  l'organigramme publiable ; fais échouer un test s'il dérive des chartes. Le vocabulaire est un paramètre
  (`Vocabulary`).
- **`agent-brief.ts`** : charte + briefing (« où j'en suis », recalculé à chaque réveil) + carnet (ce que les
  corrections de l'humain ont appris) + journal + fil. Les leçons durables remontent du carnet vers la charte
  la nuit, puis sortent du carnet : sans cette remontée, élaguer ferait oublier. `agentIntent` assemble le
  tout ; un carnet sensible n'est pas transmis à un moteur externe. Règle commune injectée : **une seule voix
  vers l'humain** (l'agent principal ; un agent spécialisé signe de son nom sur le tableau), et toute promesse
  a son porteur créé dans le même réveil.
- **`agent-engine.ts`** : le contrat `invoke / status / cancel`, et une implémentation sur ta file de jobs.
  Les décisions (quand réveiller, avec quoi) ne connaissent pas le moteur qui exécute ; un moteur qui ne sait
  pas annuler le dit (`ok: false`) au lieu de faire semblant. Récupération après plantage : un job en
  `echec` reste `echec`, c'est à l'appelant de décider de le relancer.
- **`autonomous-denials.ts`** : les gestes qui appartiennent à l'humain (arbitrer, réarmer un disjoncteur)
  sont refusés aux sessions non interactives **au niveau des permissions du moteur** (`--disallowedTools`),
  pas seulement par une variable d'environnement que le job peut effacer. Deux verrous, pas un. Pour *citer*
  le verbe refusé dans un texte, passe le texte par un fichier (`text-arg.ts`, `@chemin`) : le motif refuse
  toute commande qui le CONTIENT et ne doit pas s'assouplir.
- **`triage-audit.ts`** : le contrôle de l'équipe. Relit après coup les tickets créés par les agents,
  ouverts, non P0, dont le titre touche un critère P0 écrit (« classés bas »), et signale un **silence
  suspect** : le système a travaillé (≥ 5 jobs en 24 h) sans rien demander à l'humain. Un agent qui n'interrompt
  jamais ne se trompe jamais visiblement : c'est ce qu'on cherche. À mettre dans le rapport du matin.

## 5. Le rêve nocturne : `phase-chain.ts` et `deferred-report.ts`

### Une chaîne de jobs plutôt qu'une longue session

Une consolidation nocturne (mémoire, auto-amélioration, apprentissage, rapport) qui tient dans UNE session
est coupée en route par un quota ou un redémarrage, et perd tout ce qui suit. Chaque phase est donc **un job**
de ta file (`chain_id`, `chain_seq`, `chain_kind`) et hérite de sa résilience (reprise sur quota, réenfilement
des orphelins). Quand un job de la chaîne se termine (succès ou échec définitif), le **runner de jobs**
enfile la phase suivante avec la sortie des précédentes dans son prompt. Le dernier maillon, le rapport, est
**toujours** enfilé, même si un maillon a échoué : l'humain reçoit toujours quelque chose. Le planificateur ne
fait que démarrer une chaîne à l'heure et réparer un maillon fini sans successeur (la fenêtre minuscule d'un
redémarrage entre la fin d'un job et l'enfilage du suivant).

`phase-chain.ts` porte la partie pure : `PhaseDef`, `chainIdForDate`, `summarizePriorPhases`, `phaseParts` /
`buildPhasePrompt`, `isIntermediatePhase`.

Pièges évités :
- **ne tronque pas un résumé de phase par `.slice(0, N)`** : la FIN du résumé est l'endroit où une phase écrit
  ce qu'elle passe à la suivante. `clipPhaseSummary` garde début et fin et marque la coupe ;
- **« aucun message envoyé » n'est pas un échec pour un maillon intermédiaire** (`isIntermediatePhase`) :
  seule la dernière phase parle à l'humain. Un mécanisme de rejeu qui ne fait pas la différence coûte un
  réveil par phase et par redémarrage, et peut déverser un prompt brut dans la messagerie ;
- **la clôture commune** (`trailer`) : une phase tourne dans un worktree isolé mais écrit parfois dans la copie
  vivante ; écrire dans le live t'en rend responsable jusqu'au commit. Un arbre sale gèle l'auto-rechargement
  du daemon et fait échouer les rebases des autres lanes.

### Le rapport du matin : composé la nuit, envoyé à heure fixe (`deferred-report.ts`)

La dernière phase écrit le rapport et le **dépose** ; le daemon, sans moteur, l'envoie à l'heure choisie par
l'humain, dans son fuseau (07:30 par défaut). Un rapport déposé **après** l'heure part tout de suite. Trois
pièges fermés :

1. **un porteur déployé n'est pas un porteur actif** : le runner signe chaque passage (`HEARTBEAT_KEY`) ; sans
   signature fraîche le dépôt est refusé (code 3) et la phase envoie elle-même. Un dépôt que personne ne
   porte serait un rapport perdu en silence ;
2. **le rejeu au démarrage** ressusciterait la phase et l'enverrait deux fois : `reportCarriedFor` lui dit que
   le rapport de cette nuit est déjà porté ;
3. **un envoi coupé en vol** ne doit ni se perdre ni partir deux fois : la tentative est notée AVANT l'appel
   (`inFlightMs`), le passage suivant **sonde le fil** avant de renvoyer.

Et trois étages de repli : canal préféré (3 essais), chat principal, puis dernier recours hors canal, puis
abandon de la file. `appendLine` ajoute mécaniquement au rapport une ligne produite ailleurs (ex. l'état du
bureau des plaintes) : une consigne en prose dans la phase ne suffit pas.

## Ce qui n'a pas été porté

Les chartes et nomenclatures réelles, les prompts de phases du rêve, le registre de groupes privés, les
verbes de CLI propres à un déploiement : ils décrivent un agent précis. Écris les tiens avec les formats
ci-dessus. Les fiches de `competences/` (`vider-le-bureau-des-plaintes.md`, `superviser-sans-relancer.md`)
décrivent les routines humaines autour de ces modules.
