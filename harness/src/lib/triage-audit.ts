/**
 * triage-audit — relire après coup ce qu'un système d'agents a classé trop bas.
 *
 * Crainte typique d'un humain qui délègue le tri à des agents : une équipe qui SOUS-CLASSE tout, parce
 * qu'un agent qui n'interrompt jamais ne se trompe jamais visiblement. Ce module ne décide RIEN à la place
 * des agents : il relit, sur des données brutes, ce qui aurait dû monter et n'est pas monté, et le dit au
 * rapport du matin. Deux instruments :
 *
 *  1. « classées bas » : les tickets nés des dernières 24 h, créés par un agent (pas par l'humain),
 *     ouverts, NON classés P0, dont le titre touche un critère P0 écrit (panne, fuite, échéance, argent…).
 *     Pas un verdict : une liste à regarder ;
 *  2. « silence suspect » : le système a travaillé (au moins N jobs terminés en 24 h) et ne lui a rien
 *     demandé (aucune approbation, aucun ticket assigné à lui). Soit tout allait bien, soit quelque chose a
 *     été classé trop bas. 24 h de travail sans une seule demande est un signal, pas une bonne nouvelle.
 *
 * Tout est PUR. Les critères sont des données : les défauts (`DEFAULT_P0_CRITERIA`) sont un point de départ,
 * à remplacer par ceux que TON humain a écrits.
 */

/** Un mot entier, accents compris : `\b` ne connaît que [A-Za-z0-9_] (« échéance » n'aurait jamais matché). */
export const wholeWord = (alternatives: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");

export type Criterion = readonly [label: string, re: RegExp];

/** Critères P0 de départ, en mots qu'un titre de ticket porte. */
export const DEFAULT_P0_CRITERIA: ReadonlyArray<Criterion> = [
  ["service exposé", wholeWord("expos[ée]e?s?|port ouvert|exposed|open port")],
  ["panne", wholeWord("panne|down|hors service|ne r[ée]pond plus|crash|outage|plant[ée]e?")],
  ["fuite", wholeWord("fuite|leak|secret expos[ée]|token (?:visible|expos[ée]|fuit[ée])|mot de passe|password|cl[ée] api|api key")],
  ["échéance", wholeWord("aujourd'hui|ce soir|avant \\d{1,2} ?h|deadline|[ée]ch[ée]ance|today|tonight|due")],
  ["tiers qui attend", wholeWord("urgent|urgence|attend (?:ta|une) r[ée]ponse|waiting for your reply")],
  ["argent", wholeWord("paiement|payment|facture|invoice|pr[ée]l[èe]vement|virement|rembours\\p{L}*|amende|\\d+ ?(?:€|euros?|\\$|usd)")],
];

export interface TicketView {
  key: string;
  title: string;
  priority?: string | null;
  created_by?: string | null;
  created_at?: number | null;
  status: string;
}

/** Le critère P0 qu'un titre semble toucher, ou null. */
export function p0Criterion(title: string, criteria: ReadonlyArray<Criterion> = DEFAULT_P0_CRITERIA): string | null {
  return criteria.find(([, re]) => re.test(title))?.[0] ?? null;
}

/**
 * « Classé bas » : les tickets nés dans la fenêtre, créés par un acteur dont le nom commence par `agentPrefix`
 * (les agents, pas l'humain), ouverts, NON classés P0, dont le titre touche un critère P0.
 */
export function classedLow(
  tickets: readonly TicketView[],
  now: number,
  o: { agentPrefix: string; windowMs?: number; criteria?: ReadonlyArray<Criterion> },
): Array<TicketView & { criterion: string }> {
  const window = o.windowMs ?? 24 * 3_600_000;
  return tickets
    .filter(
      (a) =>
        (a.created_at ?? 0) >= now - window &&
        (a.created_by ?? "").startsWith(o.agentPrefix) &&
        a.priority !== "P0" &&
        !["done", "cancelled"].includes(a.status),
    )
    .flatMap((a) => {
      const criterion = p0Criterion(a.title, o.criteria);
      return criterion ? [{ ...a, criterion }] : [];
    });
}

/** Seuil : en dessous de ce nombre de jobs en 24 h, le système n'a pas « travaillé ». */
export const JOBS_TO_COUNT_AS_WORKING = 5;

/**
 * Silence suspect : le système a travaillé (au moins `JOBS_TO_COUNT_AS_WORKING` jobs terminés en 24 h) et ne
 * lui a rien demandé (aucune approbation, aucun ticket assigné à lui). Rend la phrase, ou null.
 */
export function suspiciousSilence(o: { jobs24h: number; requests24h: number; ticketsForHuman24h: number; minJobs?: number }): string | null {
  if (o.jobs24h < (o.minJobs ?? JOBS_TO_COUNT_AS_WORKING) || o.requests24h > 0 || o.ticketsForHuman24h > 0) return null;
  return `Silence suspect : ${o.jobs24h} jobs en 24 h et aucune demande ni ticket pour toi. Soit tout allait bien, soit quelque chose a été classé trop bas.`;
}

/** Les lignes du rapport du matin : silence suspect, puis au plus `max` « classées bas ». « rien » sinon. */
export function morningLines(silence: string | null, low: ReadonlyArray<TicketView & { criterion: string }>, max = 3): string[] {
  const l: string[] = [];
  if (silence) l.push(silence);
  for (const a of low.slice(0, max)) l.push(`${a.key} « ${a.title.slice(0, 70)} » : classé ${a.priority ?? "sans priorité"}, touche « ${a.criterion} »`);
  if (low.length > max) l.push(`+${low.length - max} autre(s) classé(s) bas`);
  return l.length ? l : ["rien"];
}
