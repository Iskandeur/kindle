/**
 * github-visibility — ce qui rend un dépôt GitHub PUBLIC, repéré AVANT que ça parte.
 *
 * Un garde qui ne regarde que les outils MCP, et seulement le CONTENU écrit vers un dépôt déjà public,
 * laisse deux trous : `gh repo create --public` (ou `gh repo edit --visibility public`, `gh api … private=false`)
 * tapé en Bash passe sans rien, et côté MCP la création publique ou un fork n'exigerait aucune approbation.
 * Ici : un détecteur PUR, qui rend l'« acte » à faire approuver (le texte exact que l'accord de l'humain
 * couvrira), ou null.
 *
 * Ce que ce n'est PAS : un analyseur de shell. Un `eval`, une variable, un script Node qui appelle l'API
 * ne sont pas vus. C'est un fil tendu sur le chemin naturel (la commande qu'on tape), comme le verrou
 * d'approbation (`approval-gate.ts`) : il ferme le geste documenté, il ne rend pas l'abus impossible. Les
 * faux positifs sont acceptés (une approbation de plus) ; le silence ne l'est pas.
 *
 * Branchement : un hook PreToolUse sur l'outil Bash appelle `publicGithubActInBash(commande)` ; sur les
 * outils MCP GitHub, `publicGithubActInMcp(nomCourt, entrée)`. Si un acte est rendu, le hook refuse tant
 * qu'une approbation liée à `actFingerprint("github-public", acte)` n'existe pas (cf. `approval-gate.ts`).
 */

export interface PublicGithubAct {
  /** `repo-create-public`, `repo-visibility-public`, `fork`, `gist-public`, `api-public`. */
  kind: string;
  /** Ce qui l'a fait reconnaître, lisible. */
  why: string;
}

/** Coupe une ligne de commande en segments de mots. Hors guillemets, `;` `&` `|` `(` `)` `` ` `` et
 *  les retours à la ligne séparent les commandes ; un texte entre guillemets reste UN mot (un message
 *  de commit qui cite une commande n'est pas cette commande). Volontairement simple : des mots, pas
 *  une sémantique de shell. */
export function shellSegments(cmd: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  const endWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/.test(ch) && ch !== "\n") endWord();
    else if (/[;&|()`\n]/.test(ch)) endSegment(); // `$(` laisse un `$` orphelin au mot d'avant : sans effet
    else word += ch;
  }
  endSegment();
  return out;
}

const isGh = (w: string): boolean => /(^|\/)gh$/.test(w);
const hasFlag = (ws: string[], ...flags: string[]): boolean => ws.some((w) => flags.some((f) => w === f || w.startsWith(`${f}=`)));
const flagValue = (ws: string[], flag: string): string | null => {
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === flag) return ws[i + 1] ?? null;
    if (ws[i].startsWith(`${flag}=`)) return ws[i].slice(flag.length + 1);
    // Forme collée d'un drapeau court : `-XPOST`.
    if (/^-[A-Za-z]$/.test(flag) && ws[i].startsWith(flag) && ws[i].length > 2) return ws[i].slice(2);
  }
  return null;
};
/** Un corps ou un champ qui demande la visibilité publique (`private=false`, `"private": false`,
 *  `visibility=public`…). */
const PUBLIC_FIELD = /\bprivate["']?\s*[:=]\s*(false|0)\b|\bvisibility["']?\s*[:=]\s*["']?public\b/i;
/** Points d'API qui CRÉENT un dépôt (public par défaut côté API) ou un fork. */
const CREATE_ENDPOINT = /(^|\/)(user\/repos|orgs\/[^/\s]+\/repos|repos\/[^/\s]+\/[^/\s]+\/(forks|generate))\b/;
const PRIVATE_TRUE = /\bprivate["']?\s*[:=]\s*(true|1)\b|\bvisibility["']?\s*[:=]\s*["']?(private|internal)\b/i;

function ghAct(ws: string[]): PublicGithubAct | null {
  const at = ws.findIndex(isGh);
  if (at < 0) return null;
  const rest = ws.slice(at + 1).filter((w) => w !== "--");
  const [a, b] = rest;
  if (a === "repo" && b === "create") {
    if (hasFlag(rest, "--public") || flagValue(rest, "--visibility") === "public") return { kind: "repo-create-public", why: "gh repo create --public" };
    return null;
  }
  if (a === "repo" && b === "edit" && flagValue(rest, "--visibility") === "public") return { kind: "repo-visibility-public", why: "gh repo edit --visibility public" };
  if (a === "repo" && b === "fork") return { kind: "fork", why: "gh repo fork (un fork d'un dépôt public est public)" };
  if (a === "gist" && b === "create" && hasFlag(rest, "--public", "-p")) return { kind: "gist-public", why: "gh gist create --public" };
  if (a === "api") {
    const text = rest.join(" ");
    if (PUBLIC_FIELD.test(text)) return { kind: "api-public", why: "gh api avec private=false / visibility=public" };
    // Le point d'API, où qu'il soit parmi les mots (les valeurs de `-X`, `-H`… ne lui ressemblent pas).
    const endpoint = rest.slice(1).find((w) => CREATE_ENDPOINT.test(w.replace(/^(https:\/\/api\.github\.com)?\/?/, ""))) ?? null;
    const method = (flagValue(rest, "-X") ?? flagValue(rest, "--method") ?? "").toUpperCase();
    const writes = method === "POST" || (!method && hasFlag(rest, "-f", "-F", "--field", "--raw-field", "--input"));
    if (endpoint && writes && !PRIVATE_TRUE.test(text))
      return { kind: "api-public", why: `gh api ${method || "POST"} ${endpoint} (création sans private=true : publique par défaut)` };
  }
  return null;
}

function httpAct(ws: string[]): PublicGithubAct | null {
  if (!ws.some((w) => /(^|\/)(curl|wget|http|https|xh)$/.test(w))) return null;
  const text = ws.join(" ");
  if (!/api\.github\.com/.test(text)) return null;
  if (PUBLIC_FIELD.test(text)) return { kind: "api-public", why: "appel HTTP à api.github.com avec private=false / visibility=public" };
  const url = ws.find((w) => /api\.github\.com/.test(w)) ?? "";
  const path = url.replace(/^.*api\.github\.com\/?/, "");
  const writes = /\s(-X|--request)(\s*|=)(POST|PATCH|PUT)\b/i.test(` ${text}`) || hasFlag(ws, "-d", "--data", "--data-raw", "--json");
  if (writes && CREATE_ENDPOINT.test(path) && !PRIVATE_TRUE.test(text)) return { kind: "api-public", why: `appel HTTP de création sur api.github.com/${path}` };
  return null;
}

/** Ôte le corps des here-documents (`<<'EOF' … EOF`) : c'est du texte (un message de commit qui
 *  CITE `gh repo create --public`), pas une commande. */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "<<heredoc");
}

/** L'acte public que porte cette commande Bash, ou null. PUR. */
export function publicGithubActInBash(command: string): PublicGithubAct | null {
  if (!/\bgh\b|api\.github\.com/.test(command)) return null; // chemin rapide : l'immense majorité des commandes
  for (const ws of shellSegments(stripHeredocs(command))) {
    const act = ghAct(ws) ?? httpAct(ws);
    if (act) return act;
  }
  return null;
}

/** L'acte public d'un appel d'outil MCP GitHub (`create_repository` non privé, `fork_repository`),
 *  ou null. PUR. */
export function publicGithubActInMcp(shortTool: string, input: Record<string, unknown>): PublicGithubAct | null {
  if (shortTool === "create_repository" && input.private !== true) return { kind: "repo-create-public", why: "create_repository sans private:true" };
  if (shortTool === "fork_repository") return { kind: "fork", why: "fork_repository (un fork d'un dépôt public est public)" };
  return null;
}

/** Le texte exact qu'une approbation couvre : la commande telle quelle, ou l'appel MCP en JSON
 *  canonique (clés triées). L'accord vaut pour CE texte, pas pour un voisin. */
export function mcpActText(tool: string, input: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.keys(input).sort().map((k) => [k, input[k]]));
  return `${tool} ${JSON.stringify(sorted)}`;
}
