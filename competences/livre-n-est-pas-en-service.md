# « Livré » n'est pas « en service » — et un correctif sur un système déjà sain ne prouve rien

> Deux leçons payées en production par le compagnon dont ce dépôt s'inspire. Une capacité « livrée,
> testée, fusionnée » n'avait jamais produit un seul fichier en 24 h ; un correctif « vérifié » ne
> s'était jamais exécuté une seule fois.

## 1. Une capacité n'est livrée que quand une commande de lecture montre son effet

Un test vert prouve que le code fait ce que le test décrit. Il ne dit rien de l'ordonnanceur qui
doit l'appeler, de la volumétrie réelle (trois fichiers en test, quatre mille en vrai), ni de
l'environnement (disque, quotas, latence). Et le rapport « c'est livré » est écrit par la session qui
vient de coder, au moment où elle a le plus de raisons d'y croire et le moins de recul.

Avant d'écrire « livré » :
1. **Nomme la commande** qui répond oui ou non : un `status`, un `SELECT COUNT(*)`, un `ls`. Si tu ne
   peux pas la nommer, la capacité n'est pas observable, et c'est le premier bug à corriger.
2. **Lance-la**, et colle le chiffre. Pas « ça devrait marcher » : un nombre.
3. **Écris-le** à côté de l'état, pour que la session suivante n'ait pas à te croire.

Quand une note dit « à faire » et une autre « fait », ne départage pas par la date : départage par la commande.

## 2. Quand le système est déjà dans l'état visé, casse exprès

On corrige presque toujours un défaut **latent**, qui ne mord pas encore. Dans ce cas « mon code
marche » et « c'était déjà comme ça » donnent exactement la même observation, et aucune lecture ne
les sépare. Exemple vécu : une unité systemd `Type=oneshot` + `RemainAfterExit=yes` restait
« active » depuis l'avant-veille ; `systemctl start` sur une unité active ne fait rien ; le timer
posé dessus aurait tiré des mois sans rien exécuter, avec tous les voyants au vert.

Le protocole :
1. **Écris l'état de panne** : mets le système dans la configuration exacte du jour où le défaut mordra.
2. **Constate la panne sur le chemin réel de l'usager**, pas sur un proxy qui relit ce que tu viens d'écrire.
3. **Ne touche plus à rien** et laisse le mécanisme réparer seul. Si tu répares à la main, tu testes ton doigt.
4. **Reconstate** sur le même chemin, et garde le script de répétition.

Garde-fous de la casse volontaire : choisis la fenêtre (personne ne l'utilise, vérifié), ne vide
rien en bloc (retire nommément ce que tu as posé, sinon tu coupes peut-être ton propre accès), et
assure-toi que la remise en route ne dépend pas de toi.

> Le signe : *« j'ai déployé, et tout était déjà comme je voulais »*. Ce n'est pas une bonne
> nouvelle, c'est une absence d'information.

## 3. Réparer sans effacer la trace laisse un système dégradé et muet

Un service réparé à la main gardait son compteur « 3 échecs d'affilée » : recul doublé, et l'alerte
qui ne partait qu'à l'échec n° 3 **exactement** ne repartait plus jamais. Deux règles :
- **un seuil d'alerte se double d'un rappel** (`n === 3 || (n - 3) % 7 === 0`) : une avarie qui dure
  doit continuer de se dire ;
- **le chemin manuel écrit le même verdict que le chemin automatique** : les deux passent par la
  même fonction d'évaluation.
