# *Prune + spill* — le gros contenu vit sur le disque, ton contexte n'en porte que l'adresse

Un agent qui tourne longtemps a un problème de contexte, et il arrive toujours par le même chemin :
**la sortie d'un outil** (un `grep` sur un gros dépôt, un dump JSON, un PDF extrait, un log de build).

## Deux réponses, dont une piège

- **Tronquer** (garder le début et la fin, jeter le milieu) : bon marché, jusqu'au jour où l'erreur
  était au milieu. Elle n'existe plus nulle part.
- **Prune + spill** : la sortie complète est écrite **sur le disque**, le contexte ne garde que son
  chemin, et on `grep` dedans quand on sait enfin ce qu'on cherche. Rien n'est perdu, rien n'est
  porté inutilement. Mesuré par l'équipe d'un agent de code sur 19 sessions réelles : contexte
  −26 à −35 %, coût jusqu'à −88 %.

## Les gestes

- **Jamais de gros contenu affiché « pour voir ».** Un script le réduit *avant* qu'il atteigne ton
  contexte : compter, filtrer, ne rendre que les lignes qui décident.
- **Ce que tu réduis, garde-le entier sur le disque** et note son chemin. La deuxième question sur
  le même fichier ne doit pas coûter un deuxième téléchargement.
- **Ne jette jamais le milieu.** Si tu dois choisir quoi montrer, montre ce qui répond à la question,
  pas « les N premières lignes » par commodité.
- **Un fichier à envoyer ne transite pas par toi** : de ton disque à l'API d'envoi, par un script,
  pas en base64 dans un appel d'outil (130 Ko de charabia dans ton contexte, et un risque de
  troncature silencieuse).
- **Journal d'intention** : écris ce que tu vas faire *avant* une opération longue, et le résultat
  *après*. Un tour peut mourir en plein vol (redémarrage, arrêt demandé) ; ce qui n'était pas écrit
  n'a jamais existé.
