/**
 * Drainage avant rechargement du daemon : « un rechargement ordinaire ne coupe JAMAIS un job ».
 *
 * Le piège : un auto-rechargement qui attend une « fenêtre calme » (plus aucun job en vol) avant de
 * redémarrer sur le code neuf meurt de FAMINE dès que le runner de jobs ENCHAÎNE les jobs : il n'y a jamais
 * de trou. On finit par forcer le redémarrage après N minutes, et chaque redémarrage forcé coupe des jobs en
 * vol. Un job coupé se reprend (`--resume`, même worktree) mais le tour en cours est perdu : du travail
 * refait, et une réalisation plus lente que prévu.
 *
 * Le remède n'est pas d'attendre plus longtemps une fenêtre qui ne vient pas : c'est de la **fabriquer**.
 * Dès qu'une cause de rechargement existe, le runner cesse de RÉCLAMER de nouveaux jobs. Les jobs en vol
 * finissent leur tour ; le premier tic où plus rien ne tourne redémarre le daemon, et les jobs restés en file
 * sont pris par le daemon neuf.
 *
 * Le drainage a une limite (`maxMs`). Au-delà, il N'INTERROMPT TOUJOURS PAS : il rend la réclamation au
 * runner et retente plus tard (`pauseMs`), pour que la file ne reste pas gelée des heures derrière un seul
 * job long. Mais l'alternance limite/pause ne peut pas durer toujours :
 *
 * BORNE DURE (qui ne tue pas non plus) : un code périmé ne peut pas durer indéfiniment derrière un job
 * « éternel » toujours en vol quand le drainage expire. Passé `hardAfterMs` d'attente continue, le drainage
 * N'EXPIRE PLUS : la file reste fermée aux nouveaux jobs jusqu'à ce que les jobs en vol aient fini, puis le
 * daemon redémarre. Exception tranchée : un job marqué urgent (`[urgent]` en tête de l'intent) est encore
 * réclamé. Contrepartie assumée : il tourne sur le code périmé et retient le redémarrage le temps qu'il dure.
 *
 * Seule une cause URGENTE (correctif de sécurité) peut couper un job en vol :
 *   - une ligne `Urgent-Reload: yes` dans le message d'un commit pas encore chargé par le daemon ;
 *   - ou un drapeau (fichier JSON) posé par un outil, valable jusqu'au prochain boot.
 * Même une cause urgente ne coupe jamais une SESSION de conversation en vol.
 *
 * Deux leçons de réglage :
 *   1. Un drainage qui gèle la file trop longtemps (45 min) coûte cher : 20 min de drainage + 30 min de pause
 *      gèlent 40 % du temps, contre 60 % pour 45/30. La borne dure garantit quand même le déploiement.
 *   2. Une rafale de fusions ne doit ouvrir qu'UN drainage : on attend un délai de calme sur la branche
 *      principale (`quietMs`) avant d'ouvrir le drainage, sauf si une fenêtre calme se présente d'elle-même
 *      (rien n'est gelé, on recharge tout de suite).
 *
 * Ce module est PUR et sans import lourd : le runner de jobs le lit à chaque tic. L'état vit dans un magasin
 * clé/valeur (`DrainStore`) : chaque clé porte un horodatage en epoch ms, "" = absent.
 */

export interface DrainConfig {
  /** Durée maximale d'un drainage : au-delà, la réclamation reprend (sans rien couper). */
  maxMs: number;
  /** Pause entre deux drainages après une limite atteinte : la file repart, puis on retente. */
  pauseMs: number;
  /** Tolérance de lecture côté runner : un drapeau plus vieux que `maxMs + slackMs` est orphelin (le check
   *  d'auto-rechargement ne tourne plus), le runner l'ignore. La file ne reste JAMAIS gelée par un état périmé. */
  slackMs: number;
  /** Attente continue au-delà de laquelle le drainage n'expire plus. */
  hardAfterMs: number;
  /** Délai de calme de la branche principale avant d'ouvrir un drainage (une rafale de fusions = un drainage). */
  quietMs: number;
}

export const DEFAULT_DRAIN: DrainConfig = {
  maxMs: 20 * 60_000,
  pauseMs: 30 * 60_000,
  slackMs: 10 * 60_000,
  hardAfterMs: 3 * 3_600_000,
  quietMs: 10 * 60_000,
};

/** Début de l'ÉPISODE d'attente : ne repart pas à zéro à chaque limite/pause, seulement quand la cause
 *  disparaît (rechargement, veto, plus de cause). C'est lui que la borne dure compare à `hardAfterMs`. */
export const DRAIN_EPISODE_KEY = "reload_drain_episode_since";
/** Battement du drainage DUR (epoch ms du dernier tic qui l'a confirmé). Un battement qui cesse (check mort)
 *  expire en `slackMs` : la file ne reste jamais gelée par un état périmé. */
export const DRAIN_HARD_KEY = "reload_drain_hard_at";
/** Début du drainage en cours ("" = pas de drainage). */
export const DRAIN_SINCE_KEY = "reload_drain_since";
/** Fin de la pause qui suit une limite de drainage atteinte ("" = pas de pause). */
export const DRAIN_PAUSE_KEY = "reload_drain_pause_until";

/** Lecture seule du magasin (un faux objet suffit en test). */
export interface DrainStore {
  getSetting(key: string): string | null | undefined;
}

/** Le calme de la branche principale est-il acquis (dernier commit utile vieux de `quietMs`) ? Inconnu : oui
 *  (on ne bloque pas un déploiement sur un git illisible). PUR. */
export function burstOver(lastUsefulCommitMs: number | null | undefined, now: number, cfg: DrainConfig = DEFAULT_DRAIN): boolean {
  if (!lastUsefulCommitMs || !Number.isFinite(lastUsefulCommitMs)) return true;
  return now - lastUsefulCommitMs >= cfg.quietMs;
}

/**
 * Quels chemins du dépôt rendent le daemon périmé ? Le daemon charge ses sources au boot ; les binaires
 * lancés comme process neufs relisent le disque à chaque appel, les tests ne sont jamais importés par une
 * source : les modifier ne rend pas le daemon périmé.
 */
export interface ReloadPathRules {
  /** Préfixe du dossier du daemon (ex. `harness/`). Hors de lui : jamais de rechargement. */
  root: string;
  /** Sous-arbres du dossier que le daemon ne lit pas à l'exécution. */
  ignoredPrefixes?: readonly string[];
  /** Dossier des binaires lancés en process neuf (ex. `harness/bin/`) : ignoré sauf les fichiers de `loadedBins`. */
  binPrefix?: string;
  /** Fichiers de `binPrefix` que le daemon IMPORTE (donc charge au boot). Un test doit scanner `src/` et
   *  échouer si un import apparaît sans être ici. */
  loadedBins?: readonly string[];
  /** Suffixe des fichiers de test (défaut `.test.ts`). */
  testSuffix?: string;
}

/** Ce chemin (relatif à la racine du dépôt) fait-il partie de ce que le daemon a chargé ? Tout le reste du
 *  dossier du daemon (src, config, persona, package.json…) : oui, par prudence. PUR. */
export function pathReloadsDaemon(path: string, rules: ReloadPathRules): boolean {
  const p = path.trim();
  if (!p.startsWith(rules.root)) return false;
  if ((rules.ignoredPrefixes ?? []).some((d) => p.startsWith(d))) return false;
  if (p.endsWith(rules.testSuffix ?? ".test.ts")) return false;
  if (rules.binPrefix && p.startsWith(rules.binPrefix)) return (rules.loadedBins ?? []).includes(p);
  return true;
}

/** Une liste de chemins contient-elle au moins un fichier chargé par le daemon ? PUR. */
export function pathsReload(paths: readonly string[], rules: ReloadPathRules): boolean {
  return paths.some((p) => pathReloadsDaemon(p, rules));
}

/** Le drainage est-il DUR (borne franchie, battement frais) ? Défensif : illisible, vide ou périmé : non. */
export function drainHard(db: DrainStore, now: number, cfg: DrainConfig = DEFAULT_DRAIN): boolean {
  const at = Number.parseInt(db.getSetting(DRAIN_HARD_KEY) ?? "", 10);
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  if (age < 0) return true; // horloge qui recule : par prudence on laisse drainer (le TTL rattrape)
  return age <= cfg.slackMs;
}

/** Le runner de jobs doit-il s'abstenir de réclamer à `now` ? Défensif : illisible, vide ou périmé : non.
 *  (En drainage DUR il réclame encore les seuls `[urgent]` : voir `drainMode`.) */
export function drainActive(db: DrainStore, now: number, cfg: DrainConfig = DEFAULT_DRAIN): boolean {
  if (drainHard(db, now, cfg)) return true;
  const since = Number.parseInt(db.getSetting(DRAIN_SINCE_KEY) ?? "", 10);
  if (!Number.isFinite(since) || since <= 0) return false;
  const age = now - since;
  if (age < 0) return true;
  return age <= cfg.maxMs + cfg.slackMs;
}

/** Ce que le runner de jobs a le droit de réclamer : `off` = tout, `soft` = rien, `hard` = les seuls `[urgent]`. */
export type DrainMode = "off" | "soft" | "hard";
export function drainMode(db: DrainStore, now: number, cfg: DrainConfig = DEFAULT_DRAIN): DrainMode {
  if (drainHard(db, now, cfg)) return "hard";
  return drainActive(db, now, cfg) ? "soft" : "off";
}

/** Un job peut-il être réclamé dans ce mode de drainage ? `[urgent]` en tête de l'intent passe même en dur. PUR. */
export function mayClaim(mode: DrainMode, job: { intent: string }): boolean {
  if (mode === "off") return true;
  if (mode === "hard") return /^\s*\[urgent\]/i.test(job.intent);
  return false;
}

export type DrainStep = "start" | "continue" | "limit" | "paused" | "hard";

/**
 * Où en est le drainage ? PUR.
 *  - `hard`     : l'attente dure depuis `hardAfterMs` (épisode, pauses comprises) : le drainage n'expire plus,
 *                 il continue jusqu'à ce que plus rien ne tourne (rien n'est coupé) ;
 *  - `paused`   : une pause suit une limite atteinte : on ne draine pas ;
 *  - `start`    : aucun drainage en cours : il commence maintenant ;
 *  - `continue` : en cours, sous la limite ;
 *  - `limit`    : en cours depuis `maxMs` : on rend la réclamation (sans couper) et on pause.
 */
export function drainStep(
  sinceMs: number | null | undefined,
  pausedUntilMs: number | null | undefined,
  now: number,
  episodeSinceMs?: number | null,
  cfg: DrainConfig = DEFAULT_DRAIN,
): DrainStep {
  if (episodeSinceMs && now - episodeSinceMs >= cfg.hardAfterMs) return "hard";
  if (pausedUntilMs && now < pausedUntilMs) return "paused";
  if (!sinceMs) return "start";
  return now - sinceMs >= cfg.maxMs ? "limit" : "continue";
}

/** `Urgent-Reload: yes` seul sur sa ligne (casse libre ; yes/true/oui). */
const URGENT_TRAILER_RE = /^[ \t]*urgent-reload[ \t]*:[ \t]*(?:yes|true|oui)[ \t]*$/im;

/**
 * La première cause urgente dans une pile de messages de commit (séparés par U+001E, la sortie de
 * `git log --format=%B%x1e`), ou null. Rend le sujet du commit marqué, tronqué. PUR.
 * La marque doit être une LIGNE À PART : « Urgent-Reload: yes » cité en prose au milieu d'une phrase ne compte pas.
 */
export function urgentFromCommitMessages(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const msg of raw.split("\u001e")) {
    if (!URGENT_TRAILER_RE.test(msg)) continue;
    const subject = msg.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !URGENT_TRAILER_RE.test(l)) ?? "commit marqué";
    return subject.slice(0, 120);
  }
  return null;
}

/** Un drapeau d'urgence n'est lu que ce temps : un drapeau oublié ne rend pas urgent un rechargement futur. */
export const URGENT_FLAG_MAX_MS = 24 * 3_600_000;

export interface ReloadUrgency {
  reason: string;
  setAt: number;
  by: string;
}

/** Un drapeau d'urgence à écrire (JSON). PUR. */
export function makeUrgency(reason: string, now: number, by = "operator"): ReloadUrgency {
  return { reason: reason.trim().slice(0, 300) || "urgence sans raison", setAt: now, by };
}

/**
 * La raison d'un drapeau d'urgence en vigueur, ou null. PUR.
 * « En vigueur » = posé APRÈS le boot du daemon courant (un redémarrage le consomme tout seul : le code qu'il
 * voulait charger l'est) et il y a moins de 24 h. Illisible, mal daté ou antérieur au boot : null, jamais un
 * ordre de couper par défaut.
 */
export function urgencyInForce(text: string | null | undefined, now: number, bootedAtMs: number): string | null {
  if (!text) return null;
  try {
    const u = JSON.parse(text) as Partial<ReloadUrgency>;
    if (typeof u.reason !== "string" || typeof u.setAt !== "number") return null;
    if (u.setAt <= bootedAtMs) return null; // consommé par le boot qui a suivi
    if (u.setAt > now + 60_000) return null; // posé « dans le futur » : horloge douteuse
    if (now - u.setAt > URGENT_FLAG_MAX_MS) return null;
    return u.reason.trim().slice(0, 120) || "urgence sans raison";
  } catch {
    return null;
  }
}
