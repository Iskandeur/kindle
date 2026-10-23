/**
 * approval-dedup — doublons et demandes périmées, à la CRÉATION d'une demande d'approbation. PUR.
 *
 * Quand plusieurs sessions demandent la même chose, ou qu'une demande de fusion est dépassée par une
 * tête plus neuve de la même PR, l'humain reçoit 7 demandes pour 5 décisions : il apprend à répondre
 * sans lire, et l'approbation ne vaut plus rien. Deux règles, appliquées avant d'écrire la demande :
 *  1. une demande vivante (en attente, jamais servie) à la MÊME empreinte existe → on rend SON numéro
 *     au lieu d'en créer une seconde ;
 *  2. une demande vivante portant sur la même cible mais sur un AUTRE état (autre commit d'une même PR)
 *     est périmée d'office : elle passe `superseded`, l'humain n'a plus à trancher l'ancienne tête.
 *
 * La « cible » et l'« état » d'une demande se lisent dans sa commande (le texte exact de l'acte). Le
 * format est le tien : passe `extraireCible`. Le défaut reconnaît `merge <cible> at <état>`.
 */

export interface VivanteRow {
  id: number;
  status: string | null;
  consumed_at: number | null;
  fingerprint: string | null;
  command: string | null;
}

const vivante = (r: VivanteRow): boolean => (r.status ?? "pending") === "pending" && r.consumed_at == null;

/** Ce qu'on lit d'une commande de demande : ce qu'elle vise, et l'état précis visé (un sha, une version). */
export interface CibleActe {
  cible: string;
  etat: string;
}

/** Défaut : `merge owner/repo#12 at 0123abc` (casse ignorée) → { cible: "owner/repo#12", etat: "0123abc" }. */
export function cibleParDefaut(command: string | null): CibleActe | null {
  const m = /\bmerge\s+(\S+#\d+)\s+at\s+([0-9a-f]{7,40})\b/i.exec(command ?? "");
  return m ? { cible: m[1].toLowerCase(), etat: m[2].toLowerCase() } : null;
}

/** Deux états sont le même si l'un est le préfixe de l'autre (sha court contre sha long). */
export function memeEtat(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

export type VerdictCreation = { type: "doublon"; id: number } | { type: "creer"; perimees: number[] };

/**
 * Que faire d'une demande qu'on s'apprête à créer ? `vivantes` = les demandes ouvertes (au moins
 * celles qui peuvent encore être en attente). `doublon` = rends ce numéro au demandeur ; `creer` = crée,
 * et passe `perimees` en `superseded`.
 */
export function verdictCreation(
  vivantes: readonly VivanteRow[],
  fingerprint: string | null,
  command: string | null,
  extraireCible: (command: string | null) => CibleActe | null = cibleParDefaut,
): VerdictCreation {
  if (fingerprint) {
    const dup = vivantes.filter((r) => vivante(r) && r.fingerprint === fingerprint).sort((a, b) => b.id - a.id)[0];
    if (dup) return { type: "doublon", id: dup.id };
  }
  const neuve = extraireCible(command);
  const perimees: number[] = [];
  if (neuve) {
    for (const r of vivantes) {
      if (!vivante(r)) continue;
      const v = extraireCible(r.command);
      if (v && v.cible === neuve.cible && !memeEtat(v.etat, neuve.etat)) perimees.push(r.id);
    }
  }
  return { type: "creer", perimees };
}

export interface DemandeAnterieure {
  id: number;
  status: string | null;
  verdict: string | null;
  consumed_at: number | null;
  command: string | null;
}

/**
 * La demande à laquelle une re-demande succède : la plus récente sur la MÊME cible mais à un AUTRE état,
 * jamais servie (un acte exécuté ne se « relance » pas), quel que soit son statut (elle a pu être
 * passée `superseded` par le lot juste avant). Sert à composer une re-demande fidèle : « tu avais
 * répondu X à #N ; l'état a changé de A à B ». PUR.
 */
export function demandeRemplacee(
  anterieures: readonly DemandeAnterieure[],
  command: string | null,
  extraireCible: (command: string | null) => CibleActe | null = cibleParDefaut,
): DemandeAnterieure | null {
  const neuve = extraireCible(command);
  if (!neuve) return null;
  const memes = anterieures.filter((r) => {
    const v = extraireCible(r.command);
    return r.consumed_at == null && v !== null && v.cible === neuve.cible && !memeEtat(v.etat, neuve.etat);
  });
  return [...memes].sort((a, b) => b.id - a.id)[0] ?? null;
}
