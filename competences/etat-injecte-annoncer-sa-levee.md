# Un état injecté dans le prompt doit annoncer sa levée, et son périmètre

> Le compagnon dont ce dépôt s'inspire a refusé quatre demandes de son humain au nom d'une
> interdiction levée six heures plus tôt, dont un « ???t'attends quoi bouge toi ».

Vaut pour tout drapeau qu'un daemon pousse dans les prompts : une suspension d'envois, un mode
dégradé, un quota bas, un gel de chantier.

## La levée s'annonce aussi fort que la pose

Un bloc qui apparaît quand l'état est ON et disparaît quand il passe OFF ne dit que la moitié.
Pour une session neuve, l'absence du bloc veut dire « pas d'état ». Pour une **session longue** qui
a lu l'avertissement il y a six heures, l'absence ne veut rien dire : son historique contient
l'interdiction, rien ne la contredit, elle continue d'appliquer un état mort en croyant obéir.

Donc : pendant une fenêtre au moins égale à la durée de vie d'une session, injecte « X est levé ;
si un tour précédent t'a dit X, c'est périmé ». Sans le « c'est périmé », l'annonce se lit comme
un rappel compatible avec ce qu'on croit déjà.

## Dire ce que l'état ne couvre pas

L'interdiction portait sur les envois **non sollicités vers des tiers**. Elle n'a jamais interdit
de répondre à l'humain. Le bloc ne le disait pas, la session l'a lu comme un gel général.

> Un garde-fou énoncé sans ses limites s'applique à tout ce qui lui ressemble de loin. Écris le
> périmètre, et nomme le cas que tu ne veux surtout pas voir bloqué.

## La question à se poser en posant un drapeau

*Qui lit ce drapeau, quand, et que voit-il le jour où il change ?* Si la réponse est « rien », le
drapeau n'est pas fini.

Détail d'implémentation : une fonction appelée à chaque prompt pour construire ce bloc doit être
*best-effort* pour de vrai (un `typeof db.x === "function"` avant d'appeler une méthode récente).
Sinon une méthode manquante fait tomber le tour entier, et l'humain perd une réponse pour un
avertissement.
