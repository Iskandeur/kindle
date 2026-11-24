# Chercher avant de construire (et quand une recherche rend « rien »)

> Le travers le plus coûteux du compagnon dont ce dépôt s'inspire : réécrire en vingt minutes un
> outil fini la veille, dire « je ne peux pas » pendant un mois alors qu'un script le permettait.

## La règle

**Avant de dire « je n'ai pas cet outil », « je ne peux pas », ou d'écrire la première ligne de
code, balaie ce que tu as déjà**, dans l'ordre :
1. tes outils chargés à la demande (ToolSearch, MCP différés) ;
2. ton dépôt : `grep -ri` sur `competences/`, `memoire/`, `harness/` **en entier**, pas seulement la
   section à laquelle tu penses ;
3. tes permissions (`.claude/settings.json`) : un script peut y être autorisé sans être dans le `PATH`.

Une lacune ne se déclare qu'après ce balayage. Et elle vaut pour une note de ta propre mémoire :
« je ne sais pas lire un PDF » écrit il y a un mois est aussi périssable qu'une phrase dite à voix
haute. Coder coûte plus cher que parler, donc `grep` avant la première ligne de code.

Un « je ne peux pas » porte toujours sur quelque chose de précis : un outil, une commande, un
chemin. Nomme-le avant de conclure ; la moitié du temps, le blocage est plus étroit que la conclusion.

## Le jumeau déjà résolu

Quand un document te manque, cherche d'abord **le même document pour le cas que tu as déjà résolu**
(l'autre pays, l'autre client, l'autre année). Il fait deux choses que rien d'autre ne fait :
- **il départage les copies qui circulent** : pour lire la ligne X d'une table que tu n'as pas,
  choisis la copie dont la ligne Y reproduit une valeur que tu connais déjà de source sûre ;
- **il nomme la demande** : si la réponse du cas résolu venait d'un document identifiable, sa
  version pour le cas ouvert existe presque toujours. « Pouvez-vous m'envoyer la note X ? » se
  traite en un envoi ; une question ouverte ramène une brochure.

Le jumeau valide une copie, il ne prouve pas la ligne : écris ce qui reste à confirmer.

## Quand `grep` rend zéro là où le symbole devrait être

Ce n'est pas une réponse, c'est une question. Un seul octet de contrôle (un `NUL` collé dans un
littéral) suffit pour que `grep` classe le fichier en binaire et se taise, sans erreur :

```bash
grep -a -n "monSymbole" fichier.ts   # -a : lit le binaire comme du texte
grep -c "" fichier.ts                # muet = grep le croit binaire
```

`harness/src/lib/source-hygiene.ts` fournit un test qui échoue en nommant le fichier et la ligne :
une leçon dans un journal ne se relit pas au bon moment, un test rouge si.
