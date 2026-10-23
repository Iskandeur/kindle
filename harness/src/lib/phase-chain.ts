/**
 * phase-chain — le squelette générique d'une consolidation nocturne en CHAÎNE DE PHASES (le « rêve »).
 *
 * Le pattern : au lieu d'UNE longue session qui traverse N phases dans le même fil (coupée en cours de
 * route par un quota ou un redémarrage, elle perd tout ce qui suit — et un redémarrage déclenché PAR le rêve
 * lui-même, en déployant son propre correctif, n'a aucun filet), chaque phase est UN JOB de ta file
 * (`chain_id`, `chain_seq`, `chain_kind`). Les jobs ont déjà la résilience nécessaire (reprise sur quota,
 * ré-enfilement des orphelins au démarrage) : les phases la reçoivent gratuitement.
 *
 * Avancement : quand un job de la chaîne se termine (succès OU échec définitif), le RUNNER de jobs appelle
 * ton code d'avancement (pas l'agent via un réveil) pour enfiler la phase suivante, avec la sortie des
 * phases précédentes injectée dans son prompt. Le dernier maillon (le rapport du matin) est TOUJOURS
 * enfilé, même si un maillon précédent a définitivement échoué (juste signalé dans son prompt) : l'humain
 * reçoit toujours quelque chose. Le planificateur (un tick toutes les 5 min) ne fait plus que démarrer une
 * nouvelle chaîne à l'heure, et réparer légèrement un maillon fini qui n'a jamais eu de successeur (la
 * fenêtre minuscule où un redémarrage tombe ENTRE la fin d'un job et l'enfilage du suivant).
 *
 * Ce module porte la logique PURE de cette chaîne : définition des phases, identifiant de nuit, résumé borné
 * des phases précédentes, assemblage du prompt, et la destination du rapport. Le branchement (table de jobs,
 * lecture des fichiers de phase) est à toi : voir `docs/ruche-board-et-reve.md`.
 */

export interface PhaseDef {
  /** Nom de fichier de la consigne de la phase. */
  file: string;
  /** Libellé court (affichage, résumés injectés dans les phases suivantes). */
  label: string;
}

/** Une phase terminée, vue par le résumeur (le sous-ensemble de ta ligne de job). */
export interface PhaseJob {
  id: number;
  chain_seq: number | null;
  status: string;
  result: string | null;
}

/** `chain_id` d'une nuit donnée (date locale `AAAA-MM-JJ`) : un seul par nuit. */
export const chainIdForDate = (date: string, kind = "dream"): string => `${kind}-${date}`;

/**
 * Ce job est-il un maillon INTERMÉDIAIRE (toutes les phases sauf la dernière) ? Ces phases ne s'adressent
 * jamais à l'humain : la chaîne s'avance mécaniquement, seule la dernière a le droit de lui écrire. Tout
 * mécanisme qui traite « aucun message envoyé » comme un échec de délivrance doit donc les exclure — sinon il
 * rejoue, coûte un réveil par phase et par redémarrage, et finit par déverser un prompt brut dans la
 * messagerie. La dernière phase reste EXCLUE de ce filtre, délibérément : elle, on veut la rejouer si son
 * tour a été tué avant d'avoir parlé.
 */
export function isIntermediatePhase(
  job: { chain_kind?: string | null; chain_seq?: number | null; created_by?: string | null },
  phaseCount: number,
  kind = "dream",
): boolean {
  if (job.chain_kind !== kind && job.created_by !== kind) return false;
  const seq = job.chain_seq;
  return typeof seq === "number" && seq >= 1 && seq < phaseCount;
}

/** Borne d'un résumé de phase injecté : début + fin, le milieu coupé AVEC une marque. */
export const PHASE_SUMMARY_MAX = 1500;
const PHASE_SUMMARY_TAIL = 600;

/**
 * Un `.slice(0, N)` muet perd la FIN du résumé, justement l'endroit où une phase écrit ce qu'elle passe à la
 * suivante (dettes, points ouverts) : la coupe tombait au milieu d'une phrase et la phase suivante découvrait
 * les dettes par accident. On garde donc le début ET la fin, et la coupe est marquée (avec où lire le tout).
 */
export function clipPhaseSummary(text: string, readHint?: string): string {
  if (text.length <= PHASE_SUMMARY_MAX) return text;
  const tail = text.slice(-PHASE_SUMMARY_TAIL);
  const head = text.slice(0, PHASE_SUMMARY_MAX - PHASE_SUMMARY_TAIL);
  const cut = text.length - head.length - tail.length;
  return `${head}\n\n[… ${cut} caractères coupés ici${readHint ? `, le résumé entier : ${readHint}` : ""} …]\n\n${tail}`;
}

/**
 * Résume les phases déjà terminées d'une chaîne, pour l'injecter dans le prompt de la suivante : chaque phase
 * voit ce que les précédentes ont fait cette nuit, sans repartir de zéro. Borné par phase. `readHint(job)`
 * donne la commande pour relire le résumé entier.
 */
export function summarizePriorPhases(prior: readonly PhaseJob[], phases: readonly PhaseDef[], readHint?: (job: PhaseJob) => string): string {
  const done = prior.filter((j) => j.chain_seq !== null && (j.status === "done" || j.status === "error"));
  if (done.length === 0) return "";
  const parts = done.map((j) => {
    const label = phases[(j.chain_seq ?? 1) - 1]?.label ?? `phase ${j.chain_seq}`;
    const tag = j.status === "error" ? "ÉCHEC" : "fait";
    return `### Phase ${j.chain_seq} — ${label} (${tag})\n${clipPhaseSummary(j.result ?? "(pas de résumé)", readHint?.(j))}`;
  });
  return ["--- Ce qui s'est déjà passé cette nuit (phases précédentes) ---", "", ...parts, "---"].join("\n\n");
}

export type PromptPartId = "entete" | "phases-precedentes" | "consigne" | "destination" | "cloture";

/**
 * Les morceaux d'une phase, dans l'ordre, SANS lecture disque : le constructeur de prompt les joint, un
 * tableau de bord peut les montrer un par un (même fonction, donc même prompt). `trailer` = la clôture
 * commune à TOUTES les phases (ex. « l'arbre git doit être propre avant de te rendre » : une phase tourne
 * dans un worktree isolé mais écrit parfois dans la copie vivante, ce qui la rend responsable jusqu'au
 * commit, sous peine de geler l'auto-rechargement du daemon et de faire échouer les autres rebases).
 */
export function phaseParts(o: {
  seq: number;
  phases: readonly PhaseDef[];
  /** le contenu du fichier de consigne de la phase */
  body: string;
  /** le résumé des phases précédentes (`summarizePriorPhases`) */
  summary: string;
  /** la destination du rapport, pour la DERNIÈRE phase seulement */
  destination?: string;
  trailer?: string;
  /** libellé de la date/heure locale de l'humain, pour l'en-tête */
  clock: string;
}): { id: PromptPartId; text: string }[] {
  const phase = o.phases[o.seq - 1];
  const last = o.seq >= o.phases.length;
  return [
    { id: "entete" as const, text: `[DREAM — phase ${o.seq}/${o.phases.length} : ${phase.label} — ${o.clock}]` },
    { id: "phases-precedentes" as const, text: o.summary },
    { id: "consigne" as const, text: o.body },
    { id: "destination" as const, text: last ? (o.destination ?? "") : "" },
    { id: "cloture" as const, text: o.trailer ?? "" },
  ].filter((p) => p.text);
}

/** Le prompt complet d'une phase : les morceaux joints par une ligne vide. */
export function buildPhasePrompt(o: Parameters<typeof phaseParts>[0]): string {
  return phaseParts(o).map((p) => p.text).join("\n\n");
}

/**
 * Où et COMMENT part le rapport du matin : la dernière phase ne l'envoie pas, elle le DÉPOSE
 * (`deferred-report.ts`) et le daemon l'envoie à l'heure. Le chemin d'envoi direct reste écrit pour le seul
 * cas où le daemon ne porte pas l'envoi (code 3). Prime sur la consigne de la phase. `depositCommand` = ta
 * commande de dépôt ; `preferred` = le canal préféré s'il y en a un.
 */
export function reportDestinationText(o: { depositCommand: string; preferred: string | null; principal: string }): string {
  const dest = o.preferred ? `dans ${o.preferred}, repli sur ${o.principal} tout seul s'il est injoignable` : `sur ${o.principal}`;
  const direct = o.preferred
    ? `${o.preferred} ; s'il échoue, repli sur ${o.principal} avec en tête « (canal habituel injoignable) » suivi de la cause en quelques mots. Un refus d'un garde-fou ne se contourne pas en reformulant pour passer : il ouvre un job de réparation.`
    : `${o.principal}.`;
  return [
    "## Destination du rapport : tu le DÉPOSES, le daemon l'envoie à l'heure (prime sur toute autre consigne de ce fichier)",
    "N'envoie pas le rapport toi-même. Écris le message final dans un fichier, puis :",
    "",
    `    ${o.depositCommand}`,
    "",
    `- **code 0** : déposé. La commande affiche l'heure d'envoi (l'heure choisie par l'humain dans son fuseau ; tout de suite si elle est passée) ; le daemon l'enverra ${dest}. Ton envoi est fait : passe aux gestes d'après l'envoi.`,
    "- **code 2** : refusé, la raison est affichée (texte invalide, rapport de cette nuit déjà parti ou déjà en file). Corrige et redépose. Un code 2 ne se contourne jamais par un envoi direct.",
    `- **code 3** : le daemon qui tourne ne porte pas encore l'envoi différé (aucun passage récent de son porteur). Alors, et seulement alors, envoie-le toi-même maintenant : ${direct}`,
    "",
    "Un seul des deux chemins, jamais les deux : un dépôt réussi suivi d'un envoi, c'est un rapport qu'il lit deux fois.",
  ].join("\n");
}
