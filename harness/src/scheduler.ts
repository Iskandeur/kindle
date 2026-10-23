/**
 * Scheduler — le fil du temps du compagnon (self-scheduling, voir docs/self-scheduling.md).
 *
 * Relit le magasin de réveils (les échéances que l'agent s'est lui-même programmées via
 * `bin/schedule-wake.ts`) et déclenche ceux qui sont dus.
 *
 * SOBRIÉTÉ : chaque réveil déclenché relance une session — donc coûte des tokens et du temps de
 * calcul. Un budget quotidien (`MAX_WAKES_PER_DAY`, variable d'env) borne le nombre de réveils
 * déclenchés sur une fenêtre glissante de 24h. Au-delà, un réveil dû est SAUTÉ, pas annulé : un
 * réveil récurrent est réarmé à sa prochaine échéance normalement (pour ne pas le re-tester à
 * chaque tick), un réveil unique reste `pending` et sera réévalué au tick suivant — rien n'est
 * perdu, seulement retardé jusqu'à ce que le budget se libère.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nextOccurrence } from "./lib/wake-time.ts";

export interface WakeRow {
  id: number;
  due_at: number;
  intent: string;
  status: string; // 'pending' | 'done' | 'cancelled'
  recurrence_ms: number | null;
  created_at: number;
}

/** Évènement émis quand un réveil se déclenche : à charge de l'appelant de relancer une session
 *  avec `intent` comme contexte (ex: relancer le moteur d'agent avec ce prompt). */
export interface WakeEvent {
  id: number;
  intent: string;
  dueAt: number;
  firedAt: number;
}

/** Magasin des réveils, injectable : tests avec une base en mémoire, prod avec un fichier. */
export interface WakeStore {
  addWake(dueAt: number, intent: string, recurrenceMs?: number | null): number;
  listPending(): WakeRow[];
  cancelWake(id: number): boolean;
  dueWakes(now: number): WakeRow[];
  markWakeDone(id: number): void;
  rescheduleWake(id: number, nextDueAt: number): void;
  /** Enregistre qu'un réveil a bien déclenché une session, pour le calcul du budget. */
  recordFire(id: number, firedAt: number): void;
  /** Nombre de réveils déclenchés depuis `since` (epoch ms) — sert au budget de sobriété. */
  firesSince(since: number): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_at INTEGER NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  recurrence_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wake_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wake_id INTEGER NOT NULL,
  fired_at INTEGER NOT NULL
);
`;

/**
 * Ouvre (et migre si besoin) le magasin de réveils SQLite. `dbPath` doit être un chemin ABSOLU —
 * résolu via `resolveDbPath()` (lib/db-path.ts) — jamais un chemin relatif au cwd du process qui
 * lance ce module : le CLI (`bin/schedule-wake.ts`) et le daemon peuvent avoir des cwd différents,
 * et un chemin relatif y ouvrirait deux bases distinctes en silence.
 */
export function openWakeStore(dbPath: string): WakeStore {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  return {
    addWake(dueAt, intent, recurrenceMs = null) {
      const r = db
        .prepare("INSERT INTO wakes (due_at, intent, recurrence_ms, created_at) VALUES (?, ?, ?, ?)")
        .run(dueAt, intent, recurrenceMs, Date.now());
      return Number(r.lastInsertRowid);
    },
    listPending() {
      return db.prepare("SELECT * FROM wakes WHERE status = 'pending' ORDER BY due_at").all() as unknown as WakeRow[];
    },
    cancelWake(id) {
      return db.prepare("UPDATE wakes SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
    },
    dueWakes(now) {
      return db
        .prepare("SELECT * FROM wakes WHERE status = 'pending' AND due_at <= ? ORDER BY due_at")
        .all(now) as unknown as WakeRow[];
    },
    markWakeDone(id) {
      db.prepare("UPDATE wakes SET status = 'done' WHERE id = ?").run(id);
    },
    rescheduleWake(id, nextDueAt) {
      db.prepare("UPDATE wakes SET due_at = ? WHERE id = ?").run(nextDueAt, id);
    },
    recordFire(id, firedAt) {
      db.prepare("INSERT INTO wake_fires (wake_id, fired_at) VALUES (?, ?)").run(id, firedAt);
    },
    firesSince(since) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM wake_fires WHERE fired_at >= ?").get(since) as { n: number };
      return row.n;
    },
    close() {
      db.close();
    },
  };
}

/** Budget par défaut si `MAX_WAKES_PER_DAY` n'est pas défini : quelques check-ins par jour, pas un
 *  réveil à chaque tick — un compagnon qui vit au rythme d'un humain, pas d'une boucle serrée. */
export const DEFAULT_MAX_WAKES_PER_DAY = 12;

/** Lit le budget quotidien de réveils depuis l'environnement. */
export function maxWakesPerDay(): number {
  const raw = process.env.MAX_WAKES_PER_DAY;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_WAKES_PER_DAY;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Traite tous les réveils dus à `now`. Pur d'effets de bord hors `store` + `onEvent` (donc
 * testable avec un store en mémoire, sans horloge ni process réel). Le budget de sobriété est
 * vérifié PAR réveil dû : si la fenêtre glissante de 24h est déjà pleine, ce réveil est sauté (voir
 * l'en-tête de fichier pour ce que "sauté" veut dire selon récurrent/unique).
 */
/**
 * Porte facultative consultée AVANT le budget, réveil par réveil (voir `lib/sensors.ts`).
 * `undefined` = pas concerné, le réveil suit son cours. `{ fire: false }` = le portier n'a rien vu :
 * un récurrent est réarmé sans session et sans consommer de budget (un réveil UNIQUE ignore ce
 * verdict : il n'a qu'un tir, le fermer en silence le perdrait). `{ fire: true, intent }` remplace
 * l'intent transmis (balise retirée, note du capteur ajoutée).
 */
export type WakeGate = (w: WakeRow) => { fire: boolean; intent?: string } | undefined;

export function processDueWakes(
  store: WakeStore,
  onEvent: (ev: WakeEvent) => void,
  now: number = Date.now(),
  maxPerDay: number = maxWakesPerDay(),
  gate?: WakeGate,
): void {
  for (const w of store.dueWakes(now)) {
    const recurrent = !!(w.recurrence_ms && w.recurrence_ms > 0);
    const verdict = gate?.(w);
    if (verdict && !verdict.fire && recurrent) {
      // Portier muet : ni session, ni fire enregistré (le budget ne compte que les vrais réveils).
      store.rescheduleWake(w.id, nextOccurrence(w.due_at, w.recurrence_ms!, now));
      continue;
    }
    const intent = verdict?.fire && verdict.intent !== undefined ? verdict.intent : w.intent;
    let fire = true;
    const firedRecently = store.firesSince(now - DAY_MS);
    if (firedRecently >= maxPerDay) {
      fire = false;
      console.warn(
        `[scheduler] réveil #${w.id} sauté : budget de sobriété atteint (${firedRecently}/${maxPerDay} réveils / 24h).`,
      );
    }

    if (fire) {
      store.recordFire(w.id, now);
      onEvent({ id: w.id, intent, dueAt: w.due_at, firedAt: now });
    }

    // Récurrent → réarmé à la prochaine échéance, qu'il ait tiré ou non (sinon un budget plein
    // ferait re-tester ce wake à CHAQUE tick jusqu'à la libération, une rafale silencieuse).
    // Unique → clos seulement s'il a tiré ; un unique sauté pour budget reste 'pending' (retenté
    // au prochain tick, jamais perdu).
    if (w.recurrence_ms && w.recurrence_ms > 0) {
      store.rescheduleWake(w.id, nextOccurrence(w.due_at, w.recurrence_ms, now));
    } else if (fire) {
      store.markWakeDone(w.id);
    }
  }
}

/**
 * `prefetchGate` (facultatif) : appelé à chaque tick avec les réveils dus, il rend la porte du tick
 * (typiquement `(due) => prefetchSensorGate(due, { registry })`). Il est ASYNCHRONE (un capteur fait
 * du réseau) ; `processDueWakes`, lui, reste synchrone. S'il lève, le tick réveille sans porte.
 */
export function startScheduler(
  store: WakeStore,
  onEvent: (ev: WakeEvent) => void,
  intervalMs = 60_000,
  prefetchGate?: (due: WakeRow[]) => Promise<WakeGate | undefined>,
): NodeJS.Timeout {
  let running = false; // garde-fou : un tick ne doit pas chevaucher le suivant.
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let gate: WakeGate | undefined;
      if (prefetchGate) {
        try {
          gate = await prefetchGate(store.dueWakes(Date.now()));
        } catch (e) {
          console.error("[scheduler] porte indisponible, tick sans porte :", (e as Error).message);
        }
      }
      processDueWakes(store, onEvent, Date.now(), maxWakesPerDay(), gate);
    } catch (e) {
      console.error("[scheduler] tick en erreur :", (e as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // ne bloque pas l'arrêt du process
  console.log(`[scheduler] actif (tick ${intervalMs / 1000}s, budget ${maxWakesPerDay()} réveils/24h)`);
  return timer;
}
