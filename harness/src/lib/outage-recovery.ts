/**
 * outage-recovery : REPRENDRE LE FIL après une panne d'authentification du moteur.
 *
 * Le piège : sans ce module, une auth morte (abonnement désactivé, « Not logged in ») est une erreur
 * DÉFINITIVE pour tout ce qui n'est pas un job : l'évènement est acquitté, une alerte part, et quand l'auth
 * revient plus rien ne s'en souvient. Les veilles dont le capteur a déjà consommé le changement sont perdues
 * sans trace. Seuls les jobs (qui attendent) et les capteurs qui re-tirent d'eux-mêmes survivent, par hasard.
 *
 * Mécanique, en trois temps :
 *  1. PENDANT la panne, chaque évènement mort sur une erreur d'auth est inscrit au registre, dédoublonné par
 *     origine (une veille qui meurt 10 fois = une ligne, son dernier corps, un compteur) et plafonné ;
 *  2. AU PREMIER TOUR QUI ABOUTIT, l'orchestrateur prend le registre (`takeOutageRecovery`, qui le vide) : les
 *     jobs mis en attente pour auth morte repartent tout de suite, et UN réveil de reprise part avec
 *     l'inventaire (`recoveryWakeBody`) ;
 *  3. si ce réveil de reprise meurt à son tour (l'auth retombe), son inventaire est REMIS au registre
 *     (`restoreOutageRecovery`) au lieu d'être inscrit comme une victime de plus : sinon chaque rechute
 *     emboîterait le registre précédent dans un corps tronqué.
 *
 * Deux détails qui comptent :
 *  - le registre note le MOTEUR dont l'auth est morte : seul un succès DE CE MOTEUR prouve qu'elle est
 *    revenue (`outageDeadEngine`). Un tour d'un autre moteur qui aboutit pendant la panne déclencherait sinon
 *    une reprise routée sur le moteur à terre, qui mourrait, serait remise au registre, et recommencerait au
 *    prochain tour de l'autre moteur ;
 *  - le plafond garde les messages d'humain d'abord (ce qu'il a écrit compte plus qu'une veille), puis les
 *    plus récents : une panne de plusieurs heures ne fait pas grossir le magasin sans fin.
 *
 * PUR à l'exception du magasin clé/valeur `settings` injecté (testable sans base).
 */

export interface OutageStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

/** Ce qu'il faut retenir d'un évènement mort pour pouvoir le refaire. */
export interface OutageCasualty {
  /** Clé de dédoublonnage (origine stable : capteur, tâche, canal, message). */
  key: string;
  /** Libellé humain (« message WhatsApp », « veille xyz », …). */
  label: string;
  /** Corps de l'évènement, tronqué : de quoi le refaire sans le relire ailleurs. */
  body: string;
  firstAt: number;
  lastAt: number;
  count: number;
  chatId?: string;
  taskId?: string;
  sensor?: string;
}

export interface OutageRecord {
  startedAt: number;
  endedAt: number;
  casualties: OutageCasualty[];
  /** Cause brute de la première mort (pour dire de QUELLE panne on revient). */
  cause: string;
}

/** Sous-ensemble d'un évènement entrant utile ici (compatibilité structurelle). */
export interface OutageEventLike {
  source?: string;
  body?: string;
  chatId?: string;
  author?: string;
  msgId?: string;
  taskId?: string;
  taskTitle?: string;
  wakeSensor?: string;
  wakeId?: number;
  sessionChannel?: string;
  isGroup?: boolean;
  jobWake?: { jobId: number } | null;
  reaction?: { emoji: string } | null;
}

const KEY_CASUALTIES = "outage_casualties";
const KEY_STARTED = "outage_started_at";
const KEY_CAUSE = "outage_cause";
const KEY_ENGINE = "outage_engine";
export const MAX_CASUALTIES = 40;
export const BODY_MAX = 1500;

function readList(store: OutageStore): OutageCasualty[] {
  const raw = store.getSetting(KEY_CASUALTIES);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as OutageCasualty[]) : [];
  } catch {
    return [];
  }
}

/** Origine stable d'un évènement : deux morts de la même veille / tâche se fusionnent ; deux messages
 *  distincts restent distincts (msgId, sinon corps). */
export function casualtyKeyAndLabel(ev: OutageEventLike): { key: string; label: string } {
  if (ev.jobWake) return { key: `job:${ev.jobWake.jobId}`, label: `rapport du job #${ev.jobWake.jobId}` };
  if (ev.taskId) return { key: `task:${ev.taskId}`, label: `fil de la tâche ${ev.taskTitle ? `« ${ev.taskTitle} »` : ev.taskId}` };
  if (ev.sessionChannel) return { key: `channel:${ev.sessionChannel}`, label: `veille du canal « ${ev.sessionChannel} »` };
  if (ev.wakeSensor) return { key: `sensor:${ev.wakeSensor}`, label: `veille ${ev.wakeSensor}` };
  if (ev.source === "whatsapp" || ev.source === "dashboard") {
    const who = ev.isGroup ? `message de groupe (${ev.chatId ?? "?"})` : ev.source === "dashboard" ? "message du dashboard" : "message WhatsApp";
    const kind = ev.reaction ? `réaction ${ev.reaction.emoji}` : who;
    const id = ev.msgId ?? `${ev.chatId ?? ""}:${(ev.body ?? "").slice(0, 80)}`;
    return { key: `msg:${id}`, label: kind };
  }
  if (ev.wakeId !== undefined) return { key: `wake:${ev.wakeId}`, label: `réveil programmé #${ev.wakeId}` };
  return { key: `${ev.source ?? "wake"}:${(ev.body ?? "").slice(0, 80)}`, label: ev.source === "cron" ? "tâche périodique" : "réveil" };
}

/** Inscrit un évènement mort sur une auth morte. Ouvre l'épisode s'il n'existe pas. */
export function recordOutageCasualty(store: OutageStore, ev: OutageEventLike, cause: string, now: number, engine?: string): void {
  if (!store.getSetting(KEY_STARTED)) {
    store.setSetting(KEY_STARTED, String(now));
    store.setSetting(KEY_CAUSE, cause.slice(0, 300));
  }
  if (engine && !store.getSetting(KEY_ENGINE)) store.setSetting(KEY_ENGINE, engine);
  const list = readList(store);
  const { key, label } = casualtyKeyAndLabel(ev);
  const body = (ev.body ?? "").slice(0, BODY_MAX);
  const hit = list.find((c) => c.key === key);
  if (hit) {
    hit.lastAt = now;
    hit.count += 1;
    hit.body = body || hit.body; // le DERNIER corps : une veille dit l'état le plus récent
  } else {
    list.push({
      key, label, body, firstAt: now, lastAt: now, count: 1,
      ...(ev.chatId ? { chatId: ev.chatId } : {}),
      ...(ev.taskId ? { taskId: ev.taskId } : {}),
      ...(ev.wakeSensor ? { sensor: ev.wakeSensor } : {}),
    });
  }
  if (list.length > MAX_CASUALTIES) {
    list.sort((a, b) => Number(b.key.startsWith("msg:")) - Number(a.key.startsWith("msg:")) || b.lastAt - a.lastAt);
    list.length = MAX_CASUALTIES;
  }
  store.setSetting(KEY_CASUALTIES, JSON.stringify(list));
}

/** Une panne est-elle ouverte (au moins une victime inscrite) ? */
export function outageOpen(store: OutageStore): boolean {
  return !!store.getSetting(KEY_STARTED);
}

/** Le moteur dont l'auth est morte (vide = inconnu). */
export function outageDeadEngine(store: OutageStore): string {
  return store.getSetting(KEY_ENGINE) ?? "";
}

/** Prend ET vide le registre. `null` si aucune panne n'est ouverte. Appelé au premier tour qui aboutit :
 *  c'est la preuve qu'on peut de nouveau raisonner. */
export function takeOutageRecovery(store: OutageStore, now: number): OutageRecord | null {
  const started = Number(store.getSetting(KEY_STARTED) || 0);
  if (!started) return null;
  const rec: OutageRecord = {
    startedAt: started,
    endedAt: now,
    casualties: readList(store),
    cause: store.getSetting(KEY_CAUSE) ?? "",
  };
  store.setSetting(KEY_STARTED, "");
  store.setSetting(KEY_CASUALTIES, "");
  store.setSetting(KEY_CAUSE, "");
  store.setSetting(KEY_ENGINE, "");
  return rec;
}

/** Le réveil de reprise est mort (rechute) : on remet son inventaire au registre, fusionné avec ce qui a pu y
 *  être inscrit depuis. Le début de panne reste le plus ancien des deux. */
export function restoreOutageRecovery(store: OutageStore, rec: OutageRecord, engine?: string): void {
  if (engine && !store.getSetting(KEY_ENGINE)) store.setSetting(KEY_ENGINE, engine);
  const started = Number(store.getSetting(KEY_STARTED) || 0);
  store.setSetting(KEY_STARTED, String(started ? Math.min(started, rec.startedAt) : rec.startedAt));
  if (!store.getSetting(KEY_CAUSE)) store.setSetting(KEY_CAUSE, rec.cause);
  const list = readList(store);
  for (const c of rec.casualties) {
    const hit = list.find((x) => x.key === c.key);
    if (hit) {
      hit.firstAt = Math.min(hit.firstAt, c.firstAt);
      hit.count += c.count;
    } else list.push(c);
  }
  store.setSetting(KEY_CASUALTIES, JSON.stringify(list.slice(0, MAX_CASUALTIES)));
}

function hhmm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/**
 * Corps du réveil de reprise. `releasedJobs` : ids des jobs remis en route à l'instant. `tz` : fuseau des
 * heures affichées (UTC par défaut). Le corps est écrit à la première personne de l'agent.
 */
export function recoveryWakeBody(rec: OutageRecord, releasedJobs: number[] = [], tz = "UTC"): string {
  const lines: string[] = [
    `[🔁 REPRISE APRÈS PANNE : mon moteur était hors service de ${hhmm(rec.startedAt, tz)} à ${hhmm(rec.endedAt, tz)} (${tz}, ~${minutes(rec.endedAt - rec.startedAt)})]`,
    `Cause de la panne : ${rec.cause || "(inconnue)"}`,
    "",
    "Consigne permanente de mon humain : dès que c'est réglé, je reprends le fil, je regarde ce que j'ai",
    "raté, et je me remets au boulot. C'est ce réveil. Pas de récit de panne : du travail repris.",
    "",
  ];
  if (releasedJobs.length > 0) {
    lines.push(`Jobs en attente pour auth morte, relancés à l'instant par le daemon : ${releasedJobs.map((id) => `#${id}`).join(", ")} (rien à faire, leur rapport arrivera seul).`, "");
  }
  if (rec.casualties.length === 0) {
    lines.push("Aucun évènement inscrit comme perdu (la panne a peut-être été courte, ou seuls des jobs ont attendu).");
  } else {
    lines.push(`Évènements morts pendant la panne (${rec.casualties.length}, dédoublonnés par origine) :`);
    rec.casualties.forEach((c, i) => {
      const times = c.count > 1 ? `${c.count} fois, ${hhmm(c.firstAt, tz)}→${hhmm(c.lastAt, tz)}` : hhmm(c.lastAt, tz);
      lines.push("", `── ${i + 1}. ${c.label} (${times})${c.chatId ? ` · chat ${c.chatId}` : ""}`, c.body || "(corps vide)");
    });
  }
  lines.push(
    "",
    "À faire, dans l'ordre :",
    "1. Pour chaque évènement ci-dessus : vérifie s'il a été traité depuis (un retry, une autre voie, une",
    "   veille qui a re-tiré). Déjà fait : rien. Encore utile : fais-le maintenant. Périmé : laisse.",
    "2. Balaie ce qui ne passe PAS par ce registre : le 1:1 avec mon humain et les groupes où je suis présent,",
    "   sur la fenêtre de la panne. Un message resté sans réponse : j'y réponds.",
    "3. Un message à mon humain SEULEMENT si j'ai repris quelque chose qui le concerne (réponse due, action",
    "   faite) : court, ce qui est repris, pas la chronique de la panne. Il sait déjà qu'elle a eu lieu.",
  );
  return lines.join("\n");
}
