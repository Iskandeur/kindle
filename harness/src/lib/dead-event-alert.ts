/**
 * dead-event-alert — NOMMER la lane qui vient de mourir, et lui donner SON épisode d'alerte. PUR.
 *
 * Deux besoins, une seule source de vérité (sinon ils divergent) :
 *  - le LABEL montré à l'humain (« la veille du canal « x » a échoué ») — un message de l'humain est
 *    un message à lui, tout le reste est une lane de fond dont rien n'est perdu ;
 *  - la CLÉ d'épisode passée à ton mécanisme d'alertes à escalade (rappels espacés 1 h → 2 h → 4 h
 *    d'une même panne).
 *
 * Pourquoi la clé doit être PAR LANE. Si l'épisode est global (`dead_event`) et que TOUT tour réussi le
 * referme, une lane de fond qui meurt toutes les 30 min voit son compteur remis à zéro par les tours
 * réussis de la conversation de l'humain, qui s'intercalent : chaque échec repart en « 1ʳᵉ alerte » et
 * l'escalade n'a jamais lieu — des dizaines de messages identiques en quelques heures, le contraire de
 * ce que l'escalade devait garantir. Une lane ne referme désormais que SON épisode.
 *
 * EXCEPTION auth : une authentification morte tue TOUTES les lanes à la fois. Là, l'épisode doit rester
 * global, sinon on remplace un spam par un autre (une alerte par lane). L'appelant force donc la clé
 * globale `dead_event` quand l'erreur est une erreur d'authentification.
 */

/** Ce qu'il faut savoir de l'évènement mort pour le situer. Structurellement compatible avec le type
 *  d'évènement entrant de ton gateway — volontairement : un adaptateur au site d'appel est une
 *  occasion d'oublier un champ, et c'est ce genre d'oubli qui fait annoncer une lane de fond comme
 *  « un de tes messages ». */
export interface DeadEventLane {
  /** `message` / `whatsapp` = un message de l'humain ; `cron` = tâche périodique ; autre = réveil. */
  source?: string;
  sessionChannel?: string;
  taskId?: string;
  jobWake?: { jobId: number } | null;
}

/** Clé d'épisode + libellé de l'origine (`null` = un message de l'humain, rien à situer). */
export interface DeadEventOrigin {
  key: string;
  label: string | null;
}

/** Les sources qui sont un message de l'humain lui-même. */
const HUMAN_SOURCES = new Set(["message", "whatsapp"]);

/**
 * Situe l'évènement mort. Sans lane ou source humaine → épisode global et pas de libellé : c'est SON
 * message, l'alerte dit « un de tes messages n'a pas pu être traité ».
 *
 * Granularité des clés : nominative là où l'ensemble est petit et stable (les canaux), par KIND ailleurs
 * (tâches, jobs — leurs identifiants sont sans fin, et une clé par id ferait grossir le magasin de
 * réglages indéfiniment pour un gain nul : deux jobs qui meurent de causes différentes ont de toute
 * façon des signatures différentes, donc des épisodes distincts).
 */
export function deadEventOrigin(lane?: DeadEventLane | null): DeadEventOrigin {
  if (!lane || (lane.source !== undefined && HUMAN_SOURCES.has(lane.source))) return { key: "dead_event", label: null };
  if (lane.jobWake) return { key: "dead_event:job", label: `le rapport du job #${lane.jobWake.jobId}` };
  if (lane.sessionChannel) {
    return { key: `dead_event:channel:${lane.sessionChannel}`, label: `la veille du canal « ${lane.sessionChannel} »` };
  }
  if (lane.taskId) return { key: "dead_event:task", label: `la veille de la tâche ${lane.taskId}` };
  if (lane.source === "cron") return { key: "dead_event:cron", label: "une tâche périodique" };
  return { key: "dead_event:wake", label: "un réveil programmé" };
}
