/**
 * job-eta : un délai annoncé pour un job se CALCULE. PUR.
 *
 * Piège : laisser le modèle annoncer « dans 30 à 45 min » alors que la file est gelée par un drainage
 * derrière trois longs jobs, ou au contraire répondre en deux minutes après avoir annoncé une heure. Le
 * délai venait du modèle, pas de l'état. Ici : position dans la file, jobs en vol et leur âge, concurrence,
 * drainage de rechargement en cours. Et si l'annonce est dépassée de 50 %, une ligne d'état part UNE fois
 * (`relancesDues`).
 */

export interface EtatFile {
  /** Ids des jobs en attente (pending), dans l'ordre où le runner les prendra. */
  enFile: readonly number[];
  /** Âge (ms) de chaque job en vol. */
  agesEnVol: readonly number[];
  concurrence: number;
  /** Durée type d'un job (ms) : médiane des derniers jobs finis. */
  dureeTypeMs: number;
  /** Un drainage de rechargement gèle la file : fin estimée (epoch ms), ou null. */
  drainageJusqua: number | null;
}

export interface Estimation {
  etat: "en-vol" | "en-file" | "inconnu";
  position: number | null;
  departMs: number;
  finMs: number;
}

/** Durée type par défaut, sans historique : 40 min. */
export const DUREE_TYPE_DEFAUT_MS = 40 * 60_000;
/** Un job en vol qui a déjà dépassé la durée type est supposé finir au plus tôt dans ce délai. */
const FIN_MIN_MS = 5 * 60_000;

/** Médiane d'une liste de durées (ms) ; défaut sans données. PUR. */
export function dureeType(durees: readonly number[]): number {
  const d = durees.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!d.length) return DUREE_TYPE_DEFAUT_MS;
  return d[Math.floor(d.length / 2)]!;
}

/**
 * Départ et fin estimés du job `id`. Modèle : chaque slot se libère quand son job en vol atteint la durée
 * type (au plus tôt dans 5 min s'il l'a déjà dépassée) ; les jobs en file devant prennent les slots dans
 * l'ordre ; rien ne part avant la fin d'un drainage. PUR.
 */
export function estimer(id: number, f: EtatFile, now: number, enVol = false, ageMs = 0): Estimation {
  const duree = Math.max(60_000, f.dureeTypeMs);
  if (enVol) {
    const fin = now + Math.max(FIN_MIN_MS, duree - ageMs);
    return { etat: "en-vol", position: null, departMs: now - ageMs, finMs: fin };
  }
  const pos = f.enFile.indexOf(id);
  if (pos < 0) return { etat: "inconnu", position: null, departMs: now, finMs: now + duree };
  const plancher = Math.max(now, f.drainageJusqua ?? 0);
  const n = Math.max(1, f.concurrence);
  const slots: number[] = [];
  for (let i = 0; i < n; i++) {
    const age = f.agesEnVol[i];
    slots.push(age === undefined ? now : now + Math.max(FIN_MIN_MS, duree - age));
  }
  let depart = plancher;
  for (let k = 0; k <= pos; k++) {
    slots.sort((a, b) => a - b);
    depart = Math.max(plancher, slots[0]!);
    slots[0] = depart + duree;
  }
  return { etat: "en-file", position: pos + 1, departMs: depart, finMs: depart + duree };
}

/** HH:MM dans le fuseau donné (UTC par défaut). PUR. */
export function hhmm(ms: number, tz = "UTC"): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** La ligne d'état d'un job, telle qu'elle s'annonce. PUR. */
export function ligneEtat(id: number, e: Estimation, f: EtatFile, now: number, tz?: string): string {
  const drain = f.drainageJusqua ? `, file gelée par un rechargement jusqu'à ~${hhmm(f.drainageJusqua, tz)}` : "";
  if (e.etat === "en-vol") return `job #${id} : en cours depuis ${Math.round((now - e.departMs) / 60_000)} min, fin estimée ${hhmm(e.finMs, tz)}`;
  if (e.etat === "inconnu") return `job #${id} : ni en file ni en vol (fini, ou inconnu)`;
  return `job #${id} : en file, position ${e.position}/${f.enFile.length}, ${f.agesEnVol.length}/${f.concurrence} en vol${drain} → départ estimé ${hhmm(e.departMs, tz)}, fin estimée ${hhmm(e.finMs, tz)}`;
}

/** Une annonce de délai faite sur un fil (ticket, conversation). */
export interface Annonce {
  job: number;
  /** Où l'annonce a été faite (identifiant libre : ticket, chat…). */
  fil: string;
  annonceeA: number;
  minutes: number;
  relanceeA?: number;
}

/** Les annonces dépassées de 50 % (job pas fini, jamais relancées). PUR. */
export function relancesDues(annonces: readonly Annonce[], jobsFinis: ReadonlySet<number>, now: number): Annonce[] {
  return annonces.filter((a) => !a.relanceeA && !jobsFinis.has(a.job) && now >= a.annonceeA + 1.5 * a.minutes * 60_000);
}
