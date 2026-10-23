# Superviser sans relancer : l'attention de l'humain sert à diriger, pas à savoir où on en est

> **But** : réduire la part de l'input de ton humain qui sert seulement à *savoir* (« où on en est »,
> « vérifie que ça passe », « c'est encore ouvert ? ») pour qu'elle aille à *diriger*. **Quand l'utiliser** :
> avant de lancer pour lui un travail qui dure (job, sous-agent, demande d'approbation) depuis une session où
> il est présent ; avant d'ajouter une surface qu'il devrait surveiller.

## Le modèle : le fan-out d'un superviseur (Olsen et Wood, CHI 2004)

Un humain qui pilote plusieurs robots en tient **FO = AT / IT** : le temps pendant lequel un robot avance
seul après une consigne (*activity time*), divisé par le temps que l'humain lui consacre (*interaction
time*). « Augmenter l'autonomie » monte AT ; « rendre l'input plus facile » baisse IT.

IT se décompose en quatre postes :
1. **surveillance et sélection** : passer en revue l'état de tous et décider qui a besoin de lui ;
2. **changement de contexte** : retrouver les buts et problèmes du nouveau sujet ;
3. **résolution** : analyser et planifier ;
4. **expression de la consigne**.

Deux phrases du même article à garder : IT *augmente* avec FO (plus d'agents = plus de surveillance, même si
chacun est autonome) ; **activité ≠ abandon** : un travail qui avance seul ne libère l'attention que si
l'humain a confiance dans l'atterrissage. Sinon il le regarde, c'est-à-dire qu'il relance.

## Les leviers, poste par poste

1. **Surveillance : l'atterrissage revient là où il a demandé.** Qui lance un travail depuis une session où
   l'humain est présent arme le retour **dans cette session** : fait, échoué ou bloqué, sans qu'il le demande,
   et au plus tard toutes les 30 à 45 min une ligne « toujours en vol, ce qui reste » (report borné de
   notification). S'il n'est pas là : un tableau agrégé rafraîchi toutes les quelques heures et le rapport du
   matin.
2. **Changement de contexte : chaque question porte le sien** (`ask-block.ts` : une question, des options avec
   conséquences, ce qui se passe sans réponse). Un ticket caduc se ferme avant qu'il le voie.
3. **Résolution : trancher pour lui** quand il n'a aucune raison de refuser (décision par défaut + délai).
4. **Expression : le gaspillage est la re-demande.** Une approbation qui n'a pas pu servir (liste de fichiers
   fausse dans l'acte, rebase après une fusion concurrente, PR modifiée après le pouce) est une dette de ton
   côté. Compteur hebdomadaire : re-demandes / demandes, cible zéro. Recalculer l'acte avant de demander ;
   tester la fusion croisée des PR concurrentes avant de demander.
5. **Le plafond** : chaque surface donnée à surveiller monte le poste 1. Un état agrégé bat N fils d'agents
   qui parlent chacun de leur côté. Pas de nouvelle surface sans en retirer une.

## Mesurer ses relances

Compter les messages de l'humain qui ne servent qu'à savoir (état, vérification, relance, ticket caduc), par
canal, et la part de ses *gestes* (un pouce, « fait ») qui portent **aussi** une relance. Pièges de mesure :

- une session absente de ton journal n'est pas forcément la sienne (des tours automatiques d'un daemon
  peuvent être comptés comme ses prompts) ;
- relis la liste message par message avant de croire un total ; un classeur calé sur une fenêtre ne se
  généralise pas à la suivante ; note les faux positifs (une demande de fonctionnalité n'est pas une relance) ;
- les chiffres sont des **planchers** (les surfaces que tu ne vois pas : ses sessions locales, ses
  commentaires sur le tableau) ;
- le taux de relance suit la charge : rapporte-le au nombre de décisions et de jobs du jour avant de conclure
  qu'un levier a marché.

Pose une prédiction chiffrée avec une date et un porteur (un réveil programmé) : si les relances restent
au-dessus du seuil à charge comparable, le levier 1 n'est plus une option, c'est le chantier.
