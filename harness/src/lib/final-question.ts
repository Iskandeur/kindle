/**
 * La question sur laquelle un texte FINIT, ou "" : la phrase qui porte le dernier « ? » de son dernier
 * paragraphe (blocs de code et URL mis à part).
 *
 * Pourquoi : un job (ou un tour) qui finit en posant une question est MORT. Personne ne lui répond, sa
 * session est terminée. Le daemon doit donc le détecter pour transformer la question en décision par
 * défaut ou en relance, au lieu de laisser le résultat attendre une réponse qui n'a plus de destinataire.
 * Un compte rendu qui mentionne un « ? » au milieu d'un paragraphe, dans un bloc de code ou dans une URL
 * n'est pas une question finale. PUR.
 */
export function finalQuestion(texte: string | null | undefined, max = 200): string {
  if (typeof texte !== "string") return "";
  const prose = texte.replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+/g, " ");
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const dernier = paras[paras.length - 1] ?? "";
  const i = dernier.lastIndexOf("?");
  if (i < 0) return "";
  const tete = dernier.slice(0, i + 1);
  const debut = Math.max(tete.lastIndexOf(". "), tete.lastIndexOf("! "), tete.lastIndexOf("? ", i - 1), tete.lastIndexOf("\n")) + 1;
  const q = tete.slice(debut).replace(/^[\s*_>#\-\d.)]+/, "").trim();
  return q.length > max ? `${q.slice(0, max - 1)}…` : q;
}
