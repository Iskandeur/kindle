# Capitalisation & persistance (git)

> Le pas GRAVER de l'Ouroboros, en détail. Ta mémoire n'existe que si elle est commitée : un fichier
> modifié et non commité meurt avec la machine ou la session.

## Le workflow

1. **Où écrire.** Un fait → `memoire/` (le fichier du sujet, sinon un nouveau, référencé dans
   `memoire/index.md`). Un savoir-faire → `competences/<sujet>.md` + une ligne dans `competences/index.md`.
   Un récit → `journal/AAAA-MM-JJ-<titre>.md`. Une règle de fonctionnement → `protocoles/`.
2. **Corriger plutôt qu'empiler.** Si un fait change, réécris la ligne (en datant le changement :
   `[2026-11-24]`), ne rajoute pas une contradiction trois paragraphes plus bas.
3. **Commit par lots, aux pauses.** Pas un commit par phrase : un commit quand un sujet est bouclé,
   ou en fin de session. Message court, au présent, qui dit *ce que tu sais de plus* :
   `memoire : il préfère les réunions le matin`.
4. **Push** si un dépôt distant est branché. Sur une branche de travail : PR, puis fusion. Ta
   mémoire peut aller directement sur `main` ; du **code** passe par une PR que quelqu'un (ou un
   test) relit.

## Hygiène

- **Jamais de secret** dans le dépôt (clés, tokens, mots de passe) : ils vivent dans `.env`, ignoré
  par git. Avant un commit, un coup d'œil à `git diff --cached` suffit à attraper l'accident.
- **Si le dépôt est public, rien de personnel** : noms, numéros, adresses, santé, argent. Le module
  `harness/src/lib/leak-scan.ts` et `harness/docs/public-anti-leak.md` donnent un garde-fou mécanique.
- **Un fichier par sujet.** Une mémoire en vrac dans un seul fichier devient illisible vers 50 Ko :
  scinde par sujet et garde l'index à jour.
- **Les index sont des cartes.** `memoire/index.md` et `competences/index.md` doivent permettre de
  trouver une chose sans tout relire. Une fiche absente de l'index est une fiche perdue.

## Après une fusion squash

Une PR fusionnée en *squash* laisse ta branche locale avec des commits que `main` ne reconnaît pas.
Ne continue pas dessus : `git fetch origin main && git checkout -B <branche> origin/main`, puis
reprends. Sinon la PR suivante rejoue tout l'historique déjà fusionné.

## Durcir l'automatisme

Une règle écrite en prose ne tient pas sous la pression (voir
[`../competences/mecaniser-plutot-que-constater.md`](../competences/mecaniser-plutot-que-constater.md)).
Si tu oublies régulièrement de graver, un hook `Stop` de Claude Code qui refuse de finir tant
qu'il reste des changements non commités dans `memoire/` ou `journal/` vaut mieux qu'un rappel.
