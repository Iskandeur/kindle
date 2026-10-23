/**
 * Plafond de prudence — borne journalière des réveils « fail-open ».
 *
 * Chaque fail-open d'un daemon est une bonne politique : « capteur inconnu → réveil par prudence »,
 * « capteur en échec → réveil par prudence », « type d'évènement inconnu → réveil générique ». Mais
 * chacune de ces prudences est une session LLM, et rien ne les compte. Le jour où un capteur est
 * retiré du registre sans retirer son réveil récurrent, la prudence coûte une session PAR TICK, pour
 * toujours, et seule la facture le dit.
 *
 * Ici : un compteur `prudence_wakes_today` (remis à zéro au changement de jour UTC), incrémenté
 * UNIQUEMENT par les branches « inconnu / en échec » — jamais par un réveil légitime. Au-delà du
 * plafond, UNE alerte (la première fois seulement), puis la prudence se dégrade en journalisation :
 * elle ne lance plus de session jusqu'au lendemain. Le compteur continue de monter au-delà du
 * plafond, pour que l'ampleur de la fuite évitée se lise en base.
 *
 * Le jour est UTC (un serveur y tourne le plus souvent) : la remise à zéro tombe à une heure
 * arbitraire du jour local, ce qui n'a aucune importance pour une borne de coût.
 */

/** Réveils par prudence accordés OU refusés aujourd'hui (le compte total, plafond compris). */
export const PRUDENCE_COUNT_KEY = "prudence_wakes_today";
/** Jour (YYYY-MM-DD, UTC) auquel se rapporte le compteur — un jour différent = remise à zéro. */
export const PRUDENCE_DAY_KEY = "prudence_wakes_day";
/** Plafond par défaut : un capteur fantôme à 2 min de cadence en ferait 720 sans lui. */
export const DEFAULT_PRUDENCE_CAP = 10;

export interface PrudenceStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface PrudenceGate {
  /** Enregistre un réveil « par prudence ». `true` = la session peut partir ; `false` = plafond
   *  atteint, l'appelant journalise et NE lance PAS de session. `reason` = la branche (pour l'alerte). */
  claim(reason: string, now?: number): boolean;
}

export interface PrudenceGateOptions {
  /** Réveils par prudence tolérés par jour. ≤ 0 = compter sans jamais bloquer (désactive le plafond). */
  cap: number;
  /** Alerte émise UNE fois par jour, au premier refus. Ne doit pas lever (best-effort côté appelant). */
  alert: (text: string) => void;
  log?: (msg: string) => void;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Lecture seule du compteur courant (0 si le jour a changé). Pour les statuts/tests. */
export function prudenceCountToday(db: PrudenceStore, now: number): number {
  if (db.getSetting(PRUDENCE_DAY_KEY) !== utcDay(now)) return 0;
  return Number.parseInt(db.getSetting(PRUDENCE_COUNT_KEY) || "0", 10) || 0;
}

export function prudenceCapText(cap: number, count: number, reason: string): string {
  return (
    `🧯 Plafond de prudence atteint : ${count} réveils « par prudence » aujourd'hui (plafond ${cap}). ` +
    `Dernière cause : ${reason}. Jusqu'à demain (UTC) ces branches sont seulement journalisées, ` +
    `plus aucune session n'est lancée pour elles. Cause typique : un réveil dont le capteur n'existe ` +
    `plus (liste tes réveils récurrents), ou une dépendance en panne.`
  );
}

export function createPrudenceGate(db: PrudenceStore, opts: PrudenceGateOptions): PrudenceGate {
  const log = opts.log ?? ((m) => console.warn(m));
  return {
    claim(reason, now = Date.now()) {
      const day = utcDay(now);
      const count = prudenceCountToday(db, now) + 1;
      if (db.getSetting(PRUDENCE_DAY_KEY) !== day) db.setSetting(PRUDENCE_DAY_KEY, day);
      db.setSetting(PRUDENCE_COUNT_KEY, String(count));
      if (opts.cap <= 0 || count <= opts.cap) return true;
      if (count === opts.cap + 1) {
        // Première fois au-delà du plafond aujourd'hui → l'alerte, et elle seule. Les refus
        // suivants ne font que journaliser (une alerte par tick serait la fuite qu'on ferme).
        try {
          opts.alert(prudenceCapText(opts.cap, count, reason));
        } catch (e) {
          log(`[prudence] alerte de plafond impossible : ${(e as Error).message}`);
        }
      }
      log(`[prudence] plafond ${opts.cap} atteint (${count} aujourd'hui) → ${reason} : journalisé, pas de session`);
      return false;
    },
  };
}
