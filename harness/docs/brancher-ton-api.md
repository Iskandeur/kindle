# Brancher ton API d'inférence en 3 lignes

*English: [`bring-your-own-api.md`](bring-your-own-api.md).*

Kindle marche par défaut avec Claude Code et ton abonnement Claude. Si tu as accès à une autre API
d'inférence qui parle le protocole OpenAI (`/v1/chat/completions`), ton compagnon peut tourner dessus :
vLLM, LiteLLM, OpenRouter, Together, Groq, Ollama, le serveur de ton entreprise…

## 1. Trois lignes

À la racine du dépôt, copie `.env.example` en `.env` (il n'est jamais commité) et remplis :

```bash
KINDLE_BASE_URL=https://inference.example.com/v1
KINDLE_API_KEY=sk-remplace-moi
MODELE_FORT=nom-du-modele
```

C'est tout. Le moteur `openai-compatible` se déduit de `KINDLE_BASE_URL`. Les modèles se nomment par
**rôle** : `MODELE_FORT` pour le vrai travail, `MODELE_RAPIDE` (facultatif, sinon le même) pour les
tâches légères comme le routeur pré-vol. Un serveur local sans clé (Ollama, vLLM) : laisse
`KINDLE_API_KEY` vide.

## 2. Les outils (bash, édition de fichiers, MCP) : OpenCode

Un compagnon a besoin d'agir : lire et écrire ses fichiers de mémoire, lancer `git commit`, parler à
des serveurs MCP. Pour ces tours-là, kindle passe par [OpenCode](https://opencode.ai), un CLI agentique
libre (licence MIT) qui accepte n'importe quel fournisseur compatible OpenAI :

```bash
npm i -g opencode-ai
```

Les appels sans outils (classer un message, résumer) partent en HTTP direct et n'ont pas besoin
d'OpenCode.

## 3. Le test de fumée

```bash
node harness/bin/kindle.ts doctor
```

Il affiche la config (clé masquée), interroge `/models`, vérifie que tes noms de modèles y figurent,
cherche OpenCode, puis joue un tour réel (« pong »). Code de sortie 0 = prêt.

Sans compte ni réseau, pour voir la chaîne entière marcher contre un faux serveur local :

```bash
node harness/bin/kindle.ts doctor --fake
```

Puis un vrai tour :

```bash
node harness/bin/kindle.ts ask "Présente-toi en une phrase."
node harness/bin/kindle.ts ask --outils "Liste les fichiers de memoire/ et résume l'index."
```

## 4. Vivre avec ton compagnon en session (sans Claude Code)

Le mode « session » de kindle, c'est ouvrir un agent dans le dépôt et lui parler. Avec ton API :

```bash
node harness/bin/kindle.ts opencode-config --write   # écrit opencode.json (sans la clé)
opencode                                             # ouvre la session dans le dépôt
```

`opencode.json` dit à OpenCode de lire `CLAUDE.md` à chaque tour (l'âme du compagnon), déclare ton
fournisseur et tes deux modèles, et reprend les serveurs MCP de ton `.mcp.json`. La clé n'y est pas :
OpenCode la lit dans `KINDLE_API_KEY` au lancement (`export KINDLE_API_KEY=…`, ou ton gestionnaire de
secrets). Ce fichier est dans `.gitignore`. Tu peux l'éditer : il prime sur la config que kindle génère
pour les tours de fond (permissions fines, par exemple `"bash": {"git *": "allow", "*": "ask"}`).

## 5. Budgets et quota : ce qui change

| | `claude` | `openai-compatible` |
|---|---|---|
| Plafond en dollars par tour (`KINDLE_BUDGET_USD`) | appliqué (`--max-budget-usd`) | ignoré, avec un avertissement |
| Coût d'un tour | chiffré | `null` (inconnu), jamais un 0 inventé |
| Quota | celui de l'abonnement | `non-mesure`, ou `illimite` si tu poses `KINDLE_QUOTA=illimite` |
| Une politique de quota peut-elle différer du travail ? | oui | non : on ne bride pas sur une mesure qui n'existe pas |

`limitsOf(config)` (dans `src/lib/engine-config.ts`) donne ces quatre réponses à ton daemon : un
module de quota s'y branche et passe en mode illimité au lieu de planter.

## 6. Limites connues

Ce qui est propre à Claude Code et n'a pas d'équivalent ici :

- **Les hooks de `.claude/settings.json` ne tournent pas sous OpenCode.** Un garde-fou posé en hook
  `PreToolUse` (par exemple `wa-guard`, qui filtre les envois WhatsApp) n'est PAS actif. Appelle sa
  fonction `decide` depuis ton propre code d'envoi, ou écris un plugin OpenCode
  (`tool.execute.before`), avant de brancher une messagerie.
- **Les plugins Claude Code** (Alvearium, `/alvearium:board`) ne se chargent pas. Le serveur MCP
  d'Alvearium est un serveur stdio ordinaire : le déclarer dans `.mcp.json` devrait donner les outils
  `ticket_*`, mais ce n'est pas vérifié sous OpenCode ; le ticket de session automatique (fait par les
  hooks) manquera de toute façon.
- **Le plafond en dollars par tour, le quota d'abonnement, l'effort de réflexion** (`/effort`) : pas de
  plafond, pas de mesure, l'effort choisi par le routeur n'est pas transmis.
- **La qualité des appels d'outils dépend du modèle.** Un petit modèle ouvert rate souvent le format
  des outils ; prends pour `MODELE_FORT` un modèle annoncé pour l'usage d'outils (« function calling »).
- **OpenCode demande un fournisseur qui sait diffuser (`stream: true`).** C'est le cas de vLLM, LiteLLM,
  Ollama, OpenRouter. Le mode HTTP direct, lui, n'en a pas besoin.
- **Permissions** : `KINDLE_CLAUDE_PERMISSION_MODE=acceptEdits` (défaut) permet l'édition et met bash
  et webfetch en « demander » ; sans humain, OpenCode refuse alors seul et le tour s'arrête, comme
  `claude -p`. `bypassPermissions` permet tout (bash libre, sans hooks) : il est refusé tant que tu ne poses pas aussi `KINDLE_ALLOW_BYPASS=1`, et alors seulement dans un dossier jetable. Ce que permet ton `opencode.json` de projet vaut aussi
  pour les tours de fond (il est prioritaire) : n'y mets pas `"bash": "allow"` pour ta seule session.
- **Secrets de l'environnement** : l'enfant OpenCode reçoit ton environnement, moins
  `ANTHROPIC_API_KEY`. Un modèle qui a bash peut donc lire les autres variables (jetons GitHub…).
  Lance ton daemon avec un environnement réduit si ton fournisseur n'est pas de confiance.
- **Code tiers** : OpenCode charge le paquet `@ai-sdk/openai-compatible` pour parler à ton API. La
  version 1.19.4 l'embarque (vérifié hors réseau) ; une autre version peut le télécharger depuis npm
  au premier tour.

## 7. Variante sans code : garder Claude Code, changer le fournisseur

Claude Code sait parler à une passerelle compatible Anthropic. Un proxy
[LiteLLM](https://docs.litellm.ai) traduit vers ton API OpenAI, et tu gardes hooks, plugins et
sous-agents :

```bash
litellm --model openai/nom-du-modele --api_base https://inference.example.com/v1   # écoute sur :4000
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=sk-remplace-moi
claude --model nom-du-modele
```

Non testé dans ce dépôt (seul le moteur `openai-compatible` l'est). Laisse alors `KINDLE_ENGINE` à
`claude` : le moteur `claude` retire `ANTHROPIC_API_KEY` de l'environnement de ses enfants, mais pas
`ANTHROPIC_BASE_URL` ni `ANTHROPIC_AUTH_TOKEN`.

## Pour le code

- `src/lib/engine-config.ts` : lit le `.env`, les rôles, `limitsOf`.
- `src/lib/engine.ts` : `runTurn(config, { prompt, tools, cwd })`, l'aiguillage.
- `src/lib/engine-claude.ts`, `engine-openai.ts`, `engine-opencode.ts` : les adaptateurs.
- `src/lib/router.ts` : `classifyRoute(ctx, { engine })` route entre `MODELE_RAPIDE` et `MODELE_FORT`.
- Les erreurs HTTP portent leur code (`HTTP 429 …`) : `engine-failover.ts` les classe comme celles
  du CLI Claude.
- Tests : `src/lib/engine.test.ts` joue un tour avec appel d'outil contre un faux serveur local
  (`fake-openai-server.ts`, sans réseau), et, si OpenCode est installé, un tour réel avec bash puis un
  outil MCP (`fake-mcp-server.ts`).
