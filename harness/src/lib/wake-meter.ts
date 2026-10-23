/**
 * Compteur journalier des réveils émis par le scheduler — un COMPTEUR, pas un plafond.
 *
 * Un « budget de N réveils par jour » lu seulement dans la config et cité dans les consignes de
 * l'agent comme s'il le limitait, sans que rien ne le compte ni ne l'applique, est un garde-fou qui ne
 * garde rien : mesuré, les réveils réels le dépassaient chaque matin. Ce module compte pour de bon.
 *
 * Pourquoi un compteur et pas un plafond. Bloquer le N+1ᵉ réveil du jour rendrait muettes les alertes
 * de sûreté (un conteneur qui brûle du crédit, un disque qui se remplit) derrière les réveils bavards
 * d'autres capteurs : un fail-closed sur ce qui doit justement rester audible. Les branches qui
 * MÉRITENT un plafond (capteur inconnu, capteur en échec) en ont déjà un : `prudence.ts`.
 *
 * Ce que ce compteur attrape que rien n'attrapait : un capteur LÉGITIME devenu bavard — un
 * `changed:true` à chaque tick avec une note qui n'est pas une anomalie. Un capteur à 2 min dans cet
 * état, c'est 720 sessions par jour, et seule la facture le disait. Ici : UNE alerte le jour où le
 * total franchit le seuil, avec la ventilation par origine (le coupable est nommé), puis journalisation
 * seule. Rien n'est jamais bloqué.
 *
 * Compte les réveils ÉMIS vers l'orchestrateur, pas les sessions réellement démarrées (l'orchestrateur
 * peut encore fusionner un doublon en vol) : c'est une borne haute, celle qu'on veut pour repérer un
 * bavard. Le jour est UTC, comme pour la prudence.
 */
import { utcDay } from "./prudence.ts";

/** JSON `{ origine: nombre }` des réveils émis aujourd'hui (origine = nom du capteur, ou sans). */
export const WAKE_METER_COUNTS_KEY = "wake_sessions_today";
/** Jour (YYYY-MM-DD, UTC) auquel se rapporte le compteur — un jour différent = remise à zéro. */
export const WAKE_METER_DAY_KEY = "wake_sessions_day";
/** Origine des réveils sans capteur (réveils ponctuels, récurrents nus). */
export const NO_SENSOR_ORIGIN = "(sans capteur)";
/** Un seuil à calibrer sur TES jours ordinaires : choisis-le au-dessus de ton maximum observé. */
export const DEFAULT_WAKES_ALERT_PER_DAY = 100;

export interface WakeMeterStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface WakeMeter {
  /** Note un réveil émis. Ne rend rien et ne bloque rien : l'appelant a déjà décidé d'émettre. */
  record(origin: string, now?: number): void;
}

export interface WakeMeterOptions {
  /** Total journalier au-delà duquel UNE alerte part. ≤ 0 = compter sans jamais alerter. */
  threshold: number;
  /** Alerte émise une fois par jour, au franchissement. Ne doit pas lever (best-effort). */
  alert: (text: string) => void;
  log?: (msg: string) => void;
}

export interface WakeSessionsToday {
  total: number;
  byOrigin: Record<string, number>;
}

/** Un JSON absent, tronqué ou d'une autre forme vaut « rien compté » : le compteur ne doit jamais
 *  faire tomber le scheduler pour une valeur de réglage abîmée. */
function parseCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** Lecture seule du compteur courant (vide si le jour a changé). Pour les statuts et les tests. */
export function wakeSessionsToday(db: WakeMeterStore, now: number): WakeSessionsToday {
  if (db.getSetting(WAKE_METER_DAY_KEY) !== utcDay(now)) return { total: 0, byOrigin: {} };
  const byOrigin = parseCounts(db.getSetting(WAKE_METER_COUNTS_KEY));
  return { total: Object.values(byOrigin).reduce((a, b) => a + b, 0), byOrigin };
}

export function wakeMeterAlertText(threshold: number, counts: WakeSessionsToday): string {
  const top = Object.entries(counts.byOrigin)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([origin, n]) => `${origin} ${n}`)
    .join(", ");
  return (
    `📈 ${counts.total} réveils émis aujourd'hui (seuil d'alerte ${threshold}) — par origine : ${top}. ` +
    `Rien n'est bloqué : ce compteur nomme le bavard, il ne le fait pas taire. Si une origine domine, ` +
    `c'est son réveil récurrent qu'on regarde.`
  );
}

export function createWakeMeter(db: WakeMeterStore, opts: WakeMeterOptions): WakeMeter {
  const log = opts.log ?? ((m) => console.warn(m));
  return {
    record(origin, now = Date.now()) {
      const day = utcDay(now);
      const current = wakeSessionsToday(db, now);
      if (db.getSetting(WAKE_METER_DAY_KEY) !== day) db.setSetting(WAKE_METER_DAY_KEY, day);
      const byOrigin = { ...current.byOrigin, [origin]: (current.byOrigin[origin] ?? 0) + 1 };
      db.setSetting(WAKE_METER_COUNTS_KEY, JSON.stringify(byOrigin));
      const total = current.total + 1;
      // Exactement au franchissement, et là seulement : chaque record() ajoute 1, donc une seule
      // valeur de `total` vaut threshold + 1 dans la journée — l'alerte est unique par construction,
      // sans drapeau à poser, et elle survit à un redémarrage (l'état est en base).
      if (opts.threshold > 0 && total === opts.threshold + 1) {
        try {
          opts.alert(wakeMeterAlertText(opts.threshold, { total, byOrigin }));
        } catch (e) {
          log(`[wake-meter] alerte de seuil impossible : ${(e as Error).message}`);
        }
        log(`[wake-meter] ${total} réveils aujourd'hui, seuil ${opts.threshold} franchi par « ${origin} » → alerte unique`);
      }
    },
  };
}
