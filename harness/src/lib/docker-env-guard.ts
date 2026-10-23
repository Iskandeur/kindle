/**
 * Garde « env d'un conteneur » : logique PURE sur le texte d'une commande Bash, à brancher dans un hook
 * PreToolUse de Claude Code sur l'outil `Bash` (pour toutes les sessions et tous les jobs).
 *
 * Pourquoi : la sortie d'une commande atterrit dans le transcript, puis dans le résultat d'un job, le tableau
 * de tickets, une PR. Un `docker inspect` nu imprime `.Config.Env` EN VALEURS, donc chaque jeton passé au
 * conteneur par `env_file`. Même chose pour `docker exec … env` / `printenv` / `/proc/N/environ`.
 *
 * Refusé (dans un même pipeline) :
 *  - `docker inspect` / `docker container inspect` / `docker image inspect` SANS `--format` (`-f`) ;
 *  - un format qui sort l'env (`.Config.Env`), toute la config (`.Config`, `json .Config`) ou tout l'objet
 *    (`{{json .}}`, `{{.}}` hors d'un `range`) ;
 *  - `docker exec` / `docker compose exec` dont la commande est `env`, `printenv`, `export -p`, `set`, ou lit
 *    `/proc/…/environ` ;
 *  - `docker compose config` sans option qui en restreint la sortie (il résout le .env en clair).
 *
 * Hors de portée (écrit pour qu'on ne le croie pas couvert) : un programme qui lit l'env DANS le conteneur
 * (`docker exec x node -e 'console.log(process.env)'`, python, `cat` d'un .env monté), un `docker inspect`
 * lancé par un script plutôt que par la ligne Bash elle-même, une substitution IMBRIQUÉE
 * (`$(echo $(docker inspect x))`) ou un `bash -c "…"` aux guillemets échappés : seul le premier niveau
 * d'enveloppe est déplié. Le garde juge le texte d'une commande, pas ce qu'elle exécute.
 *
 * Passe : une source qui n'émet que NOM=VALEUR (le `range .Config.Env`, `docker exec … env`) coupée au `=` dans
 * le même pipeline (`| cut -d= -f1`, `| awk -F= '{print $1}'`, ou un `sed` qui efface depuis le `=`), ou toute
 * autre source filtrée par `cut -s -d= -f1` (qui supprime les lignes sans `=`, donc ne réimprime ni Cmd ni
 * Args) : on y lit les NOMS, jamais les valeurs. Un `docker inspect` sans `--format` reste refusé même suivi
 * d'un `cut`, et `docker exec x env -u FOO` (options seules, aucune commande) imprime le reste de l'env : refusé.
 */

export const SAFE_FORM =
  "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <conteneur> | cut -s -d= -f1";

/**
 * Un étage du pipeline coupe-t-il chaque ligne au premier `=` (noms seulement) ? `cut`, `awk` et `sed`
 * RÉIMPRIMENT en entier toute ligne sans `=` (Cmd, Args, Entrypoint, labels d'un inspect complet) : leur coupe
 * ne vaut donc que sur une source qui n'émet QUE des lignes NOM=VALEUR. Seule exception, `cut -s`
 * (only-delimited), qui SUPPRIME les lignes sans `=` : il vaut sur toute source, sauf un inspect sans
 * `--format` (refusé dans tous les cas).
 */
const NAME_ONLY_FILTER = [
  /^cut\s+(?:-s\s+)?(?:-d\s*['"]?=['"]?\s+(?:-s\s+)?-f\s*1|-f\s*1\s+(?:-s\s+)?-d\s*['"]?=['"]?|--delimiter=['"]?=['"]?\s+(?:--only-delimited\s+)?--fields=1)(?:\s|$)/,
  /^awk\s+-F\s*['"]?=['"]?\s+['"]\{\s*print\s+\$1\s*;?\s*\}['"]/,
  /^sed\s+(?:-E\s+)?['"]s\/=\.\*\/\/g?['"]/,
];
/** `cut` qui supprime les lignes sans `=` (`-s`, `-sd=`, `--only-delimited`) : sûr sur toute source. */
const CUT_SOLO = /^cut\s(?:.*\s)?(?:-s|-sd\S*|--only-delimited)(?:\s|$)/;
/** Le format `range .Config.Env` qui n'imprime que l'élément de la boucle : la source n'émet que NOM=VALEUR. */
const FORMAT_ENV_LIGNES = /^\{\{-?\s*range\s+\.Config\.Env\s*-?\}\}(?:\{\{-?\s*(?:println\s+\.|\.|"\\n")\s*-?\}\}|\s)*\{\{-?\s*end\s*-?\}\}$/;

/** Découpe grossière en pipelines (séparateurs `;` `&&` `||` saut de ligne), en respectant les guillemets simples/doubles. */
export function splitPipelines(command: string): string[][] {
  const out: string[][] = [];
  let stages: string[] = [];
  let cur = "";
  let q: string | null = null;
  const flushStage = (): void => {
    stages.push(cur.trim());
    cur = "";
  };
  const flushPipeline = (): void => {
    flushStage();
    if (stages.some((s) => s)) out.push(stages.filter((s) => s));
    stages = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flushPipeline();
      i++;
      continue;
    }
    // `&` seul (mise en arrière-plan) sépare aussi ; `2>&1`, `>&2` et `&>` n'en sont pas.
    if (c === ";" || c === "\n" || (c === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")) {
      flushPipeline();
      continue;
    }
    if (c === "|") {
      flushStage();
      continue;
    }
    cur += c;
  }
  flushPipeline();
  return out;
}

/** La valeur de `--format` / `-f` d'une commande inspect, guillemets ôtés ; null si absente. */
function formatOf(stage: string): string | null {
  const m = /(?:^|\s)(?:--format|-f)(?:=|\s+)('([^']*)'|"([^"]*)"|(\S+))/.exec(stage);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

/** Le format sort-il des valeurs d'env (ou un tout qui les contient) ? */
export function formatLeaksEnv(format: string): boolean {
  const f = format.trim();
  // `--format json` : format spécial de la CLI récente, il imprime l'objet entier (l'env compris).
  if (/^json$/i.test(f)) return true;
  // `.Config` n'est sûr que suivi d'un champ précis autre que `Env` (`.Config.Image`, `.Config.Labels`) : tout le reste
  // (`.Config.Env`, `.Config}}`, `.Config | json`, `with .Config`, `index .Config "Env"`, `(.Config).Env`) peut sortir l'env.
  if (/\.Config(?!\.(?!Env\b)\w)/.test(f)) return true;
  // `{{.}}` / `{{json .}}` HORS d'une boucle `range … end` (dedans, le point est l'élément de la boucle).
  const outsideRanges = f.replace(/\{\{-?\s*range\b[\s\S]*?\{\{-?\s*end\s*-?\}\}/g, "");
  if (/\{\{-?\s*(?:json\s+)?\.\s*-?\}\}/.test(outsideRanges)) return true;
  return false;
}

// `docker` doit être le MOT DE COMMANDE de l'étage (après d'éventuels sudo/timeout N/xargs/VAR=…, ou une ouverture de
// groupe `(` `{`) : un message de commit ou un motif de grep qui CITE « docker inspect » ne lance rien. Les commandes
// enveloppées (`bash -c "…"`, `$(…)`, backquotes) sont dépliées et jugées à leur tour.
// Un argument de `xargs` n'est jamais un mot que le groupe externe sait prendre (préfixe, `VAR=`) : sans cette
// exclusion, `xargs xargs xargs …` se découpe d'un nombre exponentiel de façons et la regex s'emballe (ReDoS).
const PREFIX = String.raw`(?:do|then|else|sudo|nice|command|timeout|xargs|docker)\b|[A-Za-z_]\w*=`;
const DOCKER = String.raw`^[({\s]*(?:(?:do|then|else|sudo|nice|command|timeout\s+\S+|xargs(?:\s+(?!${PREFIX})\S+)*|[A-Za-z_]\w*=\S*)\s+)*docker\s+`;
const INSPECT = new RegExp(DOCKER + String.raw`(?:container\s+|image\s+)?inspect(?:\s|$)`);
const EXEC = new RegExp(DOCKER + String.raw`(?:container\s+|compose\s+(?:-f\s+\S+\s+|--file[=\s]\S+\s+|-p\s+\S+\s+)*)?exec\s`);
const COMPOSE_CONFIG = new RegExp(DOCKER + String.raw`compose\s+(?:(?:-f|--file|-p|--project-name|--env-file)[=\s]\S+\s+)*config(?:\s|$)`);
// `env`/`printenv` comme COMMANDE dans la commande exécutée : suivis d'une fin, d'un guillemet ou d'un opérateur shell
// (`sh -c 'env | grep X'` reste un seul étage côté hôte). `env FOO=1 cmd` (préfixe) passe.
const EXEC_ENV_CMD = /(?:^|[\s'"(;|&])(?:env(?:\s+(?:-[0iv]+|--null|--ignore-environment|--debug|-u\s*[^\s'"|;&)<>]+|--unset(?:=|\s+)[^\s'"|;&)<>]+))*|printenv(?:\s+(?:-0|--null|\w+))*|export\s+-p|set)\s*(?=['"|;&)<>]|\d+>|$)|\/proc\/[\w$]+\/environ/;
const COMPOSE_CONFIG_RESTRICTED = /\s--(?:services|volumes|images|profiles|networks|hash|quiet)\b|\s-q\b/;
/** Une redirection vers un fichier (hors `2>&1` / `>&2`) : la sortie entière y part avant toute coupe. */
const REDIRECT = /(?:^|[^0-9&])>{1,2}(?!&)|&>/;

const SANS_QUOTES = (s: string): string => s.replace(/'[^']*'|"[^"]*"/g, "");
/** Filtres de texte qui n'écrivent rien ailleurs que sur leur sortie standard (`sort` et `uniq` : voir filtreInoffensif). */
const FILTRES_INOFFENSIFS = /^(?:grep|egrep|fgrep|sort|head|tail|tr|cut|uniq|wc)(?:\s|$)/;
/** La tête du pipeline ne copie pas sa sortie (ni `tee`, ni redirection vers un fichier). */
function teteSansCopie(stage: string): boolean {
  return !/(?:^|[\s/])tee\b/.test(stage) && !REDIRECT.test(SANS_QUOTES(stage));
}
/** Étage intermédiaire reconnu : un filtre de la liste blanche, sans redirection, sans option d'écriture (`sort -o`). */
function filtreInoffensif(stage: string): boolean {
  const s = stage.trim();
  if (!FILTRES_INOFFENSIFS.test(s)) return false;
  const nu = SANS_QUOTES(s);
  if (REDIRECT.test(nu) || /[`$]\(|`|\$\(/.test(s)) return false;
  // `sort` (-o, --out…, --compress-program) et `uniq` (2ᵉ opérande = fichier de sortie) peuvent écrire ailleurs ou lancer un
  // programme : on ne les admet qu'en options courtes sans `o`, sans aucun opérande.
  if (/^(?:sort|uniq)(?:\s|$)/.test(s)) return /^(?:sort|uniq)(?:\s+-[A-Za-np-z]+)*$/.test(s);
  return true;
}

/** Les commandes enveloppées : `$(…)`, `` `…` ``, et l'argument de `-c` d'un shell. */
function innerCommands(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\$\(([^()]*)\)/g)) out.push(m[1]!);
  for (const m of command.matchAll(/`([^`]*)`/g)) out.push(m[1]!);
  for (const m of command.matchAll(/\b(?:ba|z|da)?sh\s+(?:-\w+\s+)*-c\s+(?:'([^']*)'|"([^"]*)")/g)) out.push((m[1] ?? m[2])!);
  return out;
}

/** La raison du refus, ou null si la commande est sûre. */
export function dockerEnvLeakInBash(command: string, depth = 0): string | null {
  if (!/docker/.test(command)) return null;
  if (depth < 3) {
    for (const inner of innerCommands(command)) {
      const why = dockerEnvLeakInBash(inner, depth + 1);
      if (why) return why;
    }
  }
  // Chaque étage est jugé comme une tête possible (`… | xargs docker inspect`), avec les étages qui le suivent.
  for (const pipeline of splitPipelines(command)) for (let j = 0; j < pipeline.length; j++) {
    const first = pipeline[j];
    const rest = pipeline.slice(j + 1);
    if (!first) continue;
    // La coupe au `=` ne vaut que si rien n'a vu la sortie entière avant elle : ni `tee`, ni redirection vers un fichier.
    const cut = rest.findIndex((s) => NAME_ONLY_FILTER.some((re) => re.test(s)));
    // Liste BLANCHE : la tête ne doit ni copier ni rediriger, et chaque étage entre elle et la coupe doit être
    // un filtre connu inoffensif ; tout autre verbe (`sponge`, `dd of=`, `sed w`, `awk` qui redirige, `curl -d @-`…)
    // peut avoir écrit la sortie entière ailleurs avant la coupe.
    const intermediaires = cut < 0 ? [] : rest.slice(0, cut);
    if (cut >= 0 && teteSansCopie(first) && intermediaires.every(filtreInoffensif)) {
      const fmtTete = INSPECT.test(first) ? formatOf(first.slice(first.search(/\binspect\b/))) : undefined;
      const sourcePure = (fmtTete != null && FORMAT_ENV_LIGNES.test(fmtTete.trim())) ||
        (EXEC.test(first) && EXEC_ENV_CMD.test(first.slice(first.search(/\bexec\s/) + 5)));
      // Un inspect sans `--format` reste refusé (plus bas) ; sinon la coupe vaut sur une source pure, ou par `cut -s`.
      if (fmtTete !== null && (sourcePure || CUT_SOLO.test(rest[cut]!))) continue;
    }
    if (INSPECT.test(first)) {
      const fmt = formatOf(first.slice(first.search(/\binspect\b/)));
      if (fmt === null) return "`docker inspect` sans `--format` imprime l'env du conteneur EN VALEURS (chaque jeton de son env_file)";
      if (formatLeaksEnv(fmt)) return "ce `--format` sort l'env (ou la config entière) en valeurs";
    }
    if (EXEC.test(first)) {
      const after = first.slice(first.search(/\bexec\s/) + 5);
      if (EXEC_ENV_CMD.test(after)) return "`docker exec … env/printenv` imprime l'env du conteneur en valeurs";
    }
    if (COMPOSE_CONFIG.test(first) && !COMPOSE_CONFIG_RESTRICTED.test(first)) {
      return "`docker compose config` résout le .env et l'imprime en clair";
    }
  }
  return null;
}

/** Le message de refus complet, avec la forme sûre. */
export function dockerEnvRefusal(why: string): string {
  return `${why}. La sortie d'une commande finit dans le transcript, le résultat du job, parfois le tableau de tickets. ` +
    `Forme sûre (noms seulement) : ${SAFE_FORM}. Pour une seule valeur, compare une empreinte (sha256 tronquée) ` +
    `calculée dans un script, sans l'afficher. Un état ou un champ précis : --format '{{.State.Status}}'.`;
}
