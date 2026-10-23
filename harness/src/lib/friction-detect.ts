/**
 * friction-detect — l'AUTO-RÉPARATION À CHAUD : corriger une friction le jour même, pas à 3 h du matin.
 *
 * Une boucle d'auto-amélioration qui ne tourne qu'une fois par nuit, sur le digest de la veille, laisse une
 * friction de 9 h du matin attendre 18 heures avant d'être seulement *regardée*. Entre-temps elle peut
 * mordre dix fois de plus : le correctif arrive la nuit suivante, après que la journée a été gâchée.
 *
 * Ce module ferme cet écart. À la fin d'un tour de conversation, le daemon lit le message de l'humain :
 * s'il porte un **signal de friction** (reproche, relance agacée, insatisfaction), un JOB DE RÉPARATION
 * est enfilé dans la foulée. Le job tourne en session isolée, cherche la cause RACINE, corrige, et grave.
 * Le tour de conversation, lui, continue normalement : réparer n'est pas répondre.
 *
 * ## Choix de conception
 *
 * - **Détection mécanique, réparation intelligente.** La détection est une liste de motifs (zéro coût,
 *   zéro latence, zéro faux réveil) ; tout le jugement est délégué au job, qui a le contexte complet.
 * - **Sensibilité assumée, coût borné** par un PLAFOND QUOTIDIEN (`FRICTION_DAILY_CAP`) : un jour où tout
 *   va mal, mieux vaut 4 réparations profondes que 20 superficielles.
 *
 *   ⚠️ « Un motif qui mord à tort coûte un job » est FAUX. Un faux positif ne coûte pas un job, il coûte
 *   **le correctif que ce job va fabriquer** : sommé de réparer, un job peut inventer un correctif pour se
 *   justifier, et ce correctif atterrit dans le chemin qui construit l'agent. La sensibilité reste le bon
 *   choix, mais elle se paie sur les motifs AMBIGUS (ceux dont l'idiome a une lecture ordinaire), et
 *   ceux-là se resserrent au lieu de s'élargir. Mesure d'un motif : le faire tourner sur l'historique réel
 *   des messages, lire chaque match, compter les vrais.
 * - **Silencieux par défaut.** Le job répare et grave ; il n'écrit à l'humain QUE s'il a besoin d'une
 *   validation. Sinon le rapport du matin raconte. Sinon chaque reproche produirait deux messages (la
 *   réponse + l'accusé de réparation) : exactement le bruit dont on se plaint.
 * - **Un reproche sur le coût ne se répare pas en dépensant** (`frictionIsAboutSpending`) : il se traite
 *   au rêve, où la session tourne de toute façon. Répondre à « arrête de cramer le quota » par un job qui
 *   brûle 6 $ est auto-contradictoire.
 *
 * Les motifs fournis (`DEFAULT_PATTERNS`) sont français et anglais, volontairement courts : le
 * vocabulaire de TON humain n'est pas le mien. Passe les tiens à `detectFriction(body, patterns)`, tirés
 * de ses messages réels (une famille = au moins un exemple attesté en commentaire).
 *
 * ## Pièges de regex vécus (JS)
 * - `\b` est ASCII : il ne voit ni « ç » en tête ni « é » en fin de mot. Une frontière devant un mot
 *   accentué se pose avec `(?<!\p{L})` (drapeau `u`), et la limite de fin se porte PAR ALTERNATIVE.
 * - `\w` ignore les accents (même avec `u`) : un adverbe accentué désarme un `\w+`. Utilise `\S+`.
 * - Un motif qui se compile sans erreur peut ne JAMAIS mordre : chaque motif a un test positif ET négatif.
 */

/** Combien de jobs de réparation à chaud au maximum dans une même journée. Au-delà, c'est un sujet de fond :
 *  il se traite la nuit en une fois, pas en rafale de patchs. */
export const FRICTION_DAILY_CAP = 4;

export type FrictionKind = "silence" | "reproche" | "insatisfaction";

export interface FrictionSignal {
  kind: FrictionKind;
  /** Le fragment exact qui a mordu : cité tel quel dans le prompt de réparation, pour partir du RÉEL. */
  evidence: string;
}

export interface FrictionPattern {
  kind: FrictionKind;
  re: RegExp;
}

/**
 * Motifs de départ. Silence : l'humain attend une réponse qui n'est pas venue. Reproche : il reprend un
 * comportement. Insatisfaction : il constate que c'est en dessous. Ordre = du plus mécanique au plus diffus.
 */
export const DEFAULT_PATTERNS: FrictionPattern[] = [
  // — SILENCE —
  { kind: "silence", re: /\btu\s+(?:ne\s+)?(?:me\s+)?r[ée]ponds?\s+pas\b/i },
  { kind: "silence", re: /\btu\s+(?:ne\s+)?m'?as\s+pas\s+r[ée]pondu\b/i },
  { kind: "silence", re: /\baucune?\s+r[ée]ponse\b/i },
  { kind: "silence", re: /\b(?:why|how\s+come)\s+(?:are\s+you\s+)?(?:not\s+answering|ignoring\s+me)\b/i },
  { kind: "silence", re: /\byou\s+(?:never|didn'?t|did\s+not)\s+(?:answer|reply|respond)\b/i },
  // « tu dors » : le reproche (« tu dors ou quoi ? ») et la question ordinaire (« tu dors où ? ») coexistent ;
  // un complément de lieu/moment derrière le verbe bascule vers l'intendance. « ou quoi » commence par « ou » :
  // le « où » locatif doit l'exclure explicitement.
  { kind: "silence", re: /\btu\s+dors\b(?!\s*(?:o[ùu](?!\s*quoi)|chez|avec|quand|combien|jusqu))/i },
  // — REPROCHE —
  { kind: "reproche", re: /\bcorrige\s+(?:[çc]a|ce\b)/i },
  { kind: "reproche", re: /\bin(?:acceptable|admissible)\b/i },
  { kind: "reproche", re: /\bje\s+t'?ai\s+d[ée]j[àa]\s+dit\b/i },
  { kind: "reproche", re: /\bi\s+(?:already\s+)?told\s+you\b/i },
  // « combien de fois » nu est d'abord un COMPARATIF DE QUANTITÉ (« ça fait combien de fois X ? »). Le
  // reproche exige un SUJET derrière la locution ; le comparatif est suivi d'un nom.
  { kind: "reproche", re: /\bcombien\s+de\s+fois\s+(?:est-ce\s+qu[e']\s*)?(?:je|tu|on|il\s+faut|faut(?:-il)?)\b/i },
  { kind: "reproche", re: /\bhow\s+many\s+times\s+(?:do\s+i|must\s+i|have\s+i)\b/i },
  { kind: "reproche", re: /\barr[êe]te\s+de\b/i },
  { kind: "reproche", re: /\bstop\s+(?:doing|sending|asking)\b/i },
  // Frontière Unicode : `\b[çc]a` est mort pour « ça » (entre une espace et « ç », deux non-mots).
  { kind: "reproche", re: /(?<!\p{L})[çc]a\s+(?:ne\s+)?(?:marche|va|fonctionne)\s+pas\b(?!\s+(?:mal|[êe]tre)\b)/iu },
  { kind: "reproche", re: /\b(?:it|this)\s+(?:still\s+)?(?:doesn'?t|does\s+not)\s+work\b/i },
  { kind: "reproche", re: /\btu\s+te\s+(?:plantes|trompes)\b/i },
  { kind: "reproche", re: /\bc'?est\s+(?:tr[èe]s\s+)?(?:frustrant|p[ée]nible|nul|relou)\b/i },
  { kind: "reproche", re: /\bthis\s+is\s+(?:really\s+)?(?:frustrating|annoying)\b/i },
  // Un reproche ne dit pas toujours « fais autrement » : il dit souvent « tu ne vois pas ».
  { kind: "reproche", re: /\btu\s+n'?as\s+(?:pas|rien)\s+(?:vu\b|lu\b|compris\b|remarqu[ée]|capt[ée])/i },
  { kind: "reproche", re: /\btu\s+(?:ne\s+)?(?:vois|lis|comprends)\s+(?:pas|rien)\b/i },
  { kind: "reproche", re: /\byou\s+(?:missed|didn'?t\s+(?:see|read|get))\b/i },
  // « déçu » nu mord sur « Déçu ? » (il demande si MOI je le suis) : sujet en première personne, ou « de toi ».
  { kind: "reproche", re: /\b(?:je\s+suis|j'?[ée]tais|j'?ai\s+[ée]t[ée])\s+(?:\S+\s+){0,2}d[ée][çc]u\b|\b(?:tr[èe]s|vraiment|franchement)\s+d[ée][çc]u\b|\bd[ée][çc]u\s+(?:de|par)\s+(?:toi|ta|ton|tes)\b/i },
  // — INSATISFACTION —
  { kind: "insatisfaction", re: /\bpas\s+(?:du\s+tout\s+)?assez\b/i },
  { kind: "insatisfaction", re: /\bnot\s+(?:nearly\s+)?good\s+enough\b/i },
  { kind: "insatisfaction", re: /\btu\s+pourrais\s+(?:faire\s+)?(?:beaucoup\s+)?mieux\b/i },
  { kind: "insatisfaction", re: /\byou\s+could\s+(?:do|be)\s+(?:a\s+lot\s+)?better\b/i },
];

/** Agacement ponctuationnel : « !!!! » ou « ?? » n'ont de sens que **combinés à une deuxième personne**
 *  (« génial !!! » n'est pas une friction, « t'es où ?? » en est une). */
const SHOUT = /(?:!\s*){3,}|\?{2,}/;
const SECOND_PERSON = /\b(?:tu|t'|te|toi|ton|ta|tes|you|your)\b/i;

/**
 * Ce message porte-t-il un signal de friction ? PUR. Rend le PREMIER motif qui mord (ordre de la table),
 * ou `null`. Le fragment retourné est l'extrait réel, pas le motif : le job de réparation lit ses mots à lui.
 */
export function detectFriction(body: string, patterns: readonly FrictionPattern[] = DEFAULT_PATTERNS): FrictionSignal | null {
  const text = (body ?? "").trim();
  if (!text) return null;
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) return { kind: p.kind, evidence: excerptAround(text, m.index, m[0].length) };
  }
  const shout = SHOUT.exec(text);
  if (shout && SECOND_PERSON.test(text)) return { kind: "reproche", evidence: excerptAround(text, shout.index, shout[0].length) };
  return null;
}

/** Extrait lisible autour du fragment qui a mordu (le motif seul — « pas assez » — ne dit rien ; la phrase qui le porte dit tout). */
export function excerptAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 90);
  const end = Math.min(text.length, at + len + 90);
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + raw + (end < text.length ? "…" : "");
}

/** Le plafond quotidien est-il encore ouvert ? (le compteur vit en base, la DÉCISION vit ici.) */
export function withinDailyCap(alreadyToday: number, cap = FRICTION_DAILY_CAP): boolean {
  return alreadyToday < cap;
}

/**
 * Ce reproche porte-t-il sur ce que l'agent COÛTE ? Le filet est volontairement LARGE, parce que
 * l'asymétrie des erreurs le commande : un faux positif reporte une réparation de quelques heures à la
 * nuit ; un faux négatif rejoue la boucle à plusieurs dollars. Quand se tromper d'un côté coûte cent fois
 * plus que de l'autre, on ne règle pas le seuil au milieu.
 */
const SPENDING_TOPIC =
  /\b(?:quota|cr[ée]dits?|budget|tokens?|abonnement|facture|cramer?|crame|d[ée]pense[rs]?|co[ûu]te(?:nt|r)?|co[ûu]t\b|trop\s+cher|spend(?:ing)?|cost(?:s|ly)?|expensive|burn(?:ing)?)\b/i;

export function frictionIsAboutSpending(body: string): boolean {
  return SPENDING_TOPIC.test((body ?? "").trim());
}

/** Clé de compteur journalier (date locale `AAAA-MM-JJ` de l'humain) : une friction de 23 h et une de 1 h ne partagent pas le même budget. */
export const frictionCountKey = (day: string): string => `friction_repairs_${day}`;

/**
 * L'intent du job de réparation. PUR. Écrit à la deuxième personne (le job, c'est l'agent dans une autre
 * session) et volontairement EXIGEANT sur la cause racine : le travers mesuré était de corriger le symptôme
 * visible sans jamais remonter au mécanisme qui l'a produit. `extraLines` : les consignes propres à ton
 * dépôt (où lire le fil, quelle commande de test, où capitaliser).
 */
export function frictionRepairPrompt(o: {
  signal: FrictionSignal;
  /** Le message complet de l'humain (pas seulement l'extrait) : le contexte compte. */
  body: string;
  /** Horodatage lisible du message qui a mordu. */
  at: string;
  /** D'où venait le message (chat 1:1, groupe…), pour retrouver le fil. */
  where: string;
  /** Comment relire le fil (outil, commande). */
  reread?: string;
  extraLines?: readonly string[];
}): string {
  const reread = o.reread ?? "le fil de la conversation";
  return [
    "[AUTO-RÉPARATION À CHAUD — une friction vient d'être détectée dans la conversation]",
    "",
    `Signal : ${o.signal.kind}. Détecté le ${o.at}, ${o.where}.`,
    `Ce qui a mordu : « ${o.signal.evidence} »`,
    "",
    "Son message entier :",
    "---",
    o.body.trim().slice(0, 2000),
    "---",
    "",
    "L'humain veut que tu te répares **le jour même**, sans attendre le rêve de la nuit.",
    ...(o.extraLines ?? []),
    "",
    "Ton travail dans ce job : PAS de répondre à l'humain (l'autre session s'en charge, elle a déjà le fil)",
    "mais de faire en sorte que **ça ne se reproduise pas** :",
    "",
    "1. **Vérifie que la friction est réelle.** Un motif a mordu, ce n'est pas une preuve. Relis",
    `   ${reread}, regarde ce qui s'est vraiment passé. Si c'était un faux positif (il parlait d'autre`,
    "   chose, il citait quelqu'un), dis-le en une ligne et arrête-toi là. Ne fabrique pas un correctif",
    "   pour justifier ce job.",
    "   - Si tu ne peux PAS relire le fil (messagerie en panne, API qui refuse), tu ne sais pas ce qui",
    "     s'est passé : dis « non vérifiable » et arrête-toi. Une cause qui « colle parfaitement » sans",
    "     preuve n'en est pas une.",
    "   - Regarde d'abord ce que la session de conversation a FAIT après son message (ses réponses, et les",
    "     commits depuis l'heure du message). Un point déjà corrigé par elle n'est pas à réparer deux fois.",
    "2. **Remonte à la cause RACINE, pas au symptôme.** La question n'est pas « qu'est-ce qui l'a agacé »",
    "   mais « quel mécanisme a produit ça, et pourquoi il était possible ». Cherche si c'est une",
    "   RÉCIDIVE : un reproche déjà écrit et répété prouve qu'une note ne suffit pas et qu'il faut un",
    "   mécanisme.",
    "3. **Corrige pour de vrai.** Un garde-fou mécanique vaut mieux qu'une note quand c'est un DÉFAUT ;",
    "   une note vaut mieux qu'un garde-fou quand c'est un CHOIX (un mécanisme qui tranche un jugement de",
    "   goût rend l'agent bête ailleurs). Tests verts obligatoires, puis commit et fusion.",
    "4. **Capitalise** : la leçon sur sa façon de travailler dans la mémoire, le savoir-faire dans les",
    "   compétences, la trace dans le journal.",
    "",
    "**Ne lui écris PAS** pour dire que tu as réparé : le rapport du matin le racontera. Deux exceptions,",
    "et deux seulement : (a) le correctif exige une décision qui l'engage (son argent, son identité,",
    "quelque chose qui sort vers l'extérieur) → demande-la clairement, en un message ; (b) tu découvres",
    "en creusant un problème qui lui coûte MAINTENANT et qu'il ignore → dis-le, court.",
    "",
    "Termine ta réponse par : la cause racine trouvée, ce que tu as changé (avec quoi le vérifier), ou",
    "pourquoi tu n'as rien changé.",
  ].join("\n");
}

/** Ce que la base doit savoir faire pour ouvrir un job de réparation (une vraie base le fait, un faux aussi). */
export interface FrictionJobStore {
  getSetting(key: string): string | null | undefined;
  setSetting(key: string, value: string): void;
  /** Enfile un job ; `created: false` si un job équivalent est déjà en file. */
  addJobDeduped(intent: string, createdBy: string): { id: number; created: boolean };
}

export type FrictionOutcome =
  | { action: "none" }
  /** Reproche sur ce que l'agent coûte : jamais de job payant, laissé au rêve (cf. `frictionIsAboutSpending`). */
  | { action: "spending"; signal: FrictionSignal }
  /** Plafond du jour atteint : au-delà, c'est un sujet de fond, il se traite la nuit en une fois. */
  | { action: "capped"; signal: FrictionSignal; already: number }
  /** La même friction est déjà en réparation : un seul job suffit. */
  | { action: "duplicate"; signal: FrictionSignal; id: number }
  | { action: "opened"; signal: FrictionSignal; id: number };

/**
 * Détecte et, s'il le faut, enfile le job de réparation. UNE implémentation pour toutes les portes par
 * lesquelles l'humain parle à l'agent (messagerie principale ET canal de secours) : un code de détection
 * qui ne vit que dans l'orchestrateur principal laisse les pannes de ce canal — justement les heures où
 * l'humain s'agace le plus — sans réparation. Le PÉRIMÈTRE (est-ce bien lui, est-ce bien à moi) reste chez
 * l'appelant, qui sait d'où vient le message ; ici on ne décide que de la friction et du budget.
 */
export function openFrictionRepair(
  store: FrictionJobStore,
  o: {
    body: string;
    where: string;
    at: string;
    /** date locale de l'humain, `AAAA-MM-JJ` (clé du plafond) */
    day: string;
    reread?: string;
    patterns?: readonly FrictionPattern[];
    extraLines?: readonly string[];
  },
): FrictionOutcome {
  const signal = detectFriction(o.body, o.patterns);
  if (!signal) return { action: "none" };
  if (frictionIsAboutSpending(o.body)) return { action: "spending", signal };
  const key = frictionCountKey(o.day);
  const already = Number(store.getSetting(key)) || 0;
  if (!withinDailyCap(already)) return { action: "capped", signal, already };
  const intent = frictionRepairPrompt({ signal, body: o.body, at: o.at, where: o.where, reread: o.reread, extraLines: o.extraLines });
  const { id, created } = store.addJobDeduped(intent, "friction");
  if (!created) return { action: "duplicate", signal, id };
  store.setSetting(key, String(already + 1));
  return { action: "opened", signal, id };
}

/** La ligne de journal d'une issue (`null` = rien à dire). Même texte pour toutes les portes. */
export function frictionOutcomeLog(out: FrictionOutcome): string | null {
  switch (out.action) {
    case "none":
    case "duplicate":
      return null;
    case "spending":
      return `[friction] signal '${out.signal.kind}' PORTE SUR LE COÛT : aucun job payant, laissé au rêve : « ${out.signal.evidence.slice(0, 120)} »`;
    case "capped":
      return `[friction] plafond quotidien atteint (${out.already}) : signal '${out.signal.kind}' laissé au rêve`;
    case "opened":
      return `[friction] signal '${out.signal.kind}' détecté, job #${out.id} de réparation enfilé : « ${out.signal.evidence.slice(0, 120)} »`;
  }
}

/**
 * Ce job répare-t-il quelque chose ? Le critère juste n'est pas qui a ouvert le job, c'est ce qu'il laisse
 * ouvert s'il meurt : on lit donc aussi l'intent. Un job de réparation coupé par le plafond de budget laisse
 * la friction de l'humain **ouverte**, et vu de lui cela ressemble à ne rien avoir fait, en plus cher.
 * Les jobs d'un « brûleur de quota » éventuel sont exclus (leurs intents recopient des titres sans rien réparer).
 */
export function isRepairJob(createdBy: string, intent: string, burnerCreatedBy?: string): boolean {
  if (createdBy === "friction") return true;
  if (burnerCreatedBy && createdBy === burnerCreatedBy) return false;
  // Bornes en `\p{L}` et pas `\b` : `\b` est ASCII, il ne voit pas la fin de « réparé ».
  return /(?<!\p{L})(?:frictions?|auto-r[ée]paration|r[ée]par(?:er|ez|ons|es?|ée?s?|ations?)|repair(?:s|ed|ing)?)(?!\p{L})/iu.test(intent);
}

/**
 * Note à ajouter au résultat d'un job de réparation tué par le plafond de budget : il ne doit pas se fondre
 * dans le générique « job en erreur ». Zéro reprise automatique (ça doublerait la dépense sans humain dans
 * la boucle) : la note sert seulement à ce que la friction repasse devant une session pour une décision
 * consciente (reprendre, relancer autrement, ou juger qu'elle ne mérite plus l'effort).
 */
export function frictionReopenedNote(jobId: number): string {
  return [
    "=== FRICTION ROUVERTE (pas un job en erreur ordinaire) ===",
    `Ce job (#${jobId}) devait réparer une friction détectée dans une conversation avec l'humain ;` +
      " il a été coupé par le plafond de budget avant de conclure. La friction reste donc" +
      " **ouverte** : personne ne l'a corrigée, contrairement à ce que le statut « erreur » suggère.",
    "Zéro reprise automatique : cette note sert à ce que la friction repasse devant une session" +
      " (ici, ou au résiduel de frictions du rêve de la nuit suivante).",
  ].join("\n");
}
