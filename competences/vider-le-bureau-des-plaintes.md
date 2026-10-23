# Vider le bureau des plaintes (routine quotidienne)

> **But** : un tableau de tickets a un coin où n'importe quelle session (la tienne, tes jobs, les sessions
> de ton humain) dépose ce qui fait perdre du temps ou ce qui pourrait être mieux : des tickets de type
> `feedback`, via `board_feedback`. Sans routine, ce coin devient un cimetière. **Quand l'utiliser** : un
> réveil récurrent, la nuit, avant la consolidation nocturne ; porté par un capteur qui ne réveille que si
> la boîte n'est pas vide.

## Le geste, dans l'ordre

1. **Lire** les tickets `feedback` ouverts (`ticket_list`, type `feedback`, statut ouvert). Le corps de
   chacun porte le contexte (session, dépôt, outil visé).
2. **Trier.** Doublons : garder le plus complet, fermer les autres `cancelled` avec « Doublon de T-N ».
   Hors sujet ou déjà corrigé : fermer `done` en disant où c'est réglé (commit, version).
3. **Corriger ce qui se corrige cette nuit**, sans attendre l'avis de l'humain (une amélioration qu'il n'a
   aucune raison de refuser se livre faite) : un job pour le plugin du tableau ou pour le harnais (PR, tests
   verts, fusion), ou directement si c'est petit et sûr (une phrase de doc). Chaque ticket traité est
   **fermé** avec un commentaire de résolution : ce qui a été fait, où, ou pourquoi rien.
   **Confier n'est pas fermer.** Un ticket remis à un job encore en file passe `in_progress` avec la ligne
   `Source : job #N en file`, et c'est le job qui le ferme à la fusion de sa PR. Fermer « fait » ce qu'on
   vient seulement de confier fausse la page que l'humain lit (un lot de 19 tickets fermés à tort, tous
   rouverts par l'audit : dès qu'on ferme plusieurs tickets d'un coup, vérifier une `Source :` pour chacun).
4. **Ce qui demande l'avis de l'humain** (choix de produit, coût, quelque chose de visible chez lui) :
   **UN seul ticket** qui lui est assigné, « Bureau des plaintes : N points à trancher », une ligne par point
   avec la décision par défaut (défaut + délai, voir `ask-block.ts`). Les tickets d'origine passent
   `blocked_by` ce ticket-là, ou sont fermés en y renvoyant.
5. **Déposer le résumé** pour le rapport du matin, 3 lignes au plus (`N traités : X corrigés, Y doublons,
   Z à trancher → T-K`). Lire la note pour la montrer sans l'acquitter est un geste distinct de l'acquitter
   (`peek` vs `morning`) : la montrer une fois pour tout le rapport.
6. **Vérifier que le bureau est vide.** Chaque reste porte un commentaire qui justifie qu'il reste (job en
   cours, attend l'avis de l'humain).

## Ce qu'il ne faut pas faire

- Écrire à l'humain depuis ce réveil : le rapport du matin porte le résumé, le ticket assigné porte les
  décisions. Seule exception : un bug qui casse ses sessions **maintenant**.
- Conclure « vide » quand le tableau ne répond pas : le capteur doit alors rendre une ANOMALIE, qu'on traite.
- Ouvrir un ticket de session pour la routine elle-même : classe son réveil comme routine.
- Mettre des éléments personnels dans un plugin public : le générique va au plugin, le reste à la config
  de ton harnais.

## Pourquoi ça marche

Le bureau transforme la frustration éparse en file traitée. Il ferme la boucle d'amélioration : quelqu'un
(une session) a perdu du temps, l'a écrit en deux lignes, et la routine le corrige sans que l'humain ait à y
penser, sauf pour ce qui est vraiment son choix.
