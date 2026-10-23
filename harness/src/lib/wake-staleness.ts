/**
 * L'ÂGE d'un réveil ponctuel, dit à celui qui le lit.
 *
 * ## Le défaut
 *
 * Un réveil récurrent parle souvent : entre deux tirs il s'écoule sa période, et son texte est
 * reconfronté au monde à cette cadence. Un **ponctuel** est écrit une fois, dort parfois des mois, et
 * parle une seule fois, avec exactement la même autorité qu'une consigne écrite il y a cinq minutes.
 * Rien, dans ce qu'il émet, ne dit son âge : la session qui le reçoit lit « fais X », pas « quelqu'un
 * a jugé, il y a 24 jours, qu'il faudrait faire X ».
 *
 * Ce que ça coûte : une session s'apprête à demander à l'humain une liste d'étapes dont la plupart sont
 * déjà faites (il l'a dit entre-temps, dans le fil) ; ou un réveil tire sur une date limite calculée
 * depuis un évènement qui n'existe plus, et pousse une démarche un mois trop tôt.
 *
 * ## Ce que ce module fait, et ce qu'il ne fait pas
 *
 * Il ne juge pas si la prémisse tient : aucun code ne le peut. Il rend **visible** ce que la base sait
 * et que l'intent tait, le temps écoulé depuis la pose, et il nomme les vérifications qui tranchent. Le
 * contrôle roule sur le TIR, l'acte qu'on ne peut pas sauter, et non sur un audit séparé qu'il faut
 * penser à lancer.
 *
 * ## L'âge de la POSE, et ce qu'il ne dit pas
 *
 * `created_at` date la pose. Si ton système permet de RÉÉCRIRE l'intent d'un réveil à id constant
 * (une revue périodique), la base ne date pas cette réécriture : le bandeau dit donc l'âge de la pose,
 * qui est sûr, et renvoie au texte pour une éventuelle date de relecture. Ne pas affirmer « personne ne
 * l'a relu depuis » : c'est faux dès qu'une réécriture a eu lieu.
 *
 * Le bandeau se pose EN TÊTE du texte. Si un autre lecteur ancre sur le début du corps (un marqueur lu
 * par `startsWith`), vérifie qu'il ne lit que des récurrents ou des ponctuels récents : un nouveau
 * marqueur placé devant l'ancien le casserait.
 *
 * ## Le seuil, et pourquoi il n'est pas à zéro
 *
 * 72 h. En dessous, l'intent et le monde ont peu divergé, et un bandeau sur chaque réveil du jour
 * deviendrait du décor qu'on cesse de lire. Mesuré sur un mois : ~6 % des ponctuels tirés l'étaient 72 h
 * ou plus après leur pose — à peu près un par jour — mais l'essentiel de la file en attente est de cette
 * espèce (les courts tirent vite, la file garde les longs). Re-mesure sur ton propre historique.
 */

/** Au-delà de ce délai entre la pose et le tir, un ponctuel annonce son âge. */
export const STALE_WAKE_AGE_MS = 72 * 3_600_000;

export interface AgedWake {
  /** Epoch ms de la POSE (`wakes.created_at`). Absente ou illisible : pas de bandeau. */
  created_at?: number | null;
  /** Récurrence en ms ; non nulle ⇒ le réveil reparle à sa cadence, pas de bandeau. */
  recurrence_ms?: number | null;
}

/** Formate une date pour le bandeau. Injecté pour les tests ; défaut : la date UTC (AAAA-MM-JJ). */
export type DateFormatter = (ms: number) => string;

/** Fabrique un formateur de jour pour un fuseau IANA (le fuseau de TON humain, pas du serveur). */
export function dayFormatter(timeZone: string): DateFormatter {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (ms) => f.format(new Date(ms));
}

const utcDate: DateFormatter = dayFormatter("UTC");

/**
 * Le bandeau, ou `null` si ce réveil n'a pas dormi assez longtemps pour que son âge compte.
 * Séparé de `withStalenessBanner` pour que le texte soit testable tel quel.
 */
export function stalenessBanner(wake: AgedWake, now: number, fmt: DateFormatter = utcDate): string | null {
  if (wake.recurrence_ms && wake.recurrence_ms > 0) return null;
  if (wake.created_at == null) return null;
  // `Number()` d'abord : une colonne `_at` lue de SQLite peut arriver en chaîne ou en bigint.
  const pose = Number(wake.created_at);
  const ageMs = now - pose;
  // Une date de pose future ou corrompue ne fabrique pas de bandeau.
  if (!Number.isFinite(ageMs) || ageMs < STALE_WAKE_AGE_MS) return null;
  const jours = Math.floor(ageMs / 86_400_000);
  return [
    `⏳ RÉVEIL POSÉ IL Y A ${jours} JOURS (le ${fmt(pose)} ; tiré le ${fmt(now)}).`,
    `Un ponctuel dort puis parle une seule fois : rien n'a vérifié entre-temps que ce qui suit est encore`,
    `vrai. Une réécriture de l'intent n'est pas datée en base : si le texte dit « relu le … », c'est`,
    `sa date. AVANT D'EXÉCUTER, tranche sa prémisse :`,
    `  1. la dernière entrée de ton journal et ta carte de mémoire (ce que tu sais aujourd'hui) ;`,
    `  2. git log --since=${fmt(pose)} --oneline (ce qui a bougé depuis la pose) ;`,
    `  3. le fil avec ton humain depuis cette date, et le ticket cité s'il y en a un (il a pu le faire,`,
    `     ou changer d'avis).`,
    `Prémisse morte : ne l'exécute pas ; s'il attendait quelque chose de ce réveil, une ligne pour lui`,
    `dire pourquoi, sinon rien. Prémisse vivante : exécute normalement, sans redemander ce qu'il a déjà dit.`,
  ].join("\n");
}

/** Le texte tel qu'il doit partir : inchangé, ou précédé du bandeau d'âge du réveil. */
export function withStalenessBanner(wake: AgedWake, now: number, text: string, fmt: DateFormatter = utcDate): string {
  const banner = stalenessBanner(wake, now, fmt);
  return banner ? `${banner}\n\n${text}` : text;
}
