/**
 * Liens GitHub liés à ton compagnon. Pas d'appel API GitHub live ici — une vraie intégration avec
 * stats en direct serait un chantier séparé, hors scope pour ce panneau (liens + description
 * courte suffisent).
 *
 * Ces deux entrées sont statiques (adapte-les à tes propres dépôts). Les **knowledge repos**, eux,
 * sont lus DYNAMIQUEMENT depuis `knowledge/registry.json` — cf. `src/knowledge-repos.js`, assemblé
 * dans la route `GET /api/github`.
 *
 * Remplace `main` par ton dépôt principal (identité/mémoire/protocoles/harnais — généralement
 * privé). `public`, ci-dessous, pointe par défaut vers ce starter lui-même : change-le si ton
 * propre dépôt public diffère.
 */
export const GITHUB_LINKS = {
  main: {
    label: "Repo principal",
    url: "https://github.com/<toi>/<ton-compagnon>",
    visibility: "privé",
    description: "Identité, mémoire, protocoles, harnais de ton compagnon. À remplacer par ton propre dépôt.",
  },
  public: {
    label: "Repo public / portfolio",
    url: "https://github.com/Iskandeur/Kindle",
    visibility: "public",
    description: "Le starter dont ce dashboard est issu.",
  },
  knowledgeNote:
    "Dépôts privés dédiés, un par domaine (optionnel) : ton compagnon peut les cloner dans " +
    "knowledge/<nom>/ (git-ignorés du dépôt principal) et les charger à la demande selon le sujet. " +
    "Liste et domaines lus en direct depuis knowledge/registry.json — seules les MÉTADONNÉES sont " +
    "exposées ici, jamais le contenu.",
};
