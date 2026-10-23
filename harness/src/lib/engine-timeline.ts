/**
 * engine-timeline : QUEL MOTEUR écrivait à tel instant, lu dans le journal des tours.
 *
 * Le piège : un agent dont le moteur peut basculer (Claude, un autre modèle, un repli de secours : voir
 * `engine-failover.ts`) n'a pas UN auteur. Une mesure de voix (tics de langage, ton, longueur) calculée sur
 * une fenêtre qui chevauche une bascule mesure la plume d'un autre modèle et l'appelle la sienne. Pire, un
 * instrument qui ne sait retrouver l'auteur que dans le transcrit d'un seul moteur classe tout le reste en
 * « auteur inconnu », le mot qui laisse croire à un trou réparable alors que c'est une frontière que rien dans
 * le code ne connaissait. Une mesure de voix doit donc DÉCLARER son mélange de moteurs avant de rendre un chiffre.
 *
 * Tout est PUR (pas d'I/O) : tu lis ton journal de coûts / de tours toi-même et tu passes `{ ts, engine }`.
 */

/** Un tour payé : l'instant où il a été enregistré, et le moteur qui l'a produit. */
export interface EngineTurn {
  ts: number;
  engine: string;
}

/** Le moteur qui tenait la plume à un instant donné. `engine` absent = le journal ne sait pas. */
export interface EngineVerdict {
  engine?: string;
  /** `false` quand un changement de moteur encadre l'instant demandé, ou que le journal est trop loin :
   *  le message existe, mais son auteur ne se déduit pas d'ici. */
  certain: boolean;
}

/** Recherche binaire : index du dernier tour dont `ts <= t` (−1 si aucun). `turns` trié croissant. */
function lastAtOrBefore(turns: readonly EngineTurn[], t: number): number {
  let lo = 0, hi = turns.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid]!.ts <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * Quel moteur écrivait à l'instant `t` ?
 *
 * On encadre : le dernier tour d'avant, le premier tour d'après. S'ils s'accordent, la réponse est sûre :
 * aucun changement n'a pu se glisser entre les deux. S'ils divergent, `t` tombe DANS une bascule : on rend le
 * plus proche, mais `certain: false`, parce qu'un message écrit à cet endroit peut venir de l'une ou l'autre
 * plume et qu'aucune ne mérite d'être affirmée.
 *
 * En bord de journal (rien avant, ou rien après), on accepte le seul côté disponible s'il est à moins de
 * `toleranceMs` ; au-delà, le journal ne dit plus rien d'utile et on préfère l'avouer.
 *
 * `turns` DOIT être trié par `ts` croissant. PUR.
 */
export function engineAt(turns: readonly EngineTurn[], t: number, toleranceMs: number = ENGINE_TOLERANCE_MS): EngineVerdict {
  if (turns.length === 0) return { certain: false };
  const i = lastAtOrBefore(turns, t);
  const prev = i >= 0 ? turns[i] : undefined;
  const next = i + 1 < turns.length ? turns[i + 1] : undefined;
  if (prev && next) {
    if (prev.engine === next.engine) return { engine: prev.engine, certain: true };
    const nearer = t - prev.ts <= next.ts - t ? prev : next;
    return { engine: nearer.engine, certain: false };
  }
  const only = (prev ?? next)!;
  const gap = Math.abs(only.ts - t);
  return gap <= toleranceMs ? { engine: only.engine, certain: true } : { certain: false };
}

/** Tolérance par défaut en bord de journal : au-delà d'une heure sans le moindre tour, le journal ne prouve
 *  plus qui tenait la plume. Assez large pour couvrir un silence de nuit encadré, assez serré pour ne pas
 *  étendre un moteur sur une journée entière. */
export const ENGINE_TOLERANCE_MS = 60 * 60e3;

/** Compte les messages par moteur (`moteur?` si incertain, `?` si inconnu). Ordre décroissant. PUR. */
export function engineMix(verdicts: readonly EngineVerdict[]): Array<{ engine: string; n: number }> {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    const k = v.engine === undefined ? "?" : v.certain ? v.engine : `${v.engine}?`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([engine, n]) => ({ engine, n })).sort((a, b) => b.n - a.n || a.engine.localeCompare(b.engine));
}

/** Une plage où un seul moteur a tenu la plume, bornée par les tours qui le prouvent. */
export interface EngineSpan {
  engine: string;
  /** Premier et dernier tour de la plage (ms). Le trou avant/après appartient à la bascule, donc à personne :
   *  on ne l'inclut pas, exactement comme `engineAt` refuse de trancher dans une bascule. */
  from: number;
  to: number;
  turns: number;
}

/**
 * Les plages **à plume unique**, découpées sur les bascules de moteur et pas sur le calendrier.
 *
 * Ce que ça répare : des fenêtres de 3 jours posées sur une grille arbitraire n'ont gardé que 2 fenêtres sur 8
 * (les six autres étaient à cheval sur une bascule, donc mélangées, donc inutilisables), alors que le journal
 * contenait des centaines d'heures d'un seul moteur d'affilée. Ce n'était pas un manque de matière, c'était la
 * grille qui tombait mal. Les bascules sont connues à la seconde dans le journal : découper là où elles sont
 * transforme un « pas assez de données » en fenêtres exploitables, sans rien assouplir.
 *
 * `turns` DOIT être trié par `ts` croissant. PUR.
 */
export function singleEngineSpans(turns: readonly EngineTurn[], since?: number, until?: number): EngineSpan[] {
  const out: EngineSpan[] = [];
  let cur: EngineSpan | undefined;
  for (const t of turns) {
    if (cur !== undefined && t.engine === cur.engine) {
      cur.to = t.ts;
      cur.turns++;
      continue;
    }
    if (cur !== undefined) out.push(cur);
    cur = { engine: t.engine, from: t.ts, to: t.ts, turns: 1 };
  }
  if (cur !== undefined) out.push(cur);
  // Intersection APRÈS la construction : borner les tours d'abord découperait une plage en deux moitiés du même
  // moteur si une borne tombait au milieu, et fabriquerait une bascule qui n'existe pas.
  return out
    .map((s) => ({ ...s, from: Math.max(s.from, since ?? -Infinity), to: Math.min(s.to, until ?? Infinity) }))
    .filter((s) => s.to > s.from);
}

/**
 * Une fenêtre écrite par PLUSIEURS moteurs ne mesure pas une voix, elle en mélange deux.
 * Rend la phrase à afficher, ou `undefined` si la fenêtre est homogène. Le seuil est volontairement à zéro :
 * deux plumes, c'est déjà deux plumes. PUR.
 */
export function mixWarning(mix: ReadonlyArray<{ engine: string; n: number }>): string | undefined {
  const named = mix.filter((m) => m.engine !== "?");
  const distinct = new Set(named.map((m) => m.engine.replace(/\?$/, "")));
  if (distinct.size <= 1) return undefined;
  const parts = named.map((m) => `${m.engine} ${m.n}`).join(", ");
  return `⚠️  Cette fenêtre a été écrite par PLUSIEURS moteurs (${parts}). Les taux ci-dessus `
    + `mélangent donc des plumes différentes : ce n'est pas la mesure d'une voix. Resserrer la fenêtre `
    + `sur une période à moteur unique avant de conclure quoi que ce soit.`;
}
