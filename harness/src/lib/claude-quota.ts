/**
 * Quota Claude Code (fenêtre de 5 h + fenêtre hebdomadaire), lu PASSIVEMENT dans la sortie du binaire officiel.
 *
 * `claude -p --output-format stream-json --verbose` émet, à chaque tour, une ligne
 *   {"type":"rate_limit_event","rate_limit_info":{"status","resetsAt","rateLimitType","overageStatus",
 *    "isUsingOverage","unifiedWindows":{"five_hour":{"utilization":0.04,"resetsAt":<epoch s>},
 *    "seven_day":{"utilization":0.57,"resetsAt":<epoch s>}}}}
 * C'est le binaire qui parle : aucun jeton extrait, aucun appel à une API privée (rien qui contourne le
 * garde-fou de facturation de l'abonnement). Le dernier évènement `type:"result"` du flux porte les champs de
 * l'ancien `--output-format json` : le moteur reconstitue le même objet qu'avant.
 *
 * Le stockage passe par un PUITS de module (`setQuotaSink`) que ton `main` branche sur ta base : le moteur et
 * le routeur n'ont pas de base sous la main, et un réveil ne doit jamais échouer parce qu'une mesure de quota
 * n'a pas pu s'écrire (best-effort, avalé).
 *
 * Pièges :
 *  - un champ de reset peut porter des SECONDES ou des MILLISECONDES d'epoch : `toEpochMs` tolère les deux ;
 *  - le flux d'un job long en `--verbose` pèse des dizaines de Mo de résultats d'outils : le collecteur ne
 *    garde que le `result`, les quotas et les premiers caractères non-JSON ;
 *  - un évènement sans aucune fenêtre ni statut n'apprend rien : il n'est pas écrit par-dessus une vraie mesure.
 *
 * Pour la politique qu'on en tire (différer, économiser, projeter), voir `quota-policy.ts`.
 */

/** Une fenêtre unifiée : utilisation ∈ [0,1], reset en ms epoch (null si absent). */
export interface QuotaWindow {
  utilization: number;
  resetsAtMs: number | null;
}

export interface QuotaSnapshot {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  status: string | null;
  rateLimitType: string | null;
  isUsingOverage: boolean | null;
  overageStatus: string | null;
  /** Reset global annoncé (ms), celui de la fenêtre qui contraint. */
  resetsAtMs: number | null;
}

/** Clés du magasin clé/valeur (aplaties exprès : lisibles d'un `sqlite3` à la main). */
export const QUOTA_KEYS = {
  fiveUtil: "claude_quota_5h_util",
  fiveReset: "claude_quota_5h_reset",
  sevenUtil: "claude_quota_7d_util",
  sevenReset: "claude_quota_7d_reset",
  seenAt: "claude_quota_seen_at",
  status: "claude_quota_status",
  overage: "claude_quota_is_using_overage",
  overageStatus: "claude_quota_overage_status",
  source: "claude_quota_source",
} as const;

/** Epoch en secondes OU en millisecondes : ms. Le binaire envoie des secondes ; on tolère les deux. */
export function toEpochMs(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function parseWindow(w: unknown): QuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const u = (w as { utilization?: unknown }).utilization;
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return { utilization: u, resetsAtMs: toEpochMs((w as { resetsAt?: unknown }).resetsAt) };
}

/** Un objet JSON du flux : instantané de quota, ou null si ce n'est pas un `rate_limit_event`. PUR. */
export function parseRateLimitEvent(obj: unknown): QuotaSnapshot | null {
  if (!obj || typeof obj !== "object" || (obj as { type?: unknown }).type !== "rate_limit_event") return null;
  const info = (obj as { rate_limit_info?: unknown }).rate_limit_info;
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  const windows = (i.unifiedWindows && typeof i.unifiedWindows === "object" ? i.unifiedWindows : {}) as Record<string, unknown>;
  const snap: QuotaSnapshot = {
    fiveHour: parseWindow(windows.five_hour),
    sevenDay: parseWindow(windows.seven_day),
    status: typeof i.status === "string" ? i.status : null,
    rateLimitType: typeof i.rateLimitType === "string" ? i.rateLimitType : null,
    isUsingOverage: typeof i.isUsingOverage === "boolean" ? i.isUsingOverage : null,
    overageStatus: typeof i.overageStatus === "string" ? i.overageStatus : null,
    resetsAtMs: toEpochMs(i.resetsAt),
  };
  if (!snap.fiveHour && !snap.sevenDay && !snap.status) return null;
  return snap;
}

/** Borne de ce que le collecteur garde du texte non-JSON (crash, message d'usage en clair). */
const NON_JSON_KEEP = 4000;

/**
 * Collecteur ligne à ligne de stdout `claude -p`. Accepte les DEUX formats :
 *  - `stream-json` (une ligne JSON par évènement) : garde le dernier `result` et le dernier quota ;
 *  - `json` historique (un seul objet, éventuellement sur plusieurs lignes) : `finish()` le reparse entier si
 *    aucune ligne n'a donné de `result`.
 * Ne garde PAS tout le flux en mémoire : seulement le `result`, les quotas, et les 4 000 premiers caractères
 * non-JSON.
 */
export class StreamJsonCollector {
  result: Record<string, unknown> | null = null;
  /** Texte brut du dernier `result` (pour qui reparse). */
  resultLine: string | null = null;
  quota: QuotaSnapshot | null = null;
  /** Premier quota du flux (le dernier est `quota`) : l'écart des deux, quand il y en a plusieurs, est ce que
   *  CE processus a consommé. */
  firstQuota: QuotaSnapshot | null = null;
  quotaEvents = 0;
  /** Le modèle annoncé par l'évènement `system/init` : celui de CE processus (le `modelUsage` du `result`, lui,
   *  est restauré au `--resume` et peut nommer le modèle d'un tour d'avant). */
  initModel: string | null = null;
  nonJson = "";
  private buf = "";
  /** Copie intégrale tant qu'elle reste petite : sert le repli « json historique multi-lignes ». */
  private whole = "";
  private wholeOverflow = false;

  push(chunk: string | Buffer): void {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!this.wholeOverflow) {
      if (this.whole.length + s.length > 2_000_000) {
        this.wholeOverflow = true;
        this.whole = "";
      } else this.whole += s;
    }
    this.buf += s;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  private line(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith("{")) {
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        const q = parseRateLimitEvent(obj);
        if (q) {
          if (!this.firstQuota) this.firstQuota = q;
          this.quota = q;
          this.quotaEvents++;
          return;
        }
        if (obj.type === "result") {
          this.result = obj;
          this.resultLine = t;
        } else if (obj.type === "system" && obj.subtype === "init" && typeof obj.model === "string" && !this.initModel) {
          this.initModel = obj.model;
        }
        return;
      } catch {
        /* ligne non-JSON qui commence par « { » : tombe dans le texte brut */
      }
    }
    if (this.nonJson.length < NON_JSON_KEEP) this.nonJson += (this.nonJson ? "\n" : "") + t.slice(0, NON_JSON_KEEP);
  }

  /** À appeler sur `close`. Traite la dernière ligne sans `\n`, puis le repli json historique. */
  finish(): void {
    if (this.buf) {
      const rest = this.buf;
      this.buf = "";
      this.line(rest);
    }
    if (!this.result && !this.wholeOverflow && this.whole.trim()) {
      try {
        const obj = JSON.parse(this.whole) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          this.result = obj as Record<string, unknown>;
          this.resultLine = this.whole.trim();
          this.nonJson = "";
        }
      } catch {
        /* vraiment pas du JSON : nonJson porte le texte */
      }
    }
  }
}

// ── Puits (branché par ton main) ────────────────────────────────────────────────────────────────

/** `first` : le premier évènement du même processus quand le flux en a porté plusieurs (sinon null). */
type Sink = (snap: QuotaSnapshot, source: string, first: QuotaSnapshot | null, events: number) => void;
let sink: Sink | null = null;

export function setQuotaSink(fn: Sink | null): void {
  sink = fn;
}

/** Remonte une mesure au puits. Jamais d'exception vers l'appelant. */
export function emitQuota(snap: QuotaSnapshot | null, source: string, first: QuotaSnapshot | null = null, events = 1): void {
  if (!snap || !sink) return;
  try {
    sink(snap, source, events > 1 ? first : null, events);
  } catch {
    /* best-effort */
  }
}

// ── Stockage ────────────────────────────────────────────────────────────────────────────────────

export type SettingsRW = { getSetting(k: string): string | null; setSetting(k: string, v: string): void };

export function storeQuota(db: SettingsRW, snap: QuotaSnapshot, nowMs: number, source: string): void {
  const put = (k: string, v: string | number | boolean | null | undefined): void => {
    if (v === null || v === undefined) return;
    db.setSetting(k, String(v));
  };
  put(QUOTA_KEYS.fiveUtil, snap.fiveHour?.utilization);
  put(QUOTA_KEYS.fiveReset, snap.fiveHour?.resetsAtMs);
  put(QUOTA_KEYS.sevenUtil, snap.sevenDay?.utilization);
  put(QUOTA_KEYS.sevenReset, snap.sevenDay?.resetsAtMs);
  put(QUOTA_KEYS.status, snap.status);
  put(QUOTA_KEYS.overage, snap.isUsingOverage);
  put(QUOTA_KEYS.overageStatus, snap.overageStatus);
  put(QUOTA_KEYS.source, source);
  db.setSetting(QUOTA_KEYS.seenAt, String(nowMs));
}

export interface StoredQuota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  status: string | null;
  isUsingOverage: boolean | null;
  seenAtMs: number | null;
  source: string | null;
}

export function readQuota(db: Pick<SettingsRW, "getSetting">): StoredQuota {
  const num = (k: string): number | null => {
    const v = db.getSetting(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const win = (u: string, r: string): QuotaWindow | null => {
    const util = num(u);
    return util === null ? null : { utilization: util, resetsAtMs: toEpochMs(num(r)) };
  };
  const ov = db.getSetting(QUOTA_KEYS.overage);
  return {
    fiveHour: win(QUOTA_KEYS.fiveUtil, QUOTA_KEYS.fiveReset),
    sevenDay: win(QUOTA_KEYS.sevenUtil, QUOTA_KEYS.sevenReset),
    status: db.getSetting(QUOTA_KEYS.status),
    isUsingOverage: ov === "true" ? true : ov === "false" ? false : null,
    seenAtMs: toEpochMs(num(QUOTA_KEYS.seenAt)),
    source: db.getSetting(QUOTA_KEYS.source),
  };
}

// ── Affichage ───────────────────────────────────────────────────────────────────────────────────

/** « sam. 03/10 14:20 » dans le fuseau donné (UTC par défaut). PUR (Intl). */
export function formatInstant(ms: number, tz = "UTC"): string {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit" }).format(d);
  const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day} ${hm}`;
}

/** Durée courte FR : « 42 min », « 3 h 05 », « 2 j 4 h ». */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

function pct(u: number): string {
  return `${Math.round(u * 100)} %`;
}

/** Une fenêtre en une ligne. Un reset déjà passé = la mesure est périmée pour cette fenêtre. */
export function formatWindow(label: string, w: QuotaWindow | null, nowMs: number, tz = "UTC"): string {
  if (!w) return `${label} : inconnu`;
  if (w.resetsAtMs === null) return `${label} : ${pct(w.utilization)}`;
  if (w.resetsAtMs <= nowMs) return `${label} : ${pct(w.utilization)} mesuré, fenêtre remise à zéro depuis (${formatInstant(w.resetsAtMs, tz)})`;
  return `${label} : ${pct(w.utilization)} · reset ${formatInstant(w.resetsAtMs, tz)} (dans ${shortDuration(w.resetsAtMs - nowMs)})`;
}

/** Lignes lisibles (commande de statut, CLI). PUR. */
export function formatQuotaLines(q: StoredQuota, nowMs: number, tz = "UTC"): string[] {
  if (q.seenAtMs === null) return ["quota Claude : aucune mesure encore"];
  const lines = [
    formatWindow("quota 5 h", q.fiveHour, nowMs, tz),
    formatWindow("quota 7 j", q.sevenDay, nowMs, tz),
  ];
  const extra = [
    `mesuré il y a ${shortDuration(nowMs - q.seenAtMs)}`,
    q.status && q.status !== "allowed" ? `statut ${q.status}` : null,
    q.isUsingOverage ? "⚠️ en dépassement (overage)" : null,
  ].filter(Boolean);
  lines.push(`  (${extra.join(" · ")})`);
  return lines;
}
