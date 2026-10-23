/**
 * mask-secrets — masquage GROSSIER des secrets dans un texte libre, avant de le journaliser, l'afficher
 * sur un tableau de bord ou l'envoyer à un tiers (une commande collée dans un ticket, un message
 * d'erreur, un titre de tâche).
 *
 * On masque les formes évidentes : clés d'API de fournisseurs connus, jetons Git, clés cloud, JWT,
 * `Bearer …`, `mot de passe : …` / `password=…`, longues chaînes hexadécimales ou base64. Grossier
 * exprès : un faux positif coûte un mot masqué, un faux négatif coûte un secret en clair. Les SHA git
 * (40 hexa) restent lisibles : seul un hexa de 48 caractères ou plus est masqué.
 *
 * Ce module vit SEUL, sans dépendance, pour que n'importe quelle serrure (un hook, un garde de
 * commande) puisse l'importer sans faire entrer un module métier entier dans sa fermeture.
 */
export const MASK = "[secret masqué]";

/** PUR. */
export function maskSecrets(x: string): string {
  return x
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK)
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abposr])[-_][A-Za-z0-9_-]{10,}/g, MASK)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, MASK)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${MASK}`)
    .replace(/\b(mot de passe|mdp|password|passwd|pin|token|jeton|api[ _-]?key|clé d'api|secret)(\s*[:=]\s*)\S+/gi, `$1$2${MASK}`)
    .replace(/\b[a-f0-9]{48,}\b/gi, MASK) // 48 : un SHA git (40) reste lisible
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && !m.includes("/") && !/^[a-f0-9]+$/i.test(m) ? MASK : m));
}
