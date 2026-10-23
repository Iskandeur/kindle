/**
 * load-gate : suspendre les réclamations de jobs AVANT que la machine ne gèle.
 *
 * Un gel de serveur monte en plusieurs minutes : la charge passe un seuil très haut bien avant que la machine
 * cesse de répondre. Si le runner continue de réclamer des jobs pendant ce temps, chacun ajoute une session
 * `claude`, des tests, parfois un conteneur, et accélère la chute. Ici, une décision PURE : la charge sur
 * 1 min reste au-dessus de `high` pendant `highForMs` : plus aucune nouvelle réclamation (les jobs en vol
 * continuent : les couper perdrait leur travail sans rendre l'air plus vite) ; elle redescend sous `low`
 * pendant `resumeAfterMs` : la file repart. L'écart entre les deux seuils évite le battement (suspendre,
 * reprendre, resuspendre à chaque tic).
 *
 * Une alerte par épisode, au plus une par `alertCooldownMs`. Une mesure illisible ne change rien : on ne
 * suspend pas sur une ignorance.
 *
 * Les seuils dépendent du nombre de cœurs : `defaultThresholds(cores)` donne un point de départ
 * (haute = 10 process prêts par cœur, basse = 5), à régler sur ta machine.
 */
import { readFileSync } from "node:fs";

export interface LoadThresholds {
  /** Charge (1 min) au-dessus de laquelle on suspend, si elle y reste `highForMs`. */
  high: number;
  highForMs: number;
  /** Charge sous laquelle on reprend, si elle y reste `resumeAfterMs`. Doit être < `high`. */
  low: number;
  resumeAfterMs: number;
  alertCooldownMs: number;
}

export function defaultThresholds(cores: number): LoadThresholds {
  const c = Math.max(1, Math.floor(cores));
  return { high: 10 * c, highForMs: 3 * 60_000, low: 5 * c, resumeAfterMs: 2 * 60_000, alertCooldownMs: 3_600_000 };
}

export interface LoadState {
  /** Depuis quand la charge est vue au-dessus de `high` sans interruption (ms), ou null. */
  highSince: number | null;
  /** Depuis quand elle est vue sous `low` sans interruption, pendant une suspension. */
  lowSince: number | null;
  suspended: boolean;
  lastAlert: number;
}

export const INITIAL_LOAD_STATE: LoadState = { highSince: null, lowSince: null, suspended: false, lastAlert: Number.NEGATIVE_INFINITY };

export interface LoadDecision {
  state: LoadState;
  transition: "suspend" | "resume" | null;
  alert: boolean;
}

/** Une observation de la charge. PUR. */
export function observeLoad(state: LoadState, load: number | null, now: number, t: LoadThresholds): LoadDecision {
  if (load === null || !Number.isFinite(load)) return { state, transition: null, alert: false };
  if (!state.suspended) {
    if (load <= t.high) return { state: { ...state, highSince: null }, transition: null, alert: false };
    const highSince = state.highSince ?? now;
    if (now - highSince < t.highForMs) return { state: { ...state, highSince }, transition: null, alert: false };
    const alert = now - state.lastAlert >= t.alertCooldownMs;
    return {
      state: { highSince, lowSince: null, suspended: true, lastAlert: alert ? now : state.lastAlert },
      transition: "suspend",
      alert,
    };
  }
  if (load >= t.low) return { state: { ...state, lowSince: null }, transition: null, alert: false };
  const lowSince = state.lowSince ?? now;
  if (now - lowSince < t.resumeAfterMs) return { state: { ...state, lowSince }, transition: null, alert: false };
  return { state: { ...state, highSince: null, lowSince: null, suspended: false }, transition: "resume", alert: false };
}

/** La charge sur 1 min, lue dans le texte de `/proc/loadavg`. PUR. */
export function parseLoadavg(texte: string | null): number | null {
  const n = Number((texte ?? "").trim().split(/\s+/)[0]);
  return texte && Number.isFinite(n) ? n : null;
}

/** Lit `/proc/loadavg` ; `null` si illisible (hors Linux, accès refusé). */
export function readLoad(): number | null {
  try {
    return parseLoadavg(readFileSync("/proc/loadavg", "utf8"));
  } catch {
    return null;
  }
}

/** Le message à ton humain quand la file se ferme. */
export function loadAlertText(load: number, inFlight: number, t: LoadThresholds): string {
  return `🌡️ La charge de la machine tient au-dessus de ${t.high} depuis ${t.highForMs / 60_000} min (${load.toFixed(0)}) : ` +
    `je ne lance plus de nouveau job tant qu'elle n'est pas redescendue sous ${t.low} pendant ${t.resumeAfterMs / 60_000} min. ` +
    `${inFlight} job(s) en vol continuent. Rien à faire de ton côté.`;
}

/** L'état vivant de la porte, tenu par le runner de jobs. */
export class LoadGate {
  state: LoadState = INITIAL_LOAD_STATE;
  private readonly read: () => number | null;
  private readonly alert: (texte: string) => void;
  private readonly t: LoadThresholds;
  private readonly log: (msg: string) => void;
  constructor(o: { thresholds: LoadThresholds; read?: () => number | null; alert: (texte: string) => void; log?: (msg: string) => void }) {
    this.t = o.thresholds;
    this.read = o.read ?? readLoad;
    this.alert = o.alert;
    this.log = o.log ?? (() => {});
  }
  /** Une observation ; rend true si les réclamations sont suspendues. Ne lève jamais. */
  observe(now: number, inFlight: number): boolean {
    try {
      const load = this.read();
      const d = observeLoad(this.state, load, now, this.t);
      this.state = d.state;
      if (d.transition === "suspend") {
        this.log(`charge ${load} > ${this.t.high} depuis ${this.t.highForMs / 60_000} min : plus aucune nouvelle réclamation`);
        if (d.alert && load !== null) this.alert(loadAlertText(load, inFlight, this.t));
      } else if (d.transition === "resume") {
        this.log(`charge redescendue (${load}) : la réclamation reprend`);
      }
    } catch (e) {
      this.log(`garde de charge en échec (${(e as Error).message})`);
    }
    return this.state.suspended;
  }
}
