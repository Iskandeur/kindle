/**
 * ask-block — le bloc de tête d'un ticket qui demande un geste à l'humain.
 *
 * Mission : qu'un ticket assigné à l'humain se suffise à lui-même. Si l'humain doit ouvrir chaque
 * ticket pour avoir assez de contexte pour trancher, le tableau ne sert à rien. Trois lignes, en tête
 * du corps :
 *
 *   Ce que j'attends de toi : <une phrase>                                   (EN : Ask: …)
 *   Options : A) … — conséquence ; B) … — conséquence (défaut : B)           (EN : Options: … (default: B))
 *   Sans réponse : <ce qui se passe, et quand>                               (EN : If no answer: …)
 *
 * La ligne « Options » est ABSENTE pour une simple action ou un oui/non. Un plugin de tableau peut lire
 * ces lignes pour afficher la question et des boutons sans ouvrir le ticket ; ce module est le seul
 * endroit où le format s'écrit et se lit côté harnais. Tout est PUR.
 *
 * `readAskBlock` est TOLÉRANT (la lecture ne punit pas une faute de frappe) : casse, accents, gras
 * markdown (`**Ce que j'attends de toi :**`), puce ou citation en tête, `:` collé ou espacé
 * (typographie française). `writeAskBlock` est STRICT (une seule forme canonique). `askBlockComplete`
 * est la mesure qu'un agent de tri peut appliquer : une question, un « sans réponse », et des options
 * cohérentes s'il y en a.
 */

export type AskLang = "fr" | "en";

export interface AskOption {
  /** la lettre (A, B, C…) */
  letter: string;
  label: string;
  /** ce qui se passe si c'est celle-là ; "" = non dite */
  consequence: string;
}

export interface AskBlock {
  lang: AskLang;
  /** « Ce que j'attends de toi » : une phrase */
  question: string;
  /** vide = pas de ligne Options (action simple, oui/non) */
  options: AskOption[];
  /** la lettre du défaut (« B ») ou null */
  defaultLetter: string | null;
  /** « Sans réponse » : ce qui se passe, et quand */
  ifNoAnswer: string;
}

export interface AskBlockInput {
  question: string;
  /** libellé seul, ou { label, consequence } */
  options?: ReadonlyArray<string | { label: string; consequence?: string }>;
  /** la LETTRE du défaut ("B"), ou l'indice (0 = A) */
  defaultOption?: string | number;
  ifNoAnswer: string;
  lang?: AskLang;
}

const LETTERS = "ABCDEFGH";
const MAX_OPTIONS = LETTERS.length;

const HEAD: Record<AskLang, { question: string; options: string; dflt: string; ifNoAnswer: string }> = {
  fr: { question: "Ce que j'attends de toi", options: "Options", dflt: "défaut", ifNoAnswer: "Sans réponse" },
  en: { question: "Ask", options: "Options", dflt: "default", ifNoAnswer: "If no answer" },
};

/** Une phrase sur UNE ligne : retours à la ligne aplatis, espaces réduits. */
const flatten = (x: string): string => String(x ?? "").replace(/\s+/g, " ").trim();

/** Le texte d'une option, sans le séparateur qui casserait la lecture (« ; » entre options, « — » libellé/conséquence). */
const cleanPart = (x: string): string => flatten(x).replace(/\s*;\s*/g, ", ").replace(/\s+[—–-]\s+/g, ", ");

/**
 * Le bloc, en texte (2 ou 3 lignes). Strict : forme canonique, une ligne par partie. Les options au-delà
 * de 8 sont écartées ; un défaut qui ne désigne aucune option est omis (jamais un « défaut : Z » orphelin).
 */
export function writeAskBlock(e: AskBlockInput): string {
  const lang = e.lang ?? "fr";
  const t = HEAD[lang];
  const sp = lang === "fr" ? " " : "";
  const lines = [`${t.question}${sp}: ${flatten(e.question)}`];
  const opts = (e.options ?? [])
    .slice(0, MAX_OPTIONS)
    .map((o) => (typeof o === "string" ? { label: o, consequence: "" } : { label: o.label, consequence: o.consequence ?? "" }));
  if (opts.length) {
    const body = opts
      .map((o, i) => `${LETTERS[i]}) ${cleanPart(o.label)}${o.consequence.trim() ? ` — ${cleanPart(o.consequence)}` : ""}`)
      .join(lang === "fr" ? " ; " : "; ");
    let letter: string | null = null;
    const d = e.defaultOption;
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d < opts.length) letter = LETTERS[d];
    else if (typeof d === "string" && /^[A-H]$/i.test(d.trim()) && LETTERS.indexOf(d.trim().toUpperCase()) < opts.length) {
      letter = d.trim().toUpperCase();
    }
    lines.push(`${t.options}${sp}: ${body}${letter ? ` (${t.dflt}${sp}: ${letter})` : ""}`);
  }
  lines.push(`${t.ifNoAnswer}${sp}: ${flatten(e.ifNoAnswer)}`);
  return lines.join("\n");
}

/** Le bloc devant un corps existant (une ligne vide entre les deux). Un corps qui porte DÉJÀ un bloc complet n'est pas doublé. */
export function prependAskBlock(block: string, body: string | null | undefined): string {
  const rest = String(body ?? "");
  const already = readAskBlock(rest);
  if (already && askBlockComplete(already)) return rest;
  return rest.trim() ? `${block}\n\n${rest}` : block;
}

// ── Lecture ────────────────────────────────────────────────────────────────────────────────────

/** Le préfixe toléré d'une ligne : espaces, citation `>`, puce, flèche, numéro, gras/italique markdown. */
const PREFIX = String.raw`^[\s>*_\-•→➡️👉⚠️\d.)]*`;
/** Le séparateur : `:` ou `：`, avec ou sans espace avant, gras refermé (`**…:**`). */
const SEP = String.raw`\s*[:：]\s*(?:\*\*|__)?\s*`;

const RE_QUESTION = new RegExp(`${PREFIX}(?:\\*\\*|__)?(?:(ce que j['’]attends? de toi)|(ask))(?:\\*\\*|__)?${SEP}(.*)$`, "iu");
const RE_OPTIONS = new RegExp(`${PREFIX}(?:\\*\\*|__)?options?(?:\\*\\*|__)?${SEP}(.*)$`, "iu");
const RE_IF_NONE = new RegExp(`${PREFIX}(?:\\*\\*|__)?(?:(sans r[ée]ponse)|(if no (?:answer|reply|response)))(?:\\*\\*|__)?${SEP}(.*)$`, "iu");
/** « (défaut : B) » / « (default: B) » / « (défaut : B — texte) » en fin de ligne Options. */
const RE_DEFAULT = /\(\s*(?:d[ée]faut|default)\s*[:：]\s*([A-Ha-h])\b[^)]*\)\s*\.?\s*$/iu;

const tidy = (x: string): string => flatten(x).replace(/(?:\*\*|__)+$/g, "").trim();

/** Les options d'une ligne « A) … — … ; B) … — … » (le défaut final déjà retiré). */
function readOptions(text: string): AskOption[] {
  const pieces = text.split(/\s*;\s*(?=[A-Ha-h]\s*[).])/u);
  const out: AskOption[] = [];
  for (const p of pieces) {
    const r = /^\s*([A-Ha-h])\s*[).]\s*(.*)$/su.exec(p);
    if (!r) continue;
    const [label, ...rest] = r[2].split(/\s+[—–]\s+|\s+-\s+/u);
    out.push({ letter: r[1].toUpperCase(), label: tidy(label), consequence: tidy(rest.join(" — ")) });
  }
  return out;
}

/**
 * Le bloc d'un corps de ticket, ou null si aucune des trois lignes n'y est. Cherche dans les 40 premières
 * lignes (le bloc est « en tête »). Une ligne absente rend sa partie vide : c'est `askBlockComplete` qui
 * juge. La langue est celle de la première ligne reconnue.
 */
export function readAskBlock(body: string | null | undefined): AskBlock | null {
  if (typeof body !== "string" || !body.trim()) return null;
  const lines = body.slice(0, 6000).split("\n").slice(0, 40);
  let question: string | null = null;
  let none: string | null = null;
  let optionsRaw: string | null = null;
  let lang: AskLang | null = null;
  for (const l of lines) {
    if (question === null) {
      const q = RE_QUESTION.exec(l);
      if (q) {
        question = tidy(q[3]);
        lang ??= q[1] ? "fr" : "en";
        continue;
      }
    }
    if (none === null) {
      const x = RE_IF_NONE.exec(l);
      if (x) {
        none = tidy(x[3]);
        lang ??= x[1] ? "fr" : "en";
        continue;
      }
    }
    if (optionsRaw === null) {
      const o = RE_OPTIONS.exec(l);
      // « Options : » doit être suivi d'une option « A) » : une phrase qui commence par « Options » n'est pas la ligne.
      if (o && /^\(?\s*[A-Ha-h]\s*[).]/u.test(o[1])) optionsRaw = o[1];
    }
  }
  if (question === null && none === null && optionsRaw === null) return null;
  let defaultLetter: string | null = null;
  let options: AskOption[] = [];
  if (optionsRaw !== null) {
    const d = RE_DEFAULT.exec(optionsRaw);
    if (d) defaultLetter = d[1].toUpperCase();
    options = readOptions(d ? optionsRaw.slice(0, d.index) : optionsRaw);
  }
  return { lang: lang ?? "fr", question: question ?? "", options, defaultLetter, ifNoAnswer: none ?? "" };
}

/** Ce qui manque au bloc pour qu'il se suffise (vide = complet). `null` (aucun bloc) manque tout. */
export function askBlockMissing(b: AskBlock | null): string[] {
  if (!b) return ["la question (« Ce que j'attends de toi »)", "ce qui se passe sans réponse (« Sans réponse »)"];
  const m: string[] = [];
  if (b.question.length < 2) m.push("la question (« Ce que j'attends de toi »)");
  if (b.ifNoAnswer.length < 2) m.push("ce qui se passe sans réponse (« Sans réponse »)");
  if (b.options.length === 1) m.push("une deuxième option (la ligne « Options » en veut au moins deux)");
  return m;
}

/**
 * Le bloc se suffit-il ? Une question, un « sans réponse », et — s'il y a une ligne Options — au moins deux
 * options. Le défaut n'est PAS exigé ici : son absence n'empêche pas de trancher.
 */
export function askBlockComplete(b: AskBlock | null): boolean {
  return askBlockMissing(b).length === 0;
}

/** Raccourci : le corps porte-t-il un bloc complet ? */
export const bodyHasCompleteAskBlock = (body: string | null | undefined): boolean => askBlockComplete(readAskBlock(body));

/**
 * La règle d'écriture, à coller dans la consigne d'un agent qui crée des tickets pour l'humain. Une seule
 * source : le texte change ici, partout où du code l'insère.
 */
export function askBlockRule(): string[] {
  return [
    "Tout ticket que tu assignes à l'humain (décision, action, question) commence par TROIS lignes, pour qu'il tranche SANS l'ouvrir :",
    "Ce que j'attends de toi : <une phrase, ce qu'il doit faire ou décider>",
    "Options : A) <choix> — <conséquence> ; B) <choix> — <conséquence> (défaut : B)   [absente pour une simple action ou un oui/non]",
    "Sans réponse : <ce qui se passe, et quand>",
    "Exemple : « Ce que j'attends de toi : choisir où héberger la sauvegarde. / Options : A) hébergeur X — 3 €/mois, même datacenter ; B) hébergeur Y — 1 €/mois, hors site (défaut : B) / Sans réponse : je pars sur B le 15, réversible. »",
    "Une urgence (P0) passe toujours, même incomplète.",
  ];
}

/**
 * Le bloc que porte une ligne de commande, pour les outils qui créent un ticket :
 * `--attends "<phrase>" [--options "libellé — conséquence | libellé — conséquence"] [--defaut B] --sans-reponse "<phrase>"`.
 * Rend l'entrée (ou null si `--attends` et `--sans-reponse` ne sont pas tous deux là) et les arguments restants, flags retirés.
 */
export function askBlockFromArgs(args: readonly string[]): { input: AskBlockInput | null; rest: string[] } {
  const rest: string[] = [];
  const v: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(attends|options|defaut|sans-reponse)$/.exec(args[i]);
    if (m && i + 1 < args.length) v[m[1]] = args[++i];
    else rest.push(args[i]);
  }
  if (!v["attends"]?.trim() || !v["sans-reponse"]?.trim()) return { input: null, rest };
  const options = (v["options"] ?? "")
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      const [label, ...more] = o.split(/\s+[—–]\s+/u);
      return { label, consequence: more.join(" — ") };
    });
  return {
    input: {
      question: v["attends"],
      ...(options.length >= 2 ? { options } : {}),
      ...(v["defaut"] ? { defaultOption: v["defaut"] } : {}),
      ifNoAnswer: v["sans-reponse"],
    },
    rest,
  };
}
