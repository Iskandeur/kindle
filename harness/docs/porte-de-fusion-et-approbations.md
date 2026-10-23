# Porte de fusion, verrous et approbation humaine

> Cette doc complète [`public-anti-leak.md`](public-anti-leak.md) (le dispositif anti-fuite) : ici,
> le CODE des serrures qui entourent les gestes sensibles d'un agent. Tous les modules sont dans
> `harness/src/lib/`, purs ou presque (I/O injectée), testés, zéro dépendance.

## Le principe : une serrure de procédure, pas un coffre

Un agent qui peut écrire en ton nom, fusionner son propre code, élargir ses droits ou publier suit un
flux documenté : **demander, l'humain réagit, exécuter**. Si rien ne vérifie l'approbation au moment
d'exécuter, ce flux ne tient que par la bonne volonté de l'agent. Un job distrait, ou un contenu tiers qui
l'a manipulé, peut lancer l'acte sans demande, avant la réponse, après un refus, ou avec un autre texte que
celui que l'humain a lu.

Ces modules ferment le **chemin documenté**, celui qu'un agent prend naturellement. Ils ne rendent pas
l'abus impossible : un script écrit à la main qui appelle directement l'API (dont l'agent lit la clé) ne
passe pas par eux. À dire tel quel, jamais à gonfler. Règle de conception commune : **échec fermé**
(information absente = refus) et **faux positifs acceptés** (une approbation de plus ; le silence, non).

## Les modules

| Module | Rôle |
|---|---|
| `approval-gate.ts` | Le verrou : une demande liée à CET acte exact, approuvée il y a moins de 24 h, pas déjà consommée. |
| `approval-dedup.ts` | À la création d'une demande : rend le doublon, périme la demande dépassée (autre tête de la même PR). |
| `json-patch.ts` | Patcher un JSON protégé (réglages) par spec déclarative : dry-run, sauvegarde, re-parse, `apply` autorisé. |
| `merge-gate.ts` | Noyau pur d'un verrou de fusion : relecture adverse sur la tête exacte, tests, chemins sensibles. |
| `wip-merge-check.ts` | Simule la fusion d'une branche de filet (`git merge-tree`) et compte ce qu'elle effacerait. |
| `github-visibility.ts` | Détecte ce qui rend un dépôt public (`gh repo create --public`, `private=false`, fork, gist). |
| `public-publish.ts` | Détecte une mise en ligne par commande (Pages, déploiement, tunnel). |
| `leak-scan.ts` | Scan anti-fuite du contenu avant une sortie publique (voir `public-anti-leak.md`). |
| `mask-secrets.ts` | Masque les secrets d'un texte avant de le journaliser ou l'afficher. |
| `guard-journal.ts` | Une ligne par décision de serrure, autorisée ET refusée, avec une empreinte (jamais le contenu). |
| `file-lock.ts` | Verrou par fichier à renouvellement : un travail lourd à la fois. Régulateur de charge, pas sécurité. |
| `source-hygiene.ts` | Détecte un octet de contrôle qui rend un fichier source invisible à `grep`. |

## `approval-gate.ts` : le verrou de l'approbation

**Ce qu'il vérifie**, pour une demande #N et l'acte qu'on s'apprête à faire, du plus structurel au plus
temporel (la raison affichée est celle qui dit quoi faire) :

1. la demande existe et porte une **empreinte** (elle a été créée liée à un acte) ;
2. l'empreinte est celle de l'acte : mêmes destination + texte (`sendFingerprint`), mêmes fichier cible +
   patch (`patchFingerprint`), ou même texte d'acte (`actFingerprint(kind, texte)`). Un mot changé après
   l'accord = refus, c'est une **nouvelle demande** ;
3. la demande n'est pas fermée (`cancelled`, `denied`, `lapsed`, `superseded`) ;
4. l'humain a décidé, et c'est un pouce levé (teintes de peau comprises) ou un « ok » tapé. Tout autre
   emoji est refusé, y compris ceux qu'une demande aurait proposés en option : **le verrou ne lit pas tes
   conventions en prose** ;
5. elle n'a pas déjà servi : une approbation vaut UN acte ;
6. la décision a moins de 24 h (`APPROVAL_GATE_TTL_MS`).

**Brancher.** Dans ta base, une table de demandes avec au moins `id, status, fingerprint, verdict,
verdict_at, consumed_at` (type `GateRow`). Le code qui exécute l'acte :

```ts
const acte = patchFingerprint(realpathSync(cible), patch);        // ou sendFingerprint / actFingerprint
const gate = checkApprovalGate(db.getApproval(n), acte, Date.now());
if (!gate.ok) { tracer(n, false, gate.reason); refuser(gate.reason); }
if (!db.claimApproval(n)) refuser("déjà consommée");              // UPDATE ... WHERE consumed_at IS NULL
executer();
```

Pièges réels :

- **Consommer de façon atomique, après le contrôle, avant l'acte** (`UPDATE … WHERE consumed_at IS NULL`,
  compter les lignes touchées) : deux processus qui passent le contrôle en même temps ne doivent pas
  utiliser la même approbation. Si l'acte échoue ensuite, *relâcher* la demande (elle n'a rien produit).
- **Le système doit enregistrer le verdict lui-même**, pas seulement passer la demande en « décidée ». Un
  statut qui ne garde pas l'emoji rend 👍 et 🙏 indiscernables, et le verrou ne peut plus trancher.
- **L'empreinte se pose à la création de la demande**, depuis le même code que celui qui exécute. Deux
  calculs différents de « la même chose » (indentation d'un fichier de spec, fins de ligne CRLF, espaces
  finaux) donnent deux empreintes : `normText` écrase CRLF et `trimEnd`, et le patch est comparé en JSON.
- **Une demande sans empreinte ne peut rien autoriser** : sinon une approbation « générale » devient un
  passe-partout réutilisable par n'importe quel acte.
- Le TTL est un paramètre : plus court pour un acte irréversible.

## `approval-dedup.ts` : ne pas noyer l'humain

Sept demandes pour cinq décisions apprennent à l'humain à répondre sans lire, et l'approbation ne vaut plus
rien. À la création, `verdictCreation(vivantes, empreinte, commande)` rend :

- `{ type: "doublon", id }` : une demande vivante (en attente, jamais servie) à la même empreinte existe,
  on rend SON numéro ;
- `{ type: "creer", perimees }` : crée, et passe `perimees` en `superseded` (même cible, autre état : une
  PR dont la tête a bougé n'a plus besoin qu'on tranche l'ancienne).

Le format de ta commande de demande est le tien : passe un `extraireCible(command) → { cible, etat }`
(défaut : `merge owner/repo#12 at <sha>`). `demandeRemplacee` retrouve l'ancienne demande, pour écrire une
re-demande fidèle (« tu avais répondu X à #N ; la tête a changé »). Piège : ne jamais écrire dans la re-demande
« tu avais déjà approuvé » sans lire le **vrai** verdict de l'ancienne ; le récit d'une relance se *calcule*.

## `json-patch.ts` : patcher un fichier protégé

Certains fichiers (réglages de l'agent, config d'outils) sont protégés contre l'édition par l'outil d'édition
de l'agent, justement pour éviter l'élévation de privilèges. L'écriture par commande reste possible ; plutôt
que de laisser l'agent bricoler un `sed`, on lui donne UN geste :

1. écrire une **spec** dans un fichier ordinaire : `{ "set": {...}, "appendUnique": {...}, "unset": [...] }`
   (chemins pointés ; `appendUnique` compare structurellement ; `unset` est idempotent) ;
2. `patchJsonFile(cible, spec)` en **dry-run** (défaut) : rend avant/après, n'écrit rien ;
3. demander l'accord sur CE patch (`patchFingerprint`) ;
4. `patchJsonFile(cible, spec, { apply: true, authorize })` : `authorize(cheminAbsolu)` appelle
   `checkApprovalGate` et rend `{ ok, reason, consume, release }`. Sauvegarde horodatée, écriture,
   **re-lecture + re-parse** ; si le JSON écrit est invalide, restauration immédiate depuis la sauvegarde et
   `release()` (l'approbation redevient utilisable : l'acte n'a pas eu lieu).

Pièges : sans `authorize`, `apply` est refusé (jamais d'écriture « par défaut ») ; le chemin passé à
`authorize` est **résolu** (`realpath`), sinon un lien symbolique contourne l'empreinte ; les clés
`__proto__`, `constructor`, `prototype` sont refusées ; un fichier de config cassé bloque le prochain
démarrage du daemon lui-même, d'où la restauration.

## `merge-gate.ts` : le noyau pur d'un verrou de fusion

`decisionFusion(entrée)` rend `{ ok, raison, sensibles, souples, serrures }`. Tu lui passes le dossier de la
PR (relecture, tests, sha), les fichiers touchés et les niveaux de chemins sensibles ; ton hook (PreToolUse
sur l'outil de fusion et sur `gh pr merge`) applique le résultat. Il exige, dans l'ordre :

1. un dossier de **cette PR** et de **la tête exacte** (sha égal ou préfixe) : un dossier d'une tête
   précédente ne prouve rien sur le code d'aujourd'hui ;
2. une **relecture adverse** (un modèle ou agent qui n'a pas écrit le code) au verdict « ok ». « Ok sous
   réserve » n'ouvre jamais le verrou sans arbitrage humain explicite ;
3. des **tests verts** sur cette tête si le dépôt a une suite. « Pas de suite » est un fait *constaté*
   (`tests: null` et `testsRequis` faux), jamais un défaut ;
4. l'**accord humain** sur un chemin sensible, à deux niveaux (fichier de motifs, en-têtes `[dur]` /
   `[souple]`, `lireNiveaux`) : `dur` = toujours l'accord ; `souple` = permis sans lui si le relecteur
   *certifie* « serrures : aucune », ou « touchées » dans un sens qui ne desserre rien (`restreint` /
   `neutre`) **avec une preuve** citée (`verifierPreuveSerrures` vérifie que la ligne se retrouve vraiment
   dans le diff). Une déclaration absente, illisible, sans preuve ou qui élargit = accord humain. Un dépôt qui
   publie (`depotPublic`) exige l'accord quels que soient les chemins.

L'accord se lie à `mergeActText(dépôt, pr, sha, chemins)` : **le sha de tête fait partie de l'acte**, un push
après l'accord change l'acte et exige un nouvel accord. Le refus se termine par une queue
`— chemins sensibles : …` (`queueChemins`) qui dit d'emblée si un accord humain est en jeu : sans elle, un
refus de « tête périmée » se lit comme « il faut demander un pouce » et déclenche une demande inutile.

Ce qu'on n'a **pas** porté : l'orchestration (qui lance la relecture, lit GitHub, tient le disjoncteur après
N relectures « corriger »). Elle est couplée au dépôt et aux agents de ton installation ; le noyau est ce qui
se réutilise. Les portes de branche (refuser un push direct sur `main`, repérer les écritures d'API qui
contournent la PR) dépendent trop de ta liste de dépôts gardés pour être génériques.

## `wip-merge-check.ts` : le diff à deux points ment

Un filet sauvegarde le travail inachevé d'un agent dans une branche `…-wip`. Pour décider de la reprendre, le
réflexe est `git diff main..wip` (**deux** points) : il compare deux pointes, donc il affiche comme
« suppressions de la branche » tout ce que d'autres lignes de travail ont ajouté à `main` depuis le départ
(spécimen : 2 010 fichiers −427 826 pour un travail réel de 12 fichiers +342 −5, `main...wip` à **trois**
points). Le message d'échec qui prescrit le diff à deux points ment par la bouche de son mode d'emploi.

Reste un mécanisme réel : l'agent déplace son HEAD sur un `main` plus récent et son disque garde l'ancienne
version d'un fichier ; le filet enregistre alors une suppression des lignes reçues entre-temps. Le module
teste la proposition elle-même : il simule la fusion (`git merge-tree --write-tree` : aucune ref, aucun index,
aucun arbre de travail touchés) et compte les lignes arrivées dans `main` depuis le départ de l'agent que la
fusion ferait disparaître. Verdicts : `ancetre`, `sans-risque`, `efface`, `douteux`, `conflit`, `illisible`
(`wipCheckAlarms` dit lesquels exigent de lire avant d'agir). **Note le sha de départ de chaque agent** (`base`) :
sans lui, le repli sur la base de fusion ne voit pas ce qui est arrivé *avant* que l'agent se recale ; la
couche du filet seule suffit alors à rendre `douteux` plutôt que `sans-risque`. Git ≥ 2.38 requis.

## `github-visibility.ts` et `public-publish.ts` : le geste qui rend public

Deux détecteurs purs sur une commande Bash (et sur les appels d'outils MCP GitHub), qui rendent l'**acte**
à faire approuver ou `null` :

- `publicGithubActInBash` : `gh repo create --public`, `gh repo edit --visibility public`, `gh repo fork`,
  `gh gist create --public`, `gh api … private=false`, ou une *création* sans `private=true` (publique par
  défaut côté API), y compris par `curl` sur `api.github.com` ;
- `publicationActInBash` : activer ou republier GitHub Pages par l'API, pousser sur `gh-pages`, les
  déploiements (Vercel, Netlify, wrangler, Surge, Firebase, Fly, Railway, `npm run deploy`) et les tunnels
  qui exposent un serveur local (`cloudflared tunnel --url`, `ngrok`, `localtunnel`).

Pourquoi les deux : le verrou « dépôt public » ne voit pas Pages. Un dépôt *privé* reste privé, mais **son
site sort sur une URL publique**. Un brief qui dit « ne publie pas » n'a pas suffi : il faut un geste
mécanique. Branchement : un hook PreToolUse sur Bash appelle les deux ; si un acte est rendu, refuse tant
qu'aucune approbation n'est liée à `actFingerprint("github-public", acte)` (`mcpActText` donne le texte
canonique d'un appel MCP : clés triées). Après l'accord, l'agent relance **exactement la même commande**,
une fois (la consommation de `approval-gate` fait le reste).

Pièges :

- **Ôter les here-documents avant d'analyser** (`stripHeredocs`) : un message de commit qui *cite*
  `gh repo create --public` n'est pas cette commande. Le texte entre guillemets reste UN mot.
- **Ce n'est pas un analyseur de shell** : un `eval`, une variable, un script Node qui appelle l'API ne sont
  pas vus. Dis-le dans le message de refus plutôt que de promettre l'étanchéité.
- Les outils MCP de déploiement ne passent pas par Bash : ils ont besoin de leur propre entrée de hook.

## `leak-scan.ts`, `mask-secrets.ts`, `guard-journal.ts`

**`leak-scan.ts`** porte le code qui sert [`public-anti-leak.md`](public-anti-leak.md) : règles génériques
(clé privée, jetons, `Bearer`, email, id de messagerie, IPv4, téléphones, chemins d'utilisateur), inventaire
privé de littéraux (`parsePrivateInventory`, un fichier **non versionné** que ta CLI charge), contrôle
« mosaïque » (`parseMosaicInventory` : deux ancres faibles de catégories différentes, dans la sortie et la
surface déjà publique, identifient quelqu'un) et `addedDiffSources` (ne scanne que les lignes *ajoutées* d'un
diff, avec leur vrai numéro de ligne). Le rapport **ne recopie jamais la valeur** : un rapport de fuite qui
cite la fuite en est une seconde. Les exceptions sûres sont étroites exprès : `noreply@anthropic.com` en
correspondance *exacte* (pas `x-noreply@…`), mais le no-reply GitHub (`id+login@users.noreply.github.com`)
reste bloqué, il nomme un compte ; les IP de documentation et privées passent, la tienne non.

**`mask-secrets.ts`** : masquage grossier avant de journaliser, d'afficher ou d'envoyer un texte libre (une
commande collée dans un ticket arrive sinon sur un tableau de bord). Grossier exprès : un faux positif coûte
un mot masqué ; un SHA git (40 hexa) reste lisible, un hexa de 48+ est masqué. Le module vit seul, sans
dépendance, pour qu'un hook puisse l'importer sans faire entrer un module métier dans sa fermeture.

**`guard-journal.ts`** : chaque décision d'une serrure (autorisée **et** refusée) laisse une ligne
`{ at, serrure, outil, decision, raison, empreinte }` dans un `.jsonl`. L'empreinte (16 hexa de SHA-256 de
l'entrée) sert à apparier un « canari » (un geste interdit rejoué exprès) sans garder la valeur. Une serrure
qui n'écrit que sur le chemin autorisé laisse ses refus mourir dans la conversation. Deux règles : le journal
**ne lève jamais** (une serrure ne tombe pas parce que son journal tombe), et `tronquerRaison` garde entière
la queue ` — règles : …` d'un refus, qui dit QUOI a refusé. Une serrure qui *laisse passer* n'écrit rien sur
sa sortie, et ne doit **jamais** écrire `allow` (qui court-circuiterait les permissions de l'agent) :
`brancherJournalSerrure` rend de quoi noter elle-même la raison d'un « laisse ».

## `file-lock.ts` et `source-hygiene.ts`

**`file-lock.ts`** : plusieurs sessions qui lancent en même temps des tests en conteneur sur une petite
machine (2 vCPU) montent la charge à 40 et font expirer les sondes. Un fichier verrou créé de façon
exclusive (`wx`) porte « pid heure » ; le détenteur le **renouvelle** chaque minute, donc un verrou n'est
« vieux » que par son silence. Un pid introuvable n'est pas forcément mort (autre espace de pids) : on ne vole
qu'après trois renouvellements manqués. `lancerSansBloquer` remplace `spawnSync` pour que le renouvellement
puisse partir pendant une suite de vingt minutes, avec un crochet `auDelai` (tuer le client `docker run` ne
tue pas le conteneur : l'appelant y fait `docker kill`). Limite assumée : le vol n'est pas atomique, c'est un
**régulateur de charge**, pas une serrure de sécurité. Il doit rater vers « un travail de trop », jamais vers
« jamais de travail ».

**`source-hygiene.ts`** : un seul octet NUL brut collé dans un littéral de gabarit fait classer le fichier
en *binaire* par `grep`, qui se tait par défaut. Un recherche de symbole renvoie zéro ligne, « ce code
n'existe pas », et on le réécrit ailleurs. Le coût est le mode d'échec : silencieux et convaincant. Branche
`findControlBytes` dans un test qui parcourt tes sources (voir le dernier test de `source-hygiene.test.ts`).

## Ce qui n'a pas été porté

- `opsec-scan` : une liste de mots interdits propres à une installation ; le mécanisme générique est
  l'inventaire privé de `leak-scan.ts`.
- La porte de la branche principale (refus des pushs et écritures d'API directs), l'orchestration de la
  relecture de fusion, la journalisation des fusions « souples » : trop couplées à une liste de dépôts, à
  des agents et à une base précis. Le noyau réutilisable est `merge-gate.ts`.
