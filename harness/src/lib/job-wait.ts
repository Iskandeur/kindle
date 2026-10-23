/**
 * Attendre des jobs depuis une session interactive : une ligne par job qui atterrit, une ligne
 * « toujours en vol » à intervalle borné, un plafond d'attente.
 *
 * Pensé pour tourner sous un moniteur de session (chaque ligne émise devient une notification), de sorte
 * que la session n'ait plus à demander « où en est-on ». La logique est ici, sans base ni horloge
 * (lecture, sommeil et temps sont injectés), pour être testée.
 */

/** Statuts après lesquels un job ne bougera plus. */
export const FINAL_STATUSES: ReadonlySet<string> = new Set(["done", "error", "cancelled", "dismissed"]);

export interface JobSeen {
  id: number;
  status: string;
  intent: string;
  result?: string | null;
}

export interface WaitOptions {
  getJob: (id: number) => JobSeen | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Délai entre deux lectures (défaut 15 s). */
  pollMs?: number;
  /** Intervalle de la ligne « toujours en vol » (défaut 30 min). */
  heartbeatMs?: number;
  /** Plafond d'attente totale ; au-delà, on rend la main (défaut 6 h). */
  maxMs?: number;
}

function firstLine(texte: string | null | undefined, max = 160): string {
  const l = (texte ?? "").split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "(pas de résultat)";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

export function landingLine(j: JobSeen): string {
  return `#${j.id} [${j.status}] ${j.intent.replace(/\s+/g, " ").slice(0, 60)} — ${firstLine(j.result)}`;
}

/**
 * Émet une ligne par job qui atteint un statut final, une ligne `⏳` toutes les `heartbeatMs` tant qu'il en
 * reste, et se termine quand tous ont atterri ou à `maxMs`. Un id inconnu est dit une fois et n'est plus attendu.
 *
 * Attention : « statut final » n'est pas « travail atterri » (voir `job-landed.ts`).
 */
export async function* waitForJobs(ids: number[], o: WaitOptions): AsyncGenerator<string> {
  const pollMs = o.pollMs ?? 15_000;
  const heartbeatMs = o.heartbeatMs ?? 30 * 60_000;
  const maxMs = o.maxMs ?? 6 * 3_600_000;
  const start = o.now();
  let lastSign = start;
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    for (const id of [...remaining]) {
      const j = o.getJob(id);
      if (!j) {
        remaining.delete(id);
        yield `#${id} inconnu`;
      } else if (FINAL_STATUSES.has(j.status)) {
        remaining.delete(id);
        yield landingLine(j);
      }
    }
    if (remaining.size === 0) return;
    const t = o.now();
    if (t - start >= maxMs) {
      yield `⏳ plafond d'attente atteint, encore en vol : ${[...remaining].map((i) => `#${i}`).join(" ")}`;
      return;
    }
    if (t - lastSign >= heartbeatMs) {
      lastSign = t;
      yield `⏳ toujours en vol : ${[...remaining].map((i) => `#${i}`).join(" ")}`;
    }
    await o.sleep(pollMs);
  }
}
