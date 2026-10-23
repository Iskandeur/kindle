# Jobs de fond, quota partagé, robustesse du daemon

Modules purs (I/O injectée : magasin clé/valeur, horloge, `git`, envoi). Tests : `src/lib/<nom>.test.ts`.

## Le quota partagé

- **`claude-quota.ts`** : lit le `rate_limit_event` que `claude -p --output-format stream-json --verbose` émet
  à chaque tour (fenêtres 5 h et hebdo). Passif : aucun jeton extrait. Branche `StreamJsonCollector` sur le
  stdout du processus, puis `setQuotaSink` sur ta base. Pièges : les resets arrivent en secondes OU en
  millisecondes (`toEpochMs`) ; ne garde jamais tout le flux en mémoire ; un évènement vide n'écrase pas une
  vraie mesure.
- **`quota-policy.ts`** : projette la fin de fenêtre (rythme hebdo lissé depuis le reset, pas sur 24 h) et
  décide : différer les jobs non urgents au-delà d'un seuil 5 h, passer le fond à un modèle léger, plafonner
  l'effort, basculer sur un moteur de repli avant le 429, alerter une seule fois par franchissement. Fournis un
  `QuotaStore` (`getSetting`, `setSetting`, `recordQuotaLog`, `quotaLogSince`). Injecte `quotaContextLine` en
  tête de chaque réveil et lis `createPolicyReader` dans le runner. Une mesure haute reste vraie jusqu'au reset,
  une basse vieillit ; la contrainte hebdo prime sur la marge 5 h.

## La file de jobs

- **`job-landed.ts`** : un job `done` n'est pas un job atterri (le statut est le code de sortie du processus).
  Preuve positive : un blob du commit du job identique dans `main` (survit au squash et au rebase), ascendance
  comme preuve suffisante, provenance du commit de tête vérifiée. Affiche le verdict À CÔTÉ du statut.
- **`final-question.ts`** : un job qui finit sur une question est mort, personne ne lui répond. Détecte la
  question finale pour la transformer en décision par défaut.
- **`job-stall.ts`** : détecte un job en vol bloqué (commande sans retour, silence, boucle d'échecs) depuis
  sa transcription JSONL ; une alerte par (job, genre).
- **`job-eta.ts`** : un délai annoncé se calcule (file, âge des jobs en vol, concurrence, drainage), et une
  annonce dépassée de 50 % déclenche une relance unique.
- **`job-wait.ts`** : générateur de lignes (atterrissage, « toujours en vol ») pour un moniteur de session.
- **`load-gate.ts`** : suspend les réclamations quand la charge reste haute, reprend avec hystérésis. Les jobs
  en vol ne sont jamais coupés.

## Robustesse du daemon

- **`conv-turn-guard.ts`** : un tour de conversation ne porte aucun travail long. Ligne d'attente, puis tour
  coupé et repris en job si un message attend derrière ou au plafond dur. Le texte d'un tiers n'entre jamais dans
  l'intent du job ; les lignes internes ne partent jamais vers un tiers (`relayChatId`).
- **`reload-drain.ts`** : rechargement du daemon par drainage. La file cesse de réclamer, les jobs en vol
  finissent, puis redémarrage ; limite, pause, borne dure sans jamais couper, délai de calme pour une rafale de
  fusions, seule exception urgente explicite.
- **`outage-recovery.ts`** : registre des évènements morts pendant une panne d'authentification, repris par un
  réveil unique au premier tour qui aboutit (du moteur concerné). Une rechute remet l'inventaire au registre.
- **`child-env.ts`** : l'environnement des sous-processus est une liste blanche ; une variable inconnue n'est pas
  transmise. La clé d'API reste toujours retirée (garde-fou de facturation).
- **`docker-env-guard.ts`** : refuse, dans un hook `PreToolUse` sur `Bash`, les commandes qui impriment l'env d'un
  conteneur en valeurs ; passe la forme « noms seulement ». Limites écrites dans l'en-tête.
- **`engine-timeline.ts`** : quel moteur écrivait à tel instant ; une mesure de voix doit déclarer son mélange.
- **`succession.ts`** : registre ancien → successeur → extinction, avec sondes ; un instrument muet n'est jamais
  « éteint ».
