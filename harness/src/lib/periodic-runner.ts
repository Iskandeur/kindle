/**
 * periodic-runner — LA boucle périodique du daemon, écrite une seule fois.
 *
 * Un daemon accumule vite des tâches d'entretien (nettoyage de disque, sauvegardes, classification,
 * synchronisations) qui réécrivent chacune le même quatuor : lire/écrire un état sur trois clés de
 * réglages, un `checkDue` identique à la ligne près, un `tick` qui convertit le travail en RÉSULTAT sans
 * jamais laisser lever, un `start` avec `setInterval` + `unref` + premier `setTimeout`. Quand une leçon
 * est apprise dans l'un (le `try` autour du point d'injection, le verrou contre deux passages
 * concurrents), elle doit être reportée à la main dans tous les autres — et ne l'est pas toujours. Ici,
 * elle s'applique à tous par construction.
 *
 * L'ordre du tick est la loi de ce fichier, et il n'est PAS configurable :
 *
 *     échéance → travail (dans un try) → évaluation → ÉTAT → ALERTE → I/O best-effort
 *
 *  - L'ÉTAT d'abord : *dans une boucle à curseur, tout ce qui peut échouer sans faire avancer le
 *    curseur se répète à l'identique pour toujours*. Le `try` autour de `run` garantit qu'une exception
 *    au point d'injection devient un résultat et compte un échec.
 *  - L'ALERTE ensuite, AVANT tout I/O accessoire : l'alerte d'échec est la seule raison d'être du
 *    réveil. Un runner qui fait `écrire état → commande externe lente → alerte` laisse une commande
 *    figée 15 s retarder — ou emporter — le seul message qui comptait.
 *  - Le best-effort en dernier, dans son propre `try` : un miroir d'état vers une base, un historique
 *    sur disque, une indexation en process enfant. Il peut échouer, il ne peut rien casser.
 *
 * Trois formes de runner passent par ici :
 *  1. échéance + pause : `checkDue` par défaut, alerte au Nᵉ échec (à toi de la décider dans `evaluate`) ;
 *  2. échéance + backoff sans pause : `isDue` propre, `stampBeforeRun` (l'horodatage est posé AVANT le
 *     travail), `precheck` (disque plein, réseau absent) ;
 *  3. curseur sans échéance, ou état hors réglages : ils empruntent la boucle (`startPeriodic` avec un
 *     `tick` à eux).
 */

/** L'évènement émis vers l'orchestrateur quand un passage demande un réveil. Structurellement
 *  compatible avec le type d'évènement entrant d'un gateway. */
export interface PeriodicEvent {
  source: "cron";
  body: string;
  ts: number;
}

export interface PeriodicState {
  /** Epoch ms du dernier passage (réussi ou non). 0 = jamais tourné. */
  lastRunMs: number;
  /** Échecs consécutifs (remis à 0 par un passage réussi). */
  consecutiveFailures: number;
  /** Pause après échecs répétés : rien ne tourne avant cet instant. 0 = pas de pause. */
  pausedUntilMs: number;
}

/** Le minimum dont ce module a besoin d'un magasin — un simple clé/valeur de réglages. */
export interface PeriodicStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  /** Optionnel : les runners qui savent s'effacer devant un job en cours l'exposent. Un job en cours ne
   *  bloque que s'il menace CE runner-là, d'où le `kind` (`spec.blockingKind`) : un entretien de disque
   *  cède à tout job, une sauvegarde de données seulement à un job qui écrit dans ce qu'elle sauvegarde. */
  hasBlockingJob?(kind: string): boolean;
}

export type DueVerdict = { due: true } | { due: false; reason: "paused" | "job-running" | "not-due" };

/** Les trois clés de réglages d'un runner, dérivées de son nom — la seule source de ces noms. */
export function stateKeys(name: string): { lastRun: string; failures: string; pausedUntil: string } {
  return {
    lastRun: `${name}_last_run_ms`,
    failures: `${name}_consecutive_failures`,
    pausedUntil: `${name}_paused_until_ms`,
  };
}

function readNumber(store: PeriodicStore, key: string): number {
  return Number(store.getSetting(key) ?? 0) || 0;
}

export function readPeriodicState(store: PeriodicStore, name: string): PeriodicState {
  const k = stateKeys(name);
  return {
    lastRunMs: readNumber(store, k.lastRun),
    consecutiveFailures: readNumber(store, k.failures),
    pausedUntilMs: readNumber(store, k.pausedUntil),
  };
}

/** Écrit les trois clés. La clé de pause n'est créée que le jour où une pause est posée (ou si elle
 *  existe déjà) : les runners sans pause gardent leurs deux clés, ceux avec pause leurs trois. */
export function writePeriodicState(store: PeriodicStore, name: string, state: PeriodicState): void {
  const k = stateKeys(name);
  store.setSetting(k.lastRun, String(state.lastRunMs));
  store.setSetting(k.failures, String(state.consecutiveFailures));
  if (state.pausedUntilMs !== 0 || store.getSetting(k.pausedUntil) !== null) {
    store.setSetting(k.pausedUntil, String(state.pausedUntilMs));
  }
}

/** L'échéance est-elle atteinte ? PURE. Pause > job en cours > intervalle, dans cet ordre. */
export function checkDue(args: { nowMs: number; state: PeriodicState; intervalMs: number; hasRunningJob: boolean }): DueVerdict {
  if (args.nowMs < args.state.pausedUntilMs) return { due: false, reason: "paused" };
  if (args.hasRunningJob) return { due: false, reason: "job-running" };
  if (args.nowMs - args.state.lastRunMs < args.intervalMs) return { due: false, reason: "not-due" };
  return { due: true };
}

export interface PeriodicOutcome<S> {
  nextState: S;
  /** true → réveiller l'agent (une session) ; sinon rien, juste une ligne de log. */
  shouldWake?: boolean;
  wakeNote?: string;
  logLine?: string;
}

/**
 * Le contrat d'un runner. Quatre paramètres de type, dont trois se déduisent seuls :
 *  - `S` : l'état (au moins les trois champs de `PeriodicState`) ;
 *  - `R` : le résultat du travail ;
 *  - `St` : le store RÉEL du runner. Sans lui, un `readState` écrit `(store: MonStore) => …` n'est pas
 *    assignable à `(store: PeriodicStore) => …` (contravariance) ;
 *  - `O` : l'issue, qui peut porter PLUS que `PeriodicOutcome` (un compteur d'octets libérés, lu par
 *    `bestEffort`). Sans lui, l'information écrite par `evaluate` serait perdue avant d'être lue.
 */
export interface PeriodicSpec<
  S extends PeriodicState,
  R,
  St extends PeriodicStore = PeriodicStore,
  O extends PeriodicOutcome<S> = PeriodicOutcome<S>,
> {
  /** Préfixe des clés de réglages (`disk_janitor`, `data_backup`…). */
  name: string;
  /** Étiquette des logs (défaut : `name`). */
  tag?: string;
  store: St;
  intervalMs: number;
  /** Le `kind` passé à `store.hasBlockingJob`. Absent = aucun job en cours ne fait taire ce runner.
   *
   *  ⚠️ **À LA MIGRATION D'UN RUNNER EXISTANT, C'EST LE CHAMP QUI S'OUBLIE EN SILENCE.** L'oublier ne
   *  casse rien de visible : `blockingKind === undefined` ⇒ `hasRunningJob = false` ⇒ le runner tourne
   *  pendant les jobs qu'il attendait avant, et aucun test existant ne tombe puisqu'ils vérifient le
   *  travail du runner, pas ce qui devait le faire taire. Avant de migrer, relève la valeur DÉJÀ en place
   *  dans le runner et reporte-la ici telle quelle — ET supprime l'appel direct dans le tick : le laisser
   *  pose la question deux fois, et le verdict du module (`reason: "job-running"`) est masqué par le
   *  retour anticipé du runner, donc les logs cessent de dire pourquoi le tour a été sauté. */
  blockingKind?: string;
  now?: () => number;
  /** Logger des messages du module ET de `outcome.logLine` (défaut : `console.log`, les messages du
   *  module étant préfixés `[tag]` ; `logLine` part verbatim, il porte déjà son préfixe). */
  log?: (line: string) => void;
  /** Surcharges pour un état plus riche que les trois clés (clés supplémentaires, fichier d'état). */
  readState?: (store: St) => S;
  writeState?: (store: St, state: S) => void;
  /** Règle d'échéance propre (backoff sans pause). Défaut : `checkDue`. */
  isDue?: (args: { nowMs: number; state: S; intervalMs: number; hasRunningJob: boolean }) => DueVerdict;
  /** Ignore l'échéance (usage : un `--force` de CLI). */
  force?: boolean;
  /** Pose `lastRunMs = maintenant` AVANT le travail : un daemon qui meurt au milieu ne rejoue pas en
   *  boucle serrée au boot. L'état final (après évaluation) l'écrase de toute façon. */
  stampBeforeRun?: boolean;
  /** Condition d'exécution vérifiée APRÈS l'échéance (ex. disque plein). `{skip}` → l'échéance est
   *  consommée (si `stampBeforeRun`), rien d'autre ne bouge, aucun échec n'est compté. */
  precheck?: () => Promise<{ skip: string } | null>;
  /** Le travail. Point d'INJECTION : s'il lève, `onThrow` convertit l'exception en résultat. */
  run: () => Promise<R>;
  onThrow: (e: Error) => R;
  /** Décision PURE : état suivant, faut-il réveiller, quoi logger. */
  evaluate: (args: { result: R; prevState: S; nowMs: number; startedMs: number }) => O;
  onEvent?: (ev: PeriodicEvent) => void;
  /** I/O accessoire, TOUJOURS après l'état et l'alerte, jamais laissé lever. */
  bestEffort?: (args: { result: R; outcome: O }) => void | Promise<void>;
}

export type TickResult<S extends PeriodicState, R, O extends PeriodicOutcome<S> = PeriodicOutcome<S>> =
  | { ran: false; reason: "paused" | "job-running" | "not-due" | "in-flight" | "skipped"; detail?: string }
  | { ran: true; result: R; outcome: O };

/**
 * Un passage est-il déjà en cours pour ce runner, dans CE process ? Le poll est un `setInterval` qui
 * n'attend pas le tick précédent : un passage plus long que `pollMs` (première moisson volumineuse, git
 * qui attend) en démarrerait un second sur le même état, et le dernier à finir écraserait l'autre.
 */
const inFlight = new Set<string>();

export async function periodicTick<
  S extends PeriodicState,
  R,
  St extends PeriodicStore = PeriodicStore,
  O extends PeriodicOutcome<S> = PeriodicOutcome<S>,
>(spec: PeriodicSpec<S, R, St, O>): Promise<TickResult<S, R, O>> {
  const now = spec.now ?? Date.now;
  const tag = spec.tag ?? spec.name;
  const emit = spec.log ?? ((line: string): void => console.log(line));
  const say = spec.log ?? ((line: string): void => console.log(`[${tag}] ${line}`));
  const readState = spec.readState ?? ((s: St): S => readPeriodicState(s, spec.name) as S);
  const writeState = spec.writeState ?? ((s: St, st: S): void => writePeriodicState(s, spec.name, st));
  const isDue = spec.isDue ?? checkDue;

  const state = readState(spec.store);
  const hasRunningJob = spec.blockingKind === undefined ? false : (spec.store.hasBlockingJob?.(spec.blockingKind) ?? false);
  if (!spec.force) {
    const verdict = isDue({ nowMs: now(), state, intervalMs: spec.intervalMs, hasRunningJob });
    if (!verdict.due) return { ran: false, reason: verdict.reason }; // silence : pas l'heure, en pause, ou un job tourne
  }
  if (inFlight.has(spec.name)) {
    say("un passage est déjà en cours — ce tick passe son tour (deux passages écriraient le même état)");
    return { ran: false, reason: "in-flight" };
  }

  const startedMs = now();
  if (spec.stampBeforeRun) spec.store.setSetting(stateKeys(spec.name).lastRun, String(startedMs));

  if (spec.precheck) {
    const pre = await spec.precheck();
    if (pre) {
      say(pre.skip);
      return { ran: false, reason: "skipped", detail: pre.skip };
    }
  }

  // Le travail est converti en RÉSULTAT, jamais laissé lever : sans ce `try`, une exception au point
  // d'injection emporterait l'écriture de l'état, donc ni `lastRunMs` ni `consecutiveFailures`
  // n'avanceraient, et le tick rejouerait à l'identique pour toujours sans jamais alerter.
  let result: R;
  inFlight.add(spec.name);
  try {
    result = await spec.run();
  } catch (e) {
    result = spec.onThrow(e as Error);
  } finally {
    // `finally` : un throw imprévu laisserait sinon le verrou fermé pour toujours.
    inFlight.delete(spec.name);
  }

  const outcome = spec.evaluate({ result, prevState: state, nowMs: now(), startedMs });

  // 1. ÉTAT — avant tout le reste, et même s'il échoue, on continue vers l'alerte.
  try {
    writeState(spec.store, outcome.nextState);
  } catch (e) {
    say(`état NON écrit (${(e as Error).message}) — le prochain passage rejouera le même travail`);
  }
  if (outcome.logLine) emit(outcome.logLine);

  // 2. ALERTE — la seule raison d'être du réveil ; rien d'accessoire ne passe avant.
  if (outcome.shouldWake && outcome.wakeNote && spec.onEvent) {
    spec.onEvent({ source: "cron", body: outcome.wakeNote, ts: now() });
  }

  // 3. I/O best-effort — miroir, historique, indexation. Peut échouer, ne casse rien.
  if (spec.bestEffort) {
    try {
      await spec.bestEffort({ result, outcome });
    } catch (e) {
      say(`I/O accessoire en échec (${(e as Error).message}) — sans conséquence sur l'état ni l'alerte`);
    }
  }

  return { ran: true, result, outcome };
}

export interface PeriodicLoopOptions {
  /** Cadence du CHECK d'échéance (pas du travail). */
  pollMs: number;
  /** Premier passage après le boot — laisse le daemon finir de démarrer, et étale les entretiens. */
  firstDelayMs: number;
  /** Ligne annoncée au démarrage (après `[tag] actif`). */
  banner?: string;
}

/** Forme « boucle nue » : le runner apporte son propre tick (curseur sans échéance). */
export interface PeriodicLoopSpec extends PeriodicLoopOptions {
  name: string;
  tag?: string;
  tick: () => Promise<unknown>;
}

/**
 * Démarre la boucle : `setInterval` + `unref` (ne retient jamais l'arrêt du daemon) + un premier
 * `setTimeout`, et le `.catch()` qui fait qu'un tick qui lève malgré tout ne tue pas le process.
 * Renvoie le timer.
 */
export function startPeriodic<
  S extends PeriodicState,
  R,
  St extends PeriodicStore = PeriodicStore,
  O extends PeriodicOutcome<S> = PeriodicOutcome<S>,
>(spec: (PeriodicSpec<S, R, St, O> & PeriodicLoopOptions) | PeriodicLoopSpec): NodeJS.Timeout {
  const tag = spec.tag ?? spec.name;
  const tick = (): void => {
    const p: Promise<unknown> = "tick" in spec ? spec.tick() : periodicTick(spec);
    p.catch((e) => console.error(`[${tag}] tick échoué:`, (e as Error).message));
  };
  const timer = setInterval(tick, spec.pollMs);
  timer.unref?.();
  setTimeout(tick, spec.firstDelayMs).unref?.();
  console.log(`[${tag}] actif${spec.banner ? ` (${spec.banner})` : ""}`);
  return timer;
}

/** Aide pour les bannières : « ≤ 1×/6h, check 30min ». */
export function cadenceBanner(intervalMs: number, pollMs: number): string {
  return `≤ 1×/${Math.round(intervalMs / 3_600_000)}h, check ${Math.round(pollMs / 60_000)}min`;
}
