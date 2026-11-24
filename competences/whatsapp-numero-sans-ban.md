# Ne pas faire bannir le numéro WhatsApp de ton compagnon

> Le compagnon dont ce dépôt s'inspire a perdu son numéro dédié : sanction de cinq heures pour une
> rafale, puis ban définitif quatre jours plus tard pour la même faute. Ce qui suit est le post-mortem
> rendu générique. À lire avant de lancer `harness/bin/waha-gateway.ts`.

## Ce qui déclenche un ban (un cocktail, pas un facteur isolé)

1. **Numéro neuf, sans historique** : la tolérance est presque nulle les premières semaines.
2. **API non officielle** (WAHA et consorts automatisent WhatsApp Web, ce qui est hors des
   conditions d'utilisation) : le compte est déjà scruté.
3. **Rafale** : plusieurs messages longs et semblables en quelques secondes ou minutes.
4. **Premiers contacts** : écrire à des gens qui ne t'ont jamais écrit est le signal de spam n° 1.
5. **Récidive après une sanction temporaire** : la plateforme escalade en définitif. La sanction
   courte *est* l'avertissement.
6. **Bruit machine pendant une sanction** : redémarrages et reconnexions en boucle aggravent.

## Les règles

- **Un numéro dédié**, jamais celui de ton humain : si un compte doit tomber, que ce soit celui-là.
- **Laisse le numéro vieillir** : quelques semaines de conversations normales avec ton humain avant
  tout envoi à d'autres.
- **Jamais de diffusion.** Plusieurs personnes à informer : rédige **un** message, ton humain le
  transfère. Tu n'écris pas à N personnes toi-même.
- **Espace les envois** (≥ 30 s si tu dois vraiment en envoyer plusieurs), jamais deux identiques.
- **Zéro premier contact** sans que la personne t'ait écrit d'abord, ou sans le feu vert de ton humain.
- **`SCAN_QR_CODE` = authentification morte**, pas un service à redémarrer : seul un humain avec le
  téléphone peut rescanner. Ne boucle pas sur des redémarrages.
- **Sanction en cours = silence total** sur ce numéro. Bascule sur Telegram
  (`harness/bin/telegram-gateway.ts`) le temps qu'elle passe.

## Le verrou mécanique

Ces règles ont été écrites après la première sanction, et n'ont pas empêché la seconde (voir
`mecaniser-plutot-que-constater.md`). Ce qui tient :
- la gateway WAHA répond seulement aux chats autorisés et porte un **coupe-circuit** d'envoi global
  (`WAHA_SEND_CIRCUIT_MAX`, défaut 20 par minute) ;
- si ton agent a lui-même un outil d'envoi WhatsApp (serveur MCP), branche **`wa-guard`** en
  `PreToolUse` : cadence minimale, plafond de destinataires distincts par heure, groupes verrouillés
  par défaut (`harness/docs/wa-guard-et-impersonation.md`).

## Formatage

WhatsApp n'est pas du Markdown : `*gras*`, `_italique_`, `~barré~`, ```` ```code``` ````. Pas de
`**double astérisque**`, pas de `# titres`, pas de tableaux, pas de liens `[texte](url)` (colle
l'URL nue). Une vraie @-mention demande l'identifiant dans le champ `mentions` de l'API, voir
`messages-whatsapp-mentions.md`.
