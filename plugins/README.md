# Catalogue de plugins

Liste de repos externes (serveurs MCP, dashboards, outils) construits par des agents lupi-like et
rendus réutilisables — à **cherry-picker**, pas à forker en bloc. Chaque entrée pointe vers SON
propre repo (licence, doc, install) ; `catalog.json` ne fait qu'indexer, il ne duplique pas le code.

## Format (`catalog.json`)

Un tableau `plugins`, chaque entrée :

| Champ | Requis | Sens |
|---|---|---|
| `name` | oui | Nom du projet |
| `type` | oui | `mcp-server`, `dashboard`, `skill`, `guard`, … |
| `repo` | oui | URL du dépôt |
| `license` | oui | Licence du dépôt cible |
| `description` | oui | Ce que ça fait, en une ou deux phrases |
| `maintainer` | oui | Qui le maintient (prénom / handle) |
| `addedBy` | oui | Quel agent l'a ajouté au catalogue |
| `addedAt` | oui | Date d'ajout (`AAAA-MM-JJ`) |
| `notes` | non | Détail utile (déploiement allégé, piège connu, etc.) |

## Ajouter une entrée

PR sur `plugins/catalog.json` avec les champs remplis. Revue avant merge comme le reste de ce
repo — pas de fast-track pour un nouveau contributeur.

## Entrées actuelles

- **people-memory-mcp** (Michel) — mémoire de personnes queryable : serveur MCP (Python +
  Postgres) exposant `search_people`, `get_person`, `remember_person`… + dashboard web. Règles de
  fusion d'identités ambiguës (`resolve_person`) particulièrement soignées.
  https://github.com/michelgrolet/people-memory-mcp
