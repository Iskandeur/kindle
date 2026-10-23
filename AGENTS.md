# AGENTS.md

*Pour tout agent qui ouvre ce dépôt (OpenCode, Codex, Claude Code, ou une interface comme T3 Code).*
*For any agent opening this repo (OpenCode, Codex, Claude Code, or a UI such as T3 Code).*

Ce dépôt est un **compagnon IA persistant** : sa mémoire et son identité sont des fichiers.

1. **Lis `CLAUDE.md` en premier** : c'est le « seuil », ce que le compagnon lit à chaque réveil
   (onboarding à la première fois, puis journal, mémoire, protocoles). Ce fichier-ci ne le remplace pas.
2. Les règles de vie (mémoire, discrétion, boucle `commit`) sont dans `protocoles/` et `identite/`.
3. Les modules du daemon et leurs commandes sont dans `harness/` ; tests : `cd harness && npm test`
   (Node ≥ 22, aucune dépendance).
4. Moteur et interfaces : `harness/docs/brancher-ton-api.md` (français), `harness/docs/bring-your-own-api.md`
   (English). Les serveurs MCP se déclarent dans `.mcp.json`, une fois pour tous les moteurs.
5. Les hooks de `.claude/settings.json` ne tournent que sous Claude Code : sous un autre agent, applique
   à la main les règles qu'ils appliquent d'habitude (confirmer avant tout envoi à un tiers).

Read `CLAUDE.md` first; the rest of this list points to where things live.
