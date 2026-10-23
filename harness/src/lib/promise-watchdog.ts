/**
 * promise-watchdog — FILET PROMESSE-SANS-RÉVEIL : ne plus jamais laisser une promesse de suivi partir
 * sans mécanisme derrière.
 *
 * Un agent n'est pas un process qui attend : il s'ÉTEINT entre deux réveils. Quand il écrit « je te tiens au
 * courant dès qu'il répond » ou « je retente dans quelques minutes » sans qu'aucun réveil programmé ne soit
 * armé, la promesse est structurellement intenable, et c'est TOUJOURS l'humain qui doit relancer pour que
 * l'agent resurgisse. Une note dans la mémoire (« dès que je dis "je reviens vers toi", le geste suivant est
 * de programmer un réveil ») récidive : elle ne suffit pas, il faut un mécanisme.
 *
 * Ce module ferme l'écart : après un tour qui envoie un message contenant une promesse de suivi, le daemon
 * vérifie qu'un réveil a bien été armé PENDANT ce tour (le compteur « réveils créés depuis » est à toi).
 * Sinon : UNE relance, dans la MÊME session (le tour qui a promis est encore en contexte), qui force la
 * décision — armer maintenant, ou dire pourquoi ce n'en était pas une.
 *
 * Détection mécanique et large (un faux positif coûte un aller-retour silencieux ; une promesse oubliée
 * coûte une relance agacée), jugement délégué à la relance elle-même. Plafond quotidien (`PROMISE_DAILY_CAP`).
 */
import { excerptAround } from "./friction-detect.ts";

/** Combien de relances « promesse sans réveil » au maximum par jour. Au-delà, mieux vaut regarder le sujet
 *  de fond au rêve de la nuit qu'enchaîner les relances silencieuses. */
export const PROMISE_DAILY_CAP = 4;

export interface PromiseSignal {
  /** Le fragment exact qui a mordu : cité tel quel dans la relance, pour partir du RÉEL. */
  evidence: string;
}

/**
 * Motifs de promesse de suivi qui annoncent un RETOUR futur — pas toute mention du futur (« je vais manger »
 * n'en est pas une). Un « je vérifie » nu est trop fréquent et non daté pour compter ; il ne mord que
 * combiné à un horizon explicite (dans / d'ici / in / within).
 */
export const DEFAULT_PROMISE_PATTERNS: RegExp[] = [
  /\bje\s+(?:te|vous)\s+tiens\s+au\s+courant\b/i,
  /\bje\s+(?:te|vous)\b[^.!?]{0,60}\bd[eè]s\s+qu[e']/i,
  /\bje\s+(?:re)?viens\s+vers\s+(?:toi|vous)\b/i,
  /\bje\s+laisse\s+(?:retomber|passer)\b/i,
  /\bje\s+(?:vais\s+)?r[ée]essa(?:ie|yer)(?:rai)?\b/i,
  /\bje\s+(?:vais\s+)?retente(?:r|rai)?\b/i,
  /\bje\s+(?:vais\s+)?relance(?:r|rai)?\b/i,
  /\bje\s+repasse\b/i,
  /\bje\s+recontacte(?:rai)?\b/i,
  /\bje\s+(?:re)?v[ée]rifie(?:rai)?\s+(?:dans|d'ici)\b/i,
  /\bi(?:'ll|\s+will)\s+(?:get\s+back\s+to\s+you|follow\s+up|keep\s+you\s+posted|let\s+you\s+know)\b/i,
  /\bi(?:'ll|\s+will)\s+(?:retry|try\s+again|check\s+(?:back|again))\b/i,
  /\bi(?:'ll|\s+will)\s+(?:re)?check\s+(?:in|within)\b/i,
];

/** Ce message (le sien, sortant) porte-t-il une promesse de suivi ? PUR. Renvoie le PREMIER motif qui mord, ou `null`. */
export function detectFollowUpPromise(text: string, patterns: readonly RegExp[] = DEFAULT_PROMISE_PATTERNS): PromiseSignal | null {
  const body = (text ?? "").trim();
  if (!body) return null;
  for (const re of patterns) {
    const m = re.exec(body);
    if (m) return { evidence: excerptAround(body, m.index, m[0].length) };
  }
  return null;
}

/** Clé de compteur journalier (date locale `AAAA-MM-JJ`). */
export const promiseCountKey = (day: string): string => `promise_nudges_${day}`;

/**
 * Faut-il relancer ? Le message promet, aucun réveil n'a été armé pendant le tour, et le plafond du jour
 * est ouvert. PUR : `wakesCreatedDuringTurn` et `nudgesToday` viennent de ta base.
 */
export function shouldNudge(o: {
  outgoingText: string;
  wakesCreatedDuringTurn: number;
  nudgesToday: number;
  cap?: number;
  patterns?: readonly RegExp[];
}): PromiseSignal | null {
  if (o.wakesCreatedDuringTurn > 0) return null;
  if (o.nudgesToday >= (o.cap ?? PROMISE_DAILY_CAP)) return null;
  return detectFollowUpPromise(o.outgoingText, o.patterns);
}

/** Consigne de relance, injectée dans la MÊME session. `armCommand` = la commande qui programme un réveil chez toi. */
export function promiseNudgePrompt(signal: PromiseSignal, armCommand = "la commande qui programme un réveil"): string {
  return [
    "[FILET PROMESSE-SANS-RÉVEIL — ton dernier message promet un suivi, aucun réveil n'a été armé ce tour]",
    "",
    `Ce que tu as écrit : « ${signal.evidence} »`,
    "",
    "Une promesse de suivi part sans mécanisme derrière, et c'est TOUJOURS l'humain qui doit relancer pour",
    "que tu resurgisses — alors que tu t'ÉTEINS entre deux réveils, tu n'es pas un process qui attend. Une",
    "promesse sans réveil est structurellement intenable.",
    "",
    "Tranche maintenant, dans CE tour :",
    `- la promesse est réelle et datée : arme-la tout de suite (${armCommand}, avec un délai et un intent`,
    "  qui porte l'identifiant nécessaire pour reprendre : le sujet, le fil, ce qu'il faut revérifier) ;",
    "- ce n'était pas une vraie promesse de suivi (juste une formule, ou un motif qui a mordu à tort) :",
    "  ne fais rien, dis-le en une ligne, arrête-toi là.",
    "",
    "N'envoie PAS de nouveau message pour ça : arme le réveil silencieusement, le réveil programmé parlera",
    "de lui-même le moment venu.",
  ].join("\n");
}
