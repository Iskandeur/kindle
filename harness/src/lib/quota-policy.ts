/**
 * quota-policy : ce que le daemon FAIT du quota Claude mesuré.
 *
 * `claude-quota.ts` capte le `rate_limit_event` du binaire et garde la dernière mesure. Ce module en tire le
 * reste. L'abonnement est PARTAGÉ avec les sessions Claude Code de ton humain : la politique vise à lui laisser
 * de la marge, pas à remplir la fenêtre.
 *
 *  1. HISTORIQUE : `recordQuotaMeasure` : chaque mesure va dans un journal (+ dernière valeur, + vue).
 *  2. INJECTION : `quotaContextLine` : une ligne en tête de chaque réveil et de chaque job.
 *  3. PROJECTION : `projectWindow` : au rythme récent (5 h) ou moyen depuis le reset (semaine, lissé), la
 *     fenêtre touche-t-elle son mur avant son reset ?
 *  4. ALERTES : `quotaAlerts` : 5 h au-dessus d'un seuil, semaine projetée pleine avant reset, dépassement
 *     payant (overage). Une fois par franchissement (état persisté), jamais de spam.
 *  5. POLITIQUE : `decideQuotaPolicy` : différer les jobs non urgents, passer le fond à un modèle plus léger,
 *     plafonner l'effort, basculer sur un moteur de repli AVANT le 429, signaler la marge qui sera perdue.
 *  6. ATTRIBUTION : `attributeByOrigin` : qui mange le quota (conversation, tâches de fond, jobs…).
 *
 * Seuils réglables (`quotaPolicyConfig`, variables `QUOTA_*`), interrupteur général dans le magasin
 * (`quota_policy = off`). Tout est PUR sauf `recordQuotaMeasure` et `createPolicyReader`, qui lisent/écrivent
 * le magasin injecté (`QuotaStore`).
 *
 * Quatre pièges que ce module encode :
 *  - la fenêtre 5 h ne fait que MONTER jusqu'à son reset : une mesure haute reste vraie tant que le reset n'est
 *    pas passé, quel que soit son âge ; une mesure BASSE, elle, vieillit (« marge à consommer » exige une
 *    mesure fraîche) ;
 *  - le rythme hebdomadaire est LISSÉ (tout ce qui s'est consommé depuis le reset, rapporté au temps écoulé) :
 *    les dernières 24 h ne font pas la semaine (une journée à +36 points juste après un reset projetait 100 %) ;
 *  - un reset manuel en cours de semaine (l'utilisation chute de plus de 5 points dans la MÊME fenêtre) fait
 *    repartir le rythme de la chute : ce qui précède ne compte plus ;
 *  - la contrainte hebdomadaire prime sur la marge 5 h : une semaine déjà au-dessus de sa cible ne « consomme »
 *    pas, même quand la fenêtre 5 h est presque vide.
 */
import { readQuota, shortDuration, storeQuota, type QuotaSnapshot, type StoredQuota } from "./claude-quota.ts";

export const FIVE_HOUR_MS = 5 * 3600_000;
export const SEVEN_DAY_MS = 7 * 24 * 3600_000;
/** Au-delà, la ligne injectée porte ⚠️ (mesure périmée). */
export const QUOTA_STALE_MS = 2 * 3600_000;
/** Deux `resetsAt` à moins de ça désignent la même fenêtre (le binaire arrondit, on tolère). */
const SAME_WINDOW_TOLERANCE_MS = 10 * 60_000;
/** Historique conseillé en base. */
export const QUOTA_LOG_RETENTION_MS = 60 * 24 * 3600_000;

export const POLICY_KEY = "quota_policy"; // "off" = politique désactivée (mesure, injection, alertes restent)
export const ALERT_STATE_KEY = "claude_quota_alert_state";
export const VIEW_KEY = "claude_quota_view";

/** Une ligne du journal de quota (une mesure). Les `first*` portent le premier évènement du même processus. */
export interface QuotaLogRow {
  id?: number;
  ts: number;
  /** D'où vient la mesure : `conv:principal`, `job`, `wake`… (sans identifiant de chat). */
  origin: string;
  fiveUtil: number | null;
  fiveReset: number | null;
  sevenUtil: number | null;
  sevenReset: number | null;
  status: string | null;
  overage: boolean | null;
  overageStatus: string | null;
  firstFiveUtil: number | null;
  firstSevenUtil: number | null;
  events: number;
}

/** Surface du stockage attendue : un magasin clé/valeur et un journal de mesures. */
export interface QuotaStore {
  getSetting(k: string): string | null;
  setSetting(k: string, v: string): void;
  recordQuotaLog(r: Omit<QuotaLogRow, "id">): number;
  quotaLogSince(sinceMs: number): QuotaLogRow[];
  pruneQuotaLog?(olderThanMs: number, now?: number): number;
}

/** Seuils. Défauts PRUDENTS : rien ne bouge tant que la fenêtre 5 h n'a pas passé 80 %, et seule une semaine
 *  projetée pleine avant son reset fait changer de comportement. */
export interface QuotaPolicyConfig {
  /** 5 h ≥ ça : les jobs non urgents attendent le reset 5 h. */
  defer5h: number;
  /** 5 h ≥ ça : alerte (une par fenêtre). */
  alert5h: number;
  /** 5 h ≥ ça : un job qui partirait sur Claude part sur le moteur de repli (bascule AVANT le 429). */
  preempt5h: number;
  /** Semaine en avance sur le rythme linéaire de plus de ça (fraction) : le fond passe au modèle léger. */
  aheadMargin: number;
  /** « Use it or lose it » : 5 h sous ce seuil ET reset 5 h dans moins de `useIt5hResetMs`. */
  useIt5hMax: number;
  useIt5hResetMs: number;
  /** « Use it or lose it » : semaine sous ce seuil ET reset hebdo dans moins de `useIt7dResetMs`. */
  useIt7dMax: number;
  useIt7dResetMs: number;
  /** Recul maximal du rythme hebdo (la semaine entière, sinon depuis le reset) ; 90 min pour la 5 h. */
  lookback7dMs: number;
  lookback5hMs: number;
  /** Effort maximal imposé aux jobs en mode économie. */
  economyEffort: string;
  /** Pas de projection hebdo avant ce temps écoulé depuis le reset : une journée atypique ne fait pas la semaine. */
  minElapsed7dMs: number;
  /** Recul minimal quand la semaine repart d'un reset manuel (pas de pic de début de semaine à lisser). */
  minElapsedClickMs: number;
  /** Échelle des leviers, en rapport fin de semaine projetée / mur : ≥ 1 fond au modèle léger, ≥ effortRatio
   *  + effort plafonné, ≥ wallRatio : mur atteint ou approché (alerte, mêmes leviers). */
  effortRatio: number;
  wallRatio: number;
  /** Modèle des jobs de fond quand la politique les rétrograde. */
  backgroundModel: string;
  /** Fuseau des heures affichées. */
  timeZone: string;
}

function envNum(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const v = env[k];
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function quotaPolicyConfig(env: NodeJS.ProcessEnv = process.env): QuotaPolicyConfig {
  return {
    defer5h: envNum(env, "QUOTA_DEFER_5H", 0.8),
    alert5h: envNum(env, "QUOTA_ALERT_5H", 0.85),
    preempt5h: envNum(env, "QUOTA_PREEMPT_5H", 0.95),
    aheadMargin: envNum(env, "QUOTA_AHEAD_MARGIN", 0.1),
    useIt5hMax: envNum(env, "QUOTA_USEIT_5H_MAX", 0.5),
    useIt5hResetMs: envNum(env, "QUOTA_USEIT_5H_RESET_MIN", 60) * 60_000,
    useIt7dMax: envNum(env, "QUOTA_USEIT_7D_MAX", 0.85),
    useIt7dResetMs: envNum(env, "QUOTA_USEIT_7D_RESET_H", 24) * 3600_000,
    lookback7dMs: envNum(env, "QUOTA_LOOKBACK_7D_H", 168) * 3600_000,
    lookback5hMs: envNum(env, "QUOTA_LOOKBACK_5H_MIN", 90) * 60_000,
    economyEffort: env.QUOTA_ECONOMY_EFFORT?.trim() || "medium",
    minElapsed7dMs: envNum(env, "QUOTA_MIN_ELAPSED_7D_H", 36) * 3600_000,
    minElapsedClickMs: envNum(env, "QUOTA_MIN_ELAPSED_CLICK_H", 10) * 3600_000,
    effortRatio: envNum(env, "QUOTA_EFFORT_RATIO", 1.25),
    wallRatio: envNum(env, "QUOTA_WALL_RATIO", 1.6),
    backgroundModel: env.QUOTA_BACKGROUND_MODEL?.trim() || "sonnet",
    timeZone: env.QUOTA_TZ?.trim() || "UTC",
  };
}

// ── Projection ──────────────────────────────────────────────────────────────────────────────────

export interface QuotaPoint {
  ts: number;
  util: number;
  resetMs: number | null;
}

export function sameWindow(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS;
}

/** Chute d'utilisation (fraction) qui dit « un reset manuel a été pris » ; en dessous, du bruit de mesure. */
export const MANUAL_RESET_DROP = 0.05;

/** Points d'UNE fenêtre (5 h ou semaine) tirés de l'historique. PUR. */
export function windowPoints(rows: readonly QuotaLogRow[], w: "five" | "seven"): QuotaPoint[] {
  const out: QuotaPoint[] = [];
  for (const r of rows) {
    const util = w === "five" ? r.fiveUtil : r.sevenUtil;
    if (util === null || !Number.isFinite(util)) continue;
    out.push({ ts: r.ts, util, resetMs: w === "five" ? r.fiveReset : r.sevenReset });
  }
  return out;
}

/**
 * Le moment où un reset manuel de la semaine a été pris : le premier couple consécutif, dans la MÊME fenêtre
 * hebdomadaire, où l'utilisation baisse de plus de `seuil`. Un passage de fenêtre change `resetMs` et ne
 * compte pas. Rend l'epoch ms de la mesure qui montre la chute, ou null. PUR.
 */
export function manualResetTakenAt(rows: readonly QuotaLogRow[], seuil = MANUAL_RESET_DROP): number | null {
  const pts = windowPoints(rows, "seven");
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.resetMs !== null && b.resetMs !== null && sameWindow(a.resetMs, b.resetMs) && a.util - b.util > seuil) return b.ts;
  }
  return null;
}

/** Consommation entre deux points : la hausse si même fenêtre, sinon (fenêtre remise à zéro entre les deux)
 *  tout ce que le second a consommé depuis son reset. Jamais négatif. PUR. */
export function stepDelta(a: QuotaPoint, b: QuotaPoint): number {
  if (sameWindow(a.resetMs, b.resetMs)) return Math.max(0, b.util - a.util);
  return Math.max(0, b.util);
}

/** Rythme de consommation (fraction de fenêtre par heure) sur les points des `lookbackMs` derniers.
 *  `null` si moins de deux points ou un intervalle trop court pour dire quoi que ce soit. PUR. */
export function consumptionRate(points: readonly QuotaPoint[], nowMs: number, lookbackMs: number, minSpanMs: number): number | null {
  const pts = points.filter((p) => p.ts >= nowMs - lookbackMs && p.ts <= nowMs);
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1]!.ts - pts[0]!.ts;
  if (span < minSpanMs) return null;
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += stepDelta(pts[i - 1]!, pts[i]!);
  return sum / (span / 3600_000);
}

/** Rythme hebdo LISSÉ : tout ce qui s'est consommé DEPUIS LE RESET (plafonné à `lookbackMs`), rapporté au temps
 *  écoulé depuis ce reset. Un reset manuel (chute de plus de `MANUAL_RESET_DROP` dans la même fenêtre) fait
 *  repartir le rythme de la chute. `null` tant que moins de `minElapsedMs` (ou `minElapsedClickMs` après un
 *  reset manuel) se sont écoulés : trop tôt pour dire. PUR. */
export function weeklyRate(
  points: readonly QuotaPoint[],
  resetMs: number | null,
  util: number,
  nowMs: number,
  lookbackMs: number,
  minElapsedMs: number,
  minElapsedClickMs: number = minElapsedMs,
): number | null {
  if (resetMs === null) return consumptionRate(points, nowMs, lookbackMs, 3 * 3600_000);
  let start = Math.max(resetMs - SEVEN_DAY_MS, nowMs - lookbackMs);
  let inWin = points.filter((p) => sameWindow(p.resetMs, resetMs) && p.ts <= nowMs);
  let clicked = false;
  // Un reset manuel garde le même `resetMs` : la semaine repart de zéro à ce moment-là, et ce qui précède n'est
  // plus à compter. Le rythme part de la mesure qui montre la chute.
  for (let i = inWin.length - 1; i > 0; i--) {
    if (inWin[i - 1]!.util - inWin[i]!.util > MANUAL_RESET_DROP) {
      inWin = inWin.slice(i);
      start = Math.max(start, inWin[0]!.ts);
      clicked = true;
      break;
    }
  }
  const elapsed = nowMs - start;
  if (elapsed < (clicked ? Math.min(minElapsedMs, minElapsedClickMs) : minElapsedMs)) return null;
  let consumed = util;
  if (inWin.length > 0) {
    consumed = inWin[0]!.util;
    for (let i = 1; i < inWin.length; i++) consumed += stepDelta(inWin[i - 1]!, inWin[i]!);
    // La dernière mesure fait foi si l'historique est plus court que la fenêtre (ou si une chute a eu lieu).
    consumed = Math.max(consumed, util);
  }
  return consumed / (elapsed / 3600_000);
}

export interface WindowProjection {
  util: number;
  resetMs: number | null;
  /** Fraction de fenêtre consommée par heure, au rythme récent (null : pas assez de recul). */
  ratePerHour: number | null;
  /** Instant où, à ce rythme, la fenêtre atteint 100 % (null : rythme nul ou inconnu). */
  hitAtMs: number | null;
  /** 100 % atteint avant le reset, à ce rythme. */
  hitsBeforeReset: boolean;
  /** Utilisation qu'aurait un rythme LINÉAIRE parfait à cet instant de la fenêtre (null sans reset). */
  paceUtil: number | null;
  /** util − paceUtil : > 0 = en avance sur le rythme (on consomme plus vite que la fenêtre ne s'écoule). */
  ahead: number | null;
}

/** Projection d'une fenêtre. `current` = la dernière mesure stockée. PUR. */
export function projectWindow(
  current: { utilization: number; resetsAtMs: number | null } | null,
  points: readonly QuotaPoint[],
  windowMs: number,
  nowMs: number,
  lookbackMs: number,
  minElapsed7dMs = 36 * 3600_000,
  minElapsedClickMs: number = minElapsed7dMs,
): WindowProjection | null {
  if (!current) return null;
  const resetMs = current.resetsAtMs;
  // Fenêtre déjà remise à zéro depuis la mesure : on ne projette pas une valeur morte.
  if (resetMs !== null && resetMs <= nowMs) return null;
  const util = current.utilization;
  const rate =
    windowMs === SEVEN_DAY_MS
      ? weeklyRate(points, resetMs, util, nowMs, lookbackMs, minElapsed7dMs, minElapsedClickMs)
      : consumptionRate(points, nowMs, lookbackMs, Math.min(lookbackMs / 4, 20 * 60_000));
  let hitAtMs: number | null = null;
  if (util >= 1) hitAtMs = nowMs;
  else if (rate !== null && rate > 0) hitAtMs = nowMs + ((1 - util) / rate) * 3600_000;
  const hitsBeforeReset = hitAtMs !== null && resetMs !== null && hitAtMs < resetMs;
  let paceUtil: number | null = null;
  if (resetMs !== null) {
    const elapsed = windowMs - (resetMs - nowMs);
    paceUtil = Math.min(1, Math.max(0, elapsed / windowMs));
  }
  return { util, resetMs, ratePerHour: rate, hitAtMs, hitsBeforeReset, paceUtil, ahead: paceUtil === null ? null : util - paceUtil };
}

export interface QuotaProjections {
  five: WindowProjection | null;
  seven: WindowProjection | null;
}

export function projectAll(q: StoredQuota, rows: readonly QuotaLogRow[], nowMs: number, cfg: QuotaPolicyConfig): QuotaProjections {
  return {
    five: projectWindow(q.fiveHour, windowPoints(rows, "five"), FIVE_HOUR_MS, nowMs, cfg.lookback5hMs),
    seven: projectWindow(q.sevenDay, windowPoints(rows, "seven"), SEVEN_DAY_MS, nowMs, cfg.lookback7dMs, cfg.minElapsed7dMs, cfg.minElapsedClickMs),
  };
}

// ── Politique de charge ─────────────────────────────────────────────────────────────────────────

export type QuotaMode = "off" | "inconnu" | "normal" | "différer" | "économie" | "consommer";

export interface QuotaPolicy {
  mode: QuotaMode;
  /** Les jobs non urgents (ni maillon de chaîne, ni `[urgent]`) ne sont pas réclamés. */
  deferJobs: boolean;
  /** Jusqu'à quand (reset 5 h), si `deferJobs`. */
  deferUntilMs: number | null;
  /** Un job qui partirait sur Claude part sur le moteur de repli (avant le 429). */
  preemptFallback: boolean;
  /** Effort plafonné pour les jobs (`economyEffort`), null = pas de plafond. */
  effortCap: string | null;
  /** Premier levier : le travail de fond (jobs sans modèle imposé) tourne au modèle léger. Les conversations
   *  avec ton humain, la rédaction et les relectures de garde-fous (modèle imposé) restent au modèle fort. */
  lightJobs: boolean;
  /** Échelle hebdo : 0 rien, 1 modèle léger, 2 + effort, 3 mur atteint ou approché (mêmes leviers que 2). */
  weekLevel: 0 | 1 | 2 | 3;
  /** Fin de semaine projetée (1 = 100 points) ; null sans projection. */
  weekProjectedEnd: number | null;
  /** Marge qui sera perdue au reset : bon moment pour un gros chantier. Informatif. */
  useIt: boolean;
  reasons: string[];
}

const NO_POLICY: Omit<QuotaPolicy, "mode" | "reasons"> = {
  deferJobs: false,
  deferUntilMs: null,
  preemptFallback: false,
  effortCap: null,
  lightJobs: false,
  weekLevel: 0,
  weekProjectedEnd: null,
  useIt: false,
};

function pct(u: number): string {
  return `${Math.round(u * 100)} %`;
}

/** Où va la semaine : fin projetée et échelle de leviers (0 rien · 1 modèle léger · 2 + effort · 3 mur) selon
 *  projeté / mur (le mur est 100 points). PUR. */
export function weekAssessment(
  seven: WindowProjection | null,
  nowMs: number,
  cfg: QuotaPolicyConfig,
): { level: 0 | 1 | 2 | 3; projectedEnd: number | null } {
  if (!seven || seven.resetMs === null) return { level: 0, projectedEnd: null };
  if (seven.util >= 1) return { level: 3, projectedEnd: seven.util };
  if (seven.ratePerHour === null) return { level: 0, projectedEnd: null };
  const projectedEnd = seven.util + (seven.ratePerHour * Math.max(0, seven.resetMs - nowMs)) / 3600_000;
  const level = projectedEnd >= cfg.wallRatio ? 3 : projectedEnd >= cfg.effortRatio ? 2 : projectedEnd >= 1 ? 1 : 0;
  return { level, projectedEnd };
}

/** La semaine est-elle déjà au-dessus de sa cible linéaire (fin à 100 % au reset) ? Marche aussi quand le
 *  rythme est `null` (fenêtre aveugle) : on retombe sur l'avance `ahead` (util − pace). Rend la raison ou null. PUR. */
export function weekOverTarget(seven: WindowProjection | null, nowMs: number): string | null {
  if (!seven || seven.resetMs === null) return null;
  if (seven.ratePerHour !== null) {
    const hoursLeft = Math.max(0, seven.resetMs - nowMs) / 3600_000;
    if (hoursLeft <= 0) return null;
    const target = Math.max(0, 1 - seven.util) / hoursLeft; // rythme qui finit pile à 100 %
    if (seven.ratePerHour > target) return `rythme hebdo ${(seven.ratePerHour * 100).toFixed(2)} pts/h > cible ${(target * 100).toFixed(2)} : pas de « consommer » sur la seule marge 5 h`;
    return null;
  }
  if (seven.ahead !== null && seven.ahead > 0) return `semaine en avance de ${Math.round(seven.ahead * 100)} pts (rythme encore inconnu) : pas de « consommer » sur la seule marge 5 h`;
  return null;
}

/** Décision de politique. PUR. `enabled=false` : mode "off", aucun levier. */
export function decideQuotaPolicy(
  q: StoredQuota,
  proj: QuotaProjections,
  nowMs: number,
  cfg: QuotaPolicyConfig,
  enabled = true,
): QuotaPolicy {
  if (!enabled) return { mode: "off", ...NO_POLICY, reasons: ["politique désactivée (quota_policy=off)"] };
  if (q.seenAtMs === null) return { mode: "inconnu", ...NO_POLICY, reasons: ["aucune mesure"] };
  const p: QuotaPolicy = { mode: "normal", ...NO_POLICY, reasons: [] };
  const five = q.fiveHour;
  // Une mesure HAUTE reste vraie tant que le reset n'est pas passé, quel que soit son âge.
  const fiveLive = five !== null && five.resetsAtMs !== null && five.resetsAtMs > nowMs;
  if (fiveLive && five.utilization >= cfg.defer5h) {
    p.deferJobs = true;
    p.deferUntilMs = five.resetsAtMs;
    p.reasons.push(`5 h à ${pct(five.utilization)} ≥ ${pct(cfg.defer5h)} : jobs non urgents différés jusqu'au reset`);
  }
  if (fiveLive && five.utilization >= cfg.preempt5h) {
    p.preemptFallback = true;
    p.reasons.push(`5 h à ${pct(five.utilization)} ≥ ${pct(cfg.preempt5h)} : nouveaux jobs sur le moteur de repli avant le 429`);
  }
  const seven = proj.seven;
  const wk = weekAssessment(seven, nowMs, cfg);
  p.weekLevel = wk.level;
  p.weekProjectedEnd = wk.projectedEnd;
  const endTxt = wk.projectedEnd !== null ? `fin de semaine projetée à ${pct(wk.projectedEnd)} au rythme moyen depuis le reset` : "";
  if (wk.level >= 1) {
    p.lightJobs = true;
    p.reasons.push(`${endTxt} : le fond passe au modèle léger (conversations et relectures restent au modèle fort)`);
  }
  if (wk.level >= 2) {
    p.effortCap = cfg.economyEffort;
    p.reasons.push(`projection ≥ ${Math.round(cfg.effortRatio * 100)} % du mur : jobs plafonnés en effort ${cfg.economyEffort}`);
  }
  if (wk.level >= 3) {
    p.reasons.push(`projection ≥ ${Math.round(cfg.wallRatio * 100)} % du mur : pas d'autre recours que le modèle léger et l'effort plafonné`);
  }
  // En avance sur le rythme linéaire : un levier léger seulement.
  if (wk.level === 0 && seven && seven.ratePerHour !== null && seven.ahead !== null && seven.ahead > cfg.aheadMargin) {
    p.lightJobs = true;
    p.reasons.push(`semaine en avance de ${Math.round(seven.ahead * 100)} pts sur le rythme : le fond passe au modèle léger`);
  }
  const fresh = nowMs - q.seenAtMs <= 30 * 60_000;
  // La contrainte hebdo prime sur la marge 5 h.
  const wkOver = weekOverTarget(seven, nowMs);
  if (wkOver) p.reasons.push(wkOver);
  if (!p.deferJobs && fresh) {
    if (!wkOver && fiveLive && five.utilization < cfg.useIt5hMax && five.resetsAtMs! - nowMs <= cfg.useIt5hResetMs) {
      p.useIt = true;
      p.reasons.push(`5 h à ${pct(five.utilization)}, reset dans ${shortDuration(five.resetsAtMs! - nowMs)} : marge qui sera perdue`);
    }
    const s = q.sevenDay;
    if (!p.effortCap && !p.lightJobs && s && s.resetsAtMs !== null && s.resetsAtMs > nowMs && s.utilization < cfg.useIt7dMax && s.resetsAtMs - nowMs <= cfg.useIt7dResetMs) {
      p.useIt = true;
      p.reasons.push(`semaine à ${pct(s.utilization)}, reset dans ${shortDuration(s.resetsAtMs - nowMs)} : gros chantiers maintenant`);
    }
  }
  p.mode = p.deferJobs ? "différer" : p.effortCap || p.lightJobs ? "économie" : p.useIt ? "consommer" : "normal";
  return p;
}

/** Un job échappe-t-il au report ? Les maillons de chaîne (qui ont leur propre horaire) et les jobs dont
 *  l'intent commence par `[urgent]`. PUR. */
export function jobBypassesDefer(job: { chainKind?: string | null; intent: string }): boolean {
  return !!job.chainKind || /^\s*\[urgent\]/i.test(job.intent);
}

// ── Affichage / injection ───────────────────────────────────────────────────────────────────────

function dayOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** « 19:20 » si c'est aujourd'hui dans le fuseau, sinon « lun. 20:00 ». PUR. */
export function compactInstant(ms: number, nowMs: number, tz = "UTC"): string {
  const d = new Date(ms);
  const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  if (dayOf(ms, tz) === dayOf(nowMs, tz)) return hm;
  const wd = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "short" }).format(d);
  return `${wd} ${hm}`;
}

function windowPart(label: string, w: { utilization: number; resetsAtMs: number | null } | null, nowMs: number, tz: string): string {
  if (!w) return `${label} : ?`;
  if (w.resetsAtMs !== null && w.resetsAtMs <= nowMs) return `${label} : remis à zéro (${compactInstant(w.resetsAtMs, nowMs, tz)})`;
  return `${label} : ${pct(w.utilization)}${w.resetsAtMs !== null ? ` (reset ${compactInstant(w.resetsAtMs, nowMs, tz)})` : ""}`;
}

/** Le mot « rythme » de la ligne : où va la semaine. PUR. */
export function paceWord(proj: QuotaProjections, nowMs: number, cfg: QuotaPolicyConfig): string {
  const s = proj.seven;
  if (!s) return "rythme : ?";
  if (s.ratePerHour === null) return "rythme : trop tôt dans la semaine";
  if (s.hitsBeforeReset && s.hitAtMs !== null) return `rythme : ⚠️ 100 % prévu ${compactInstant(s.hitAtMs, nowMs, cfg.timeZone)}, avant le reset`;
  if (s.ahead !== null && s.ahead > cfg.aheadMargin) return `rythme : en avance de ${Math.round(s.ahead * 100)} pts`;
  if (s.ahead !== null && s.ahead < -0.25) return "rythme : large marge";
  return "rythme : OK";
}

/** La ligne injectée dans chaque réveil et chaque job. PUR. */
export function formatQuotaContextLine(q: StoredQuota, proj: QuotaProjections, policy: QuotaPolicy, nowMs: number, cfg: QuotaPolicyConfig): string {
  // Sans mesure, rien à dire : la ligne n'apparaît qu'une fois le premier tour mesuré.
  if (q.seenAtMs === null) return "";
  const age = nowMs - q.seenAtMs;
  const parts = [
    windowPart("5 h", q.fiveHour, nowMs, cfg.timeZone),
    windowPart("semaine", q.sevenDay, nowMs, cfg.timeZone),
    paceWord(proj, nowMs, cfg),
    `${age > QUOTA_STALE_MS ? "⚠️ mesure périmée, " : ""}mesuré il y a ${shortDuration(age)}`,
  ];
  if (q.isUsingOverage) parts.push("⚠️ EN DÉPASSEMENT PAYANT (overage)");
  let line = `[Quota Claude] ${parts.join(" · ")}`;
  if (policy.mode !== "normal" && policy.mode !== "off" && policy.mode !== "inconnu") {
    line += `\n[Politique quota : ${policy.mode}] ${policy.reasons.join(" ; ")}.`;
    if (policy.mode === "différer" || policy.mode === "économie")
      line += " L'abonnement est partagé avec les sessions de ton humain : sobriété (pas de gros fan-out). Leviers dans l'ordre : fond au modèle léger, puis effort plafonné.";
  }
  return line;
}

// ── Alertes ─────────────────────────────────────────────────────────────────────────────────────

export interface QuotaAlertState {
  /** Reset de la fenêtre 5 h déjà alertée (> seuil). */
  five?: number | null;
  /** Reset de la semaine déjà alertée (projection pleine avant reset). */
  week?: number | null;
  overage?: boolean | null;
  overageStatus?: string | null;
}

/** Ce qu'il faut dire à ton humain, et le nouvel état. Une alerte par franchissement. PUR. */
export function quotaAlerts(
  prev: QuotaAlertState,
  q: StoredQuota,
  proj: QuotaProjections,
  nowMs: number,
  cfg: QuotaPolicyConfig,
): { texts: string[]; next: QuotaAlertState } {
  const next: QuotaAlertState = { ...prev };
  const texts: string[] = [];
  const tz = cfg.timeZone;
  const five = q.fiveHour;
  if (five && five.resetsAtMs !== null && five.resetsAtMs > nowMs && five.utilization >= cfg.alert5h && !sameWindow(prev.five ?? null, five.resetsAtMs)) {
    next.five = five.resetsAtMs;
    texts.push(
      `⚠️ Quota Claude : fenêtre 5 h à ${pct(five.utilization)}, reset ${compactInstant(five.resetsAtMs, nowMs, tz)} (dans ${shortDuration(five.resetsAtMs - nowMs)}). ` +
        `Je diffère mes jobs non urgents jusque-là, tes sessions passent devant.`,
    );
  }
  const s = proj.seven;
  const wk = weekAssessment(s, nowMs, cfg);
  if (s && wk.level >= 1 && wk.projectedEnd !== null && s.resetMs !== null && !sameWindow(prev.week ?? null, s.resetMs)) {
    next.week = s.resetMs;
    const levers = ["le fond au modèle léger"];
    if (wk.level >= 2) levers.push(`l'effort ${cfg.economyEffort}`);
    texts.push(
      `📉 Quota Claude semaine : ${pct(s.util)}, au rythme moyen depuis le reset (pas les dernières 24 h), fin de semaine vers ${pct(wk.projectedEnd)} au reset (${compactInstant(s.resetMs, nowMs, tz)}). ` +
        `Leviers, dans cet ordre : ${levers.join(", puis ")}. Tes conversations avec moi et mes relectures de garde-fous restent au modèle fort.`,
    );
  }
  // Sécurité de facturation : tout de suite, sans seuil. Premier passage (état vide) : on n'alerte que sur un
  // overage EN COURS, pas sur la découverte d'un statut qui était déjà là.
  if (q.isUsingOverage === true && prev.overage !== true) {
    texts.push(`🚨 Quota Claude : l'abonnement est en dépassement payant (isUsingOverage=true). Statut overage : ${q.overageStatus ?? "?"}. À regarder tout de suite.`);
  }
  const os = q.overageStatus ?? null;
  if (os !== null && prev.overageStatus != null && prev.overageStatus !== os && q.isUsingOverage !== true) {
    texts.push(`🚨 Quota Claude : le statut overage a changé, ${prev.overageStatus} → ${os}. Vérifie que rien ne peut être facturé hors abonnement.`);
  }
  if (q.isUsingOverage !== null) next.overage = q.isUsingOverage;
  if (os !== null) next.overageStatus = os;
  return { texts, next };
}

// ── Attribution ─────────────────────────────────────────────────────────────────────────────────

/** Bucket où tombe ce qui s'est consommé ENTRE deux tours mesurés (tes sessions à lui, ou un tour concurrent
 *  qui rapportera plus tard) quand le tour suivant donne son premier ET dernier évènement. */
export const GAP_BUCKET = "entre deux tours (humain, ou concurrent)";

/** Catégorie par défaut d'une origine : la partie avant le premier `:` (`conv:principal` : `conv`). PUR. */
export function defaultOriginCategory(origin: string): string {
  if (origin === GAP_BUCKET) return GAP_BUCKET;
  return origin.split(":", 1)[0] || "autre";
}

export interface AttributionLine {
  key: string;
  /** Points de fenêtre 5 h consommés (somme des hausses, en fraction : 0.01 = 1 point). */
  five: number;
  /** Points de semaine. */
  seven: number;
  runs: number;
}

/**
 * Qui a consommé quoi depuis `sinceMs`. Mesure par différences entre mesures CONSÉCUTIVES (toutes origines
 * confondues) : la somme des hausses = la consommation réelle de la fenêtre, sans double compte. Une mesure qui
 * porte son premier évènement (`first*`) sépare sa propre consommation (dernier − premier) de ce qui s'est passé
 * avant elle (`GAP_BUCKET`) ; sinon toute la hausse lui va. Granularité 1 % : n'a de sens qu'agrégé sur des
 * heures. `categoryOf` regroupe les origines (défaut : `defaultOriginCategory`) ; passe l'identité pour le détail. PUR.
 */
export function attributeByOrigin(
  rows: readonly QuotaLogRow[],
  sinceMs: number,
  categoryOf: (origin: string) => string = defaultOriginCategory,
): AttributionLine[] {
  const acc = new Map<string, AttributionLine>();
  const add = (k: string, five: number, seven: number, run: boolean): void => {
    const l = acc.get(k) ?? { key: k, five: 0, seven: 0, runs: 0 };
    l.five += five;
    l.seven += seven;
    if (run) l.runs++;
    acc.set(k, l);
  };
  let prev: QuotaLogRow | null = null;
  for (const r of rows) {
    if (prev && r.ts >= sinceMs) {
      const d = (w: "five" | "seven"): { own: number; gap: number } => {
        const last = w === "five" ? r.fiveUtil : r.sevenUtil;
        const first = w === "five" ? r.firstFiveUtil : r.firstSevenUtil;
        const before = w === "five" ? prev!.fiveUtil : prev!.sevenUtil;
        const same = sameWindow(w === "five" ? prev!.fiveReset : prev!.sevenReset, w === "five" ? r.fiveReset : r.sevenReset);
        if (last === null || before === null) return { own: 0, gap: 0 };
        const base = same ? before : 0;
        if (first !== null && first >= base && first <= last) return { own: last - first, gap: first - base };
        return { own: Math.max(0, last - base), gap: 0 };
      };
      const f = d("five");
      const s = d("seven");
      add(categoryOf(r.origin), f.own, s.own, true);
      if (f.gap > 0 || s.gap > 0) add(GAP_BUCKET, f.gap, s.gap, false);
    }
    prev = r;
  }
  return [...acc.values()].sort((a, b) => b.five - a.five || b.seven - a.seven);
}

/** Tableau texte de l'attribution. PUR. */
export function formatAttribution(lines: readonly AttributionLine[]): string[] {
  const tot5 = lines.reduce((a, l) => a + l.five, 0);
  const tot7 = lines.reduce((a, l) => a + l.seven, 0);
  if (lines.length === 0 || (tot5 === 0 && tot7 === 0)) return ["aucune consommation mesurée sur la période"];
  const out = lines.map((l) => {
    const share = tot5 > 0 ? Math.round((l.five / tot5) * 100) : 0;
    return `${l.key.padEnd(34)} 5 h : ${(l.five * 100).toFixed(0).padStart(4)} pts (${String(share).padStart(3)} %) · semaine : ${(l.seven * 100).toFixed(0).padStart(3)} pts · ${l.runs} tours`;
  });
  out.push(`${"TOTAL".padEnd(34)} 5 h : ${(tot5 * 100).toFixed(0).padStart(4)} pts · semaine : ${(tot7 * 100).toFixed(0).padStart(3)} pts`);
  return out;
}

// ── E/S : enregistrement, lecture ───────────────────────────────────────────────────────────────

export function policyEnabled(db: Pick<QuotaStore, "getSetting">): boolean {
  return (db.getSetting(POLICY_KEY) ?? "").trim().toLowerCase() !== "off";
}

export interface QuotaState {
  quota: StoredQuota;
  proj: QuotaProjections;
  policy: QuotaPolicy;
}

/** Tout l'état dérivé, lu dans le magasin (≤ 7 j d'historique, indexé). */
export function readQuotaState(db: Pick<QuotaStore, "getSetting" | "quotaLogSince">, nowMs: number, cfg = quotaPolicyConfig()): QuotaState {
  const quota = readQuota(db);
  const rows = db.quotaLogSince(nowMs - Math.max(cfg.lookback7dMs, cfg.lookback5hMs) - 3600_000);
  const proj = projectAll(quota, rows, nowMs, cfg);
  return { quota, proj, policy: decideQuotaPolicy(quota, proj, nowMs, cfg, policyEnabled(db)) };
}

/** La ligne à injecter, best-effort : une base qui lève ne doit jamais empêcher un réveil. */
export function quotaContextLine(db: Pick<QuotaStore, "getSetting" | "quotaLogSince">, nowMs = Date.now(), cfg = quotaPolicyConfig()): string {
  try {
    const st = readQuotaState(db, nowMs, cfg);
    return formatQuotaContextLine(st.quota, st.proj, st.policy, nowMs, cfg);
  } catch {
    return "";
  }
}

/** Vue sérialisée (clé `claude_quota_view`) : ce qu'un tableau de bord affiche sans recalculer. */
export function quotaView(st: QuotaState, nowMs: number): Record<string, unknown> {
  const w = (p: WindowProjection | null) =>
    p && { util: p.util, resetMs: p.resetMs, ratePerHour: p.ratePerHour, hitAtMs: p.hitAtMs, hitsBeforeReset: p.hitsBeforeReset, paceUtil: p.paceUtil, ahead: p.ahead };
  return {
    at: nowMs,
    five: w(st.proj.five),
    seven: w(st.proj.seven),
    policy: {
      mode: st.policy.mode,
      reasons: st.policy.reasons,
      deferUntilMs: st.policy.deferUntilMs,
      weekLevel: st.policy.weekLevel,
      weekProjectedEnd: st.policy.weekProjectedEnd,
    },
  };
}

/**
 * Enregistre UNE mesure : dernière valeur, journal, vue, alertes. Rend les textes d'alerte à envoyer (l'appelant
 * a la voix). Ne lève pas vers un moteur : le puits de ton `main` doit l'envelopper (best-effort), la CLI veut
 * voir l'erreur.
 */
export function recordQuotaMeasure(
  db: QuotaStore,
  snap: QuotaSnapshot,
  nowMs: number,
  origin: string,
  first: QuotaSnapshot | null = null,
  events = 1,
  cfg = quotaPolicyConfig(),
): { alerts: string[]; policy: QuotaPolicy; previousMode: string | null } {
  storeQuota(db, snap, nowMs, origin);
  const id = db.recordQuotaLog({
    ts: nowMs,
    origin,
    fiveUtil: snap.fiveHour?.utilization ?? null,
    fiveReset: snap.fiveHour?.resetsAtMs ?? null,
    sevenUtil: snap.sevenDay?.utilization ?? null,
    sevenReset: snap.sevenDay?.resetsAtMs ?? null,
    status: snap.status,
    overage: snap.isUsingOverage,
    overageStatus: snap.overageStatus,
    firstFiveUtil: first?.fiveHour?.utilization ?? null,
    firstSevenUtil: first?.sevenDay?.utilization ?? null,
    events,
  });
  if (id % 500 === 0) db.pruneQuotaLog?.(QUOTA_LOG_RETENTION_MS, nowMs);
  const st = readQuotaState(db, nowMs, cfg);
  let previousMode: string | null = null;
  try {
    previousMode = (JSON.parse(db.getSetting(VIEW_KEY) || "{}") as { policy?: { mode?: string } }).policy?.mode ?? null;
  } catch {
    /* vue illisible : on la réécrit */
  }
  db.setSetting(VIEW_KEY, JSON.stringify(quotaView(st, nowMs)));
  let prev: QuotaAlertState = {};
  try {
    prev = JSON.parse(db.getSetting(ALERT_STATE_KEY) || "{}") as QuotaAlertState;
  } catch {
    /* état illisible : repart de zéro */
  }
  const { texts, next } = quotaAlerts(prev, st.quota, st.proj, nowMs, cfg);
  db.setSetting(ALERT_STATE_KEY, JSON.stringify(next));
  return { alerts: texts, policy: st.policy, previousMode };
}

/** Politique courante avec un cache court (le runner de jobs tique toutes les quelques secondes). */
export function createPolicyReader(db: Pick<QuotaStore, "getSetting" | "quotaLogSince">, ttlMs = 60_000): (nowMs?: number) => QuotaPolicy {
  let cached: { at: number; p: QuotaPolicy } | null = null;
  return (nowMs = Date.now()) => {
    if (cached && nowMs - cached.at < ttlMs) return cached.p;
    let p: QuotaPolicy;
    try {
      p = readQuotaState(db, nowMs).policy;
    } catch {
      p = { mode: "inconnu", ...NO_POLICY, reasons: ["lecture impossible"] };
    }
    cached = { at: nowMs, p };
    return p;
  };
}

/** Lignes de commande de statut et de CLI : projection + politique, sous les lignes de `formatQuotaLines`. PUR. */
export function formatPolicyLines(st: QuotaState, nowMs: number, tz = "UTC"): string[] {
  const out: string[] = [];
  const proj = (label: string, p: WindowProjection | null): string | null => {
    if (!p) return null;
    const rate = p.ratePerHour === null ? "rythme inconnu" : `${(p.ratePerHour * 100).toFixed(1)} pts/h`;
    const hit = p.hitsBeforeReset && p.hitAtMs !== null ? `⚠️ 100 % vers ${compactInstant(p.hitAtMs, nowMs, tz)}, avant le reset` : "pas de 100 % avant le reset";
    const pace = p.ahead === null ? "" : ` · ${p.ahead >= 0 ? "+" : ""}${Math.round(p.ahead * 100)} pts vs rythme linéaire`;
    return `projection ${label} : ${rate} · ${hit}${pace}`;
  };
  for (const l of [proj("5 h", st.proj.five), proj("semaine", st.proj.seven)]) if (l) out.push(l);
  out.push(`politique quota : ${st.policy.mode}${st.policy.reasons.length ? ` (${st.policy.reasons.join(" ; ")})` : ""}`);
  return out;
}
