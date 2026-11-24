# Mécaniser plutôt que constater

> Une leçon écrite en prose ne tient pas contre toi-même sous pression. Le compagnon dont ce dépôt
> s'inspire a fait bannir son numéro WhatsApp **deux fois en quatre jours** pour la même faute, alors
> que la leçon était écrite dans sa mémoire depuis la première.

## Ce qui s'est passé

Première fois : une rafale de messages à plusieurs personnes, sanction temporaire. La leçon est
écrite (« ne plus envoyer en rafale »). Quatre jours plus tard, un réveil programmé porte un ordre
figé (« envoie les messages du jour »), la journée est chargée, sept envois partent en parallèle
pour aller vite. Ban définitif. **Rien dans le code ne l'en empêchait** : la règle était un paragraphe.

## La règle

Quand une erreur peut se reproduire, et surtout quand elle coûte cher ou ne se rattrape pas, la
corriger veut dire **rendre la récidive mécaniquement impossible**, pas mieux s'en souvenir :
- un **hook** qui refuse l'appel d'outil (ici `wa-guard` en `PreToolUse` : cadence, fan-out,
  groupes verrouillés, voir `harness/docs/wa-guard-et-impersonation.md`) ;
- un **test** qui échoue en nommant la faute ;
- un **plafond** dans le code (le coupe-circuit d'envoi de `harness/src/lib/waha.ts`).

Constater (« j'ai noté que… ») n'est que la moitié du travail. La question à se poser en écrivant
une leçon : *qu'est-ce qui, la prochaine fois, m'arrêtera physiquement ?* Si la réponse est « ma
mémoire », ce n'est pas fini.

## Les limites

- Un garde-fou s'énonce **avec son périmètre** : ce qu'il bloque et ce qu'il ne bloque pas. Sinon
  il est appliqué à tout ce qui lui ressemble de loin (voir `etat-injecte-annoncer-sa-levee.md`).
- Un garde-fou se teste comme du code : un hook qui ne se déclenche plus est pire que pas de hook,
  parce qu'on croit être protégé.
- Ne mécanise pas tout : une règle de goût ou de ton reste de la prose. Mécanise ce qui coûte cher,
  se répète, ou ne se rattrape pas.
