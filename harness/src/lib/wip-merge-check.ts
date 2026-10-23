/**
 * wip-merge-check — que ferait la fusion d'une branche de FILET (« wip ») dans `main` ?
 *
 * LE PIÈGE. Quand un agent travaille dans un worktree isolé, un filet sauvegarde son travail inachevé
 * dans une branche `…-wip` (un commit d'arbre complet). On lit ensuite cette branche pour décider de la
 * reprendre. Le réflexe est `git diff main..branche` (DEUX points) : ça compare deux pointes, donc ça
 * affiche comme « suppressions de la branche » tout ce que d'AUTRES lignes de travail ont ajouté à `main`
 * depuis le départ. Spécimen : `main..wip` = 2 010 fichiers, +30 866 −427 826 ; `main...wip` (TROIS
 * points, ce que la branche a changé) = 12 fichiers, +342 −5 ; la couche du filet seule (pointe contre
 * son parent) = 8 fichiers, +93 −0. Le filet n'effaçait rien : le diff à deux points mentait, et c'est
 * souvent le message d'échec lui-même qui prescrivait ce diff.
 *
 * Il reste UN mécanisme réel : l'agent déplace son HEAD sur un `main` plus récent (`git reset --soft`,
 * rebase, réécriture d'un fichier lu avant le pull) et son disque garde l'ancienne version d'un fichier.
 * Le filet enregistre alors la différence comme une SUPPRESSION des lignes reçues entre-temps, et une
 * vraie fusion les effacerait.
 *
 * D'où ce module, qui teste la proposition elle-même au lieu d'un proxy : il SIMULE la fusion
 * (`git merge-tree --write-tree` : ni ref, ni index, ni arbre de travail touchés ; seuls des objets non
 * référencés entrent dans la base, que `git gc` ramasse) et compte les lignes arrivées dans `main`
 * depuis le départ de l'agent (`base`) que cette fusion ferait disparaître. Une fusion à trois voies
 * propre ne peut pas effacer ce que seul `main` a ajouté après la base de fusion : un compte non nul
 * dit donc que la branche porte elle-même la suppression (mécanisme réel), jamais que `main` a avancé.
 *
 * Aucune ref écrite, git injecté (`GitCall`) : la seule impureté est au bout d'un paramètre.
 * Prérequis : git ≥ 2.38 (`merge-tree --write-tree`).
 */
import { spawnSync } from "node:child_process";

/** Sortie d'un appel git : le code compte (`merge-tree` rend 1 sur conflit, avec une sortie utile). */
export interface GitOut {
  code: number;
  stdout: string;
}

/** `git <args>`, ou `null` si git n'a pas pu tourner du tout. */
export type GitCall = (args: string[]) => GitOut | null;

/** Git réel sur `repo`. `core.quotePath=false` : un chemin accentué reste lisible et comparable. */
export function gitCallIn(repo: string): GitCall {
  return (args) => {
    const r = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error || r.status === null) return null;
    return { code: r.status, stdout: r.stdout ?? "" };
  };
}

export interface DiffLines {
  added: string[];
  removed: string[];
}

/**
 * Lignes ajoutées et retirées par chemin, depuis un `git diff -U0 --no-renames`. PUR.
 *
 * Machine à états : les lignes `--- ` / `+++ ` ne sont des en-têtes qu'entre `diff --git` et le premier
 * `@@`. Dans un bloc, une ligne retirée dont le texte commence par `-- ` s'écrit `--- …` : la lire comme
 * un en-tête ferait changer de fichier au milieu d'un bloc.
 */
export function parseDiffU0(diff: string): Map<string, DiffLines> {
  const out = new Map<string, DiffLines>();
  let inHeader = false;
  let minus: string | null = null;
  let plus: string | null = null;
  let current: DiffLines | null = null;
  const strip = (p: string, prefix: string): string | null => {
    const t = p.replace(/\t$/, "");
    if (t === "/dev/null") return null;
    return t.startsWith(prefix) ? t.slice(prefix.length) : t;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      minus = plus = null;
      current = null;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- ")) minus = strip(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) plus = strip(line.slice(4), "b/");
      else if (line.startsWith("@@")) {
        inHeader = false;
        const path = plus ?? minus;
        if (path === null) continue;
        current = out.get(path) ?? { added: [], removed: [] };
        out.set(path, current);
      }
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (!current) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return out;
}

export interface RevertedFile {
  path: string;
  /** Lignes arrivées depuis la base que la fusion (ou la version de la branche) ferait disparaître. */
  lines: number;
  /** Une de ces lignes, pour qu'on la reconnaisse sans ouvrir le diff. */
  sample: string;
}

/** Une ligne trop courte (`}`, `---`, vide) se retrouve partout : la compter ferait crier à tort. */
export const MIN_SIGNIFICANT_LENGTH = 4;

/**
 * Par chemin, les lignes RETIRÉES qui font partie des lignes ARRIVÉES (multiensemble, espaces de fin
 * ignorés, lignes de moins de `MIN_SIGNIFICANT_LENGTH` caractères utiles écartées). PUR.
 */
export function revertedLines(arrived: Map<string, string[]>, removed: Map<string, string[]>): RevertedFile[] {
  const out: RevertedFile[] = [];
  for (const [path, gone] of removed) {
    const pool = new Map<string, number>();
    for (const l of arrived.get(path) ?? []) {
      const k = l.trimEnd();
      if (k.trim().length < MIN_SIGNIFICANT_LENGTH) continue;
      pool.set(k, (pool.get(k) ?? 0) + 1);
    }
    if (pool.size === 0) continue;
    let lines = 0;
    let sample = "";
    for (const l of gone) {
      const k = l.trimEnd();
      const n = pool.get(k) ?? 0;
      if (n <= 0) continue;
      pool.set(k, n - 1);
      lines++;
      if (!sample) sample = k.trim();
    }
    if (lines > 0) out.push({ path, lines, sample });
  }
  return out.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
}

export interface ShortStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** `git diff --shortstat` → nombres. Une sortie vide est un diff vide (0, 0, 0). PUR. */
export function parseShortStat(s: string): ShortStat {
  const n = (re: RegExp): number => Number(s.match(re)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

/** `git merge-tree --write-tree --name-only` → arbre résultant et fichiers en conflit. PUR. */
export function parseMergeTree(stdout: string): { tree: string | null; conflicts: string[] } {
  const lines = stdout.split("\n");
  const tree = /^[0-9a-f]{40,64}$/.test(lines[0] ?? "") ? lines[0] : null;
  const conflicts: string[] = [];
  for (const l of lines.slice(1)) {
    if (l === "") break;
    conflicts.push(l);
  }
  return { tree, conflicts: [...new Set(conflicts)] };
}

export type WipMergeVerdict =
  /** La pointe de la branche est déjà un ancêtre de `main` : rien à fusionner. */
  | "ancetre"
  /** Fusion propre qui n'efface rien de ce qui est arrivé dans `main` depuis la base. */
  | "sans-risque"
  /** Fusion propre qui EFFACERAIT des lignes arrivées depuis la base : ne pas fusionner la pointe. */
  | "efface"
  /** Base de départ inconnue (repli sur la base de fusion) et la fusion effacerait des lignes de main que la
   *  couche du filet retire : suppression voulue ou disque périmé, le repli ne sait pas les distinguer. Alarme. */
  | "douteux"
  /** Fusion en conflit : à faire à la main ; `theirs` dit ce que coûterait « prendre la branche ». */
  | "conflit"
  /** Le contrôle n'a pas pu tourner : on ne sait pas, et on le dit. */
  | "illisible";

export interface WipMergeCheck {
  verdict: WipMergeVerdict;
  wip: string;
  main: string;
  /** La base contre laquelle « arrivé depuis » est compté. */
  base: string | null;
  /** `depart` = le commit d'où l'agent est parti (que TU as noté) ; `fusion` = base de fusion, faute de mieux. */
  baseSource: "depart" | "fusion" | null;
  /** La couche du filet seule (commit de filet contre son parent), si la pointe en est une. */
  layer: ShortStat | null;
  /** Ce que la branche a changé depuis qu'elle a quitté `main` (`main...wip`, trois points). */
  own: ShortStat | null;
  /** Ce qu'affiche `main..wip` (deux points) : le piège, chiffré pour qu'on le reconnaisse. */
  naive: ShortStat | null;
  conflicts: string[];
  /** Fusion propre : lignes arrivées que la fusion effacerait (fichiers sans conflit). */
  reverted: RevertedFile[];
  /** Fichiers en conflit : lignes arrivées qu'effacerait la version de la branche prise en bloc. */
  theirs: RevertedFile[];
  /** Repli seulement (`baseSource` ≠ `depart`) : lignes retirées par la couche du filet, toujours dans main,
   *  que la fusion effacerait. La base de fusion ne voit pas ce qui est arrivé AVANT que l'agent se recale. */
  layerReverted: RevertedFile[];
  detail?: string;
}

/** Le sujet du commit de filet : `wip(...)` ou `wip: …` par défaut. À adapter à ton filet. */
export const SUJET_FILET_DEFAUT = /^wip\b/i;

export interface WipMergeOptions {
  /** Branche ou sha à examiner. */
  wip: string;
  /** Révision de `main` contre laquelle simuler (défaut `origin/main`, repli `main`). */
  main?: string;
  /** D'où l'agent est parti (sha noté au lancement) ; absent → base de fusion, et le mécanisme réel se voit moins. */
  base?: string | null;
  /** Reconnaît le sujet du commit de filet (défaut `SUJET_FILET_DEFAUT`). */
  sujetFilet?: RegExp;
}

/** Simule la fusion de `wip` dans `main`, sans rien écrire. Ne lève jamais : un échec rend `illisible`. */
export function checkWipMerge(git: GitCall, o: WipMergeOptions): WipMergeCheck {
  const empty = (verdict: WipMergeVerdict, detail: string, wip = o.wip, main = o.main ?? "origin/main"): WipMergeCheck => ({
    verdict,
    wip,
    main,
    base: null,
    baseSource: null,
    layer: null,
    own: null,
    naive: null,
    conflicts: [],
    reverted: [],
    theirs: [],
    layerReverted: [],
    detail,
  });
  try {
    const rev = (r: string): string | null => {
      // `--end-of-options` : un nom qui commence par « - » reste un nom, jamais une option.
      const res = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`]);
      const sha = res && res.code === 0 ? res.stdout.trim() : "";
      return sha || null;
    };
    const wip = rev(o.wip);
    if (!wip) return empty("illisible", `révision introuvable : ${o.wip}`);
    const mainRef = o.main ?? (rev("origin/main") ? "origin/main" : "main");
    const main = rev(mainRef);
    if (!main) return empty("illisible", `révision introuvable : ${mainRef}`, wip);
    const isAncestor = (a: string, b: string): boolean => git(["merge-base", "--is-ancestor", a, b])?.code === 0;
    if (isAncestor(wip, main)) return { ...empty("ancetre", "la pointe est déjà dans main", wip, main), detail: undefined };

    let base: string | null = null;
    let baseSource: WipMergeCheck["baseSource"] = null;
    const depart = o.base ? rev(o.base) : null;
    if (depart && isAncestor(depart, main)) {
      base = depart;
      baseSource = "depart";
    } else {
      const mb = git(["merge-base", main, wip]);
      base = mb && mb.code === 0 ? mb.stdout.trim().split("\n")[0] || null : null;
      baseSource = base ? "fusion" : null;
    }
    if (!base) return empty("illisible", "aucune base commune entre la branche et main", wip, main);

    const stat = (args: string[]): ShortStat | null => {
      const r = git(["diff", "--shortstat", "--no-renames", ...args]);
      return r && r.code === 0 ? parseShortStat(r.stdout) : null;
    };
    const subject = git(["log", "-1", "--format=%s", wip]);
    const layer = subject && (o.sujetFilet ?? SUJET_FILET_DEFAUT).test(subject.stdout.trim()) && rev(`${wip}^`) ? stat([`${wip}^`, wip]) : null;
    const own = stat([`${main}...${wip}`]);
    const naive = stat([main, wip]);

    const merged = git(["merge-tree", "--write-tree", "--name-only", main, wip]);
    if (!merged || (merged.code !== 0 && merged.code !== 1))
      return { ...empty("illisible", "git merge-tree en échec (git ≥ 2.38 requis)", wip, main), base, baseSource, layer, own, naive };
    const { tree, conflicts } = parseMergeTree(merged.stdout);
    if (!tree) return { ...empty("illisible", "git merge-tree n'a rendu aucun arbre", wip, main), base, baseSource, layer, own, naive };

    const diffU0 = (args: string[]): Map<string, DiffLines> | null => {
      const r = git(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", ...args]);
      return r && r.code === 0 ? parseDiffU0(r.stdout) : null;
    };
    const afterMerge = diffU0([main, tree]);
    if (!afterMerge) return { ...empty("illisible", "git diff main → fusion en échec", wip, main), base, baseSource, layer, own, naive };
    const conflictSet = new Set(conflicts);
    const removedByMerge = new Map<string, string[]>();
    for (const [p, d] of afterMerge) if (!conflictSet.has(p) && d.removed.length > 0) removedByMerge.set(p, d.removed);
    const removedByTheirs = new Map<string, string[]>();
    if (conflicts.length > 0) {
      const t = diffU0([main, wip, "--", ...conflicts]);
      for (const [p, d] of t ?? []) if (d.removed.length > 0) removedByTheirs.set(p, d.removed);
    }
    // Les lignes arrivées ne se lisent que sur les chemins où quelque chose disparaîtrait : une branche
    // vieille d'un mois a des centaines de milliers de lignes de retard, inutile de les tirer toutes.
    const paths = [...new Set([...removedByMerge.keys(), ...removedByTheirs.keys()])];
    const arrived = new Map<string, string[]>();
    if (paths.length > 0) {
      const a = diffU0([base, main, "--", ...paths]);
      if (!a) return { ...empty("illisible", "git diff base → main en échec", wip, main), base, baseSource, layer, own, naive, conflicts };
      for (const [p, d] of a) arrived.set(p, d.added);
    }
    const reverted = revertedLines(arrived, removedByMerge);
    const theirs = revertedLines(arrived, removedByTheirs);
    // Sans la base de départ, une ligne reçue AVANT que l'agent se recale sur main n'est pas « arrivée depuis
    // la base de fusion » et le spécimen même sortirait propre. La couche du filet dit ce qu'elle retire :
    // ce qu'elle retire et que la fusion effacerait de main ne peut pas passer pour sans risque.
    let layerReverted: RevertedFile[] = [];
    if (baseSource !== "depart" && layer && layer.deletions > 0 && removedByMerge.size > 0) {
      const l = diffU0([`${wip}^`, wip, "--", ...removedByMerge.keys()]);
      if (!l) return { ...empty("illisible", "git diff de la couche du filet en échec", wip, main), base, baseSource, layer, own, naive, conflicts };
      const layerRemoved = new Map<string, string[]>();
      for (const [p, d] of l) if (d.removed.length > 0) layerRemoved.set(p, d.removed);
      // Moins ce que `reverted` compte déjà : une même ligne ne se compte pas deux fois.
      const rest = new Map<string, string[]>();
      for (const [p, gone] of removedByMerge) {
        const dejaVu = new Map<string, number>();
        for (const x of arrived.get(p) ?? []) dejaVu.set(x.trimEnd(), (dejaVu.get(x.trimEnd()) ?? 0) + 1);
        rest.set(
          p,
          gone.filter((x) => {
            const n = dejaVu.get(x.trimEnd()) ?? 0;
            if (n > 0) dejaVu.set(x.trimEnd(), n - 1);
            return n <= 0;
          }),
        );
      }
      layerReverted = revertedLines(layerRemoved, rest);
    }
    const verdict: WipMergeVerdict =
      conflicts.length > 0 ? "conflit" : reverted.length > 0 ? "efface" : layerReverted.length > 0 ? "douteux" : "sans-risque";
    return { verdict, wip, main, base, baseSource, layer, own, naive, conflicts, reverted, theirs, layerReverted };
  } catch (e) {
    return empty("illisible", `contrôle en échec : ${(e as Error).message}`);
  }
}

const fmtStat = (s: ShortStat): string => `${s.files} fichier${s.files > 1 ? "s" : ""}, +${s.insertions} −${s.deletions}`;

const fmtFiles = (f: RevertedFile[], max = 3): string =>
  f
    .slice(0, max)
    .map((x) => `${x.path} (${x.lines})`)
    .join(", ") + (f.length > max ? ` et ${f.length - max} autre(s)` : "");

const total = (f: RevertedFile[]): number => f.reduce((n, x) => n + x.lines, 0);

/** Le contrôle dit-il qu'un geste ordinaire ferait disparaître du travail reçu ? (`efface`, `douteux`, ou un
 *  conflit dont la résolution « prendre la branche » efface), ou n'a-t-il rien pu dire (`illisible`) ? PUR. */
export function wipCheckAlarms(c: WipMergeCheck): boolean {
  return c.verdict === "efface" || c.verdict === "douteux" || c.verdict === "illisible" || (c.verdict === "conflit" && (c.theirs.length > 0 || c.reverted.length > 0));
}

/** Une phrase : le verdict, ce qu'il coûte, et le geste qui va avec. PUR. */
export function wipCheckVerdictLine(c: WipMergeCheck, branch: string): string {
  const since = c.baseSource === "depart" ? "depuis le départ de l'agent" : "depuis la base de fusion";
  switch (c.verdict) {
    case "ancetre":
      return `✓ \`${branch}\` est déjà contenue dans main : rien à fusionner.`;
    case "sans-risque":
      return `✓ Fusion simulée (\`git merge-tree\`) : propre, elle n'efface rien de ce qui est arrivé dans main ${since}.`;
    case "efface":
      return (
        `⚠️ Fusion simulée : elle EFFACERAIT ${total(c.reverted)} ligne(s) arrivée(s) dans main ${since} — ${fmtFiles(c.reverted)}` +
        ` (ex. « ${c.reverted[0].sample.slice(0, 80)} »). Ne fusionne pas la pointe : le commit propre est en dessous (\`git log --oneline main..${branch}\`).`
      );
    case "douteux":
      return (
        `⚠️ Fusion simulée, base de départ inconnue : elle effacerait de main ${total(c.layerReverted)} ligne(s) que la couche du filet retire — ${fmtFiles(c.layerReverted)}` +
        ` (ex. « ${c.layerReverted[0].sample.slice(0, 80)} »). Suppression voulue, ou disque périmé qui efface du travail reçu :` +
        ` la base de fusion ne tranche pas. Ne fusionne pas la pointe sans avoir lu \`git show ${branch}\`.`
      );
    case "conflit":
      return (
        `⚔️ Fusion simulée en conflit sur ${c.conflicts.length} fichier(s) (${c.conflicts.slice(0, 3).join(", ")}${c.conflicts.length > 3 ? "…" : ""}) : à fusionner à la main.` +
        (c.theirs.length > 0
          ? ` Prendre la version de la branche en bloc effacerait ${total(c.theirs)} ligne(s) arrivée(s) ${since} (${fmtFiles(c.theirs)}).`
          : "") +
        (c.reverted.length > 0 ? ` Hors conflit, elle effacerait aussi ${total(c.reverted)} ligne(s) (${fmtFiles(c.reverted)}).` : "")
      );
    default:
      return `? Fusion non simulée (${c.detail ?? "raison inconnue"}) : lis \`git diff main...${branch}\` (trois points) avant d'en reprendre quoi que ce soit.`;
  }
}

/** Le rapport complet. PUR. */
export function formatWipCheck(c: WipMergeCheck, branch: string): string[] {
  const short = (s: string | null): string => (s ? s.slice(0, 8) : "?");
  const lines = [
    `${branch} (${short(c.wip)}) contre main (${short(c.main)})` +
      (c.base ? `, base ${c.baseSource === "depart" ? "de départ" : "de fusion"} ${short(c.base)}` : "") +
      " :",
  ];
  if (c.layer) lines.push(`  · la couche du filet seule (pointe contre son parent) : ${fmtStat(c.layer)}`);
  if (c.own) lines.push(`  · le travail de la branche depuis main (\`main...${branch}\`, trois points) : ${fmtStat(c.own)}`);
  if (c.naive && c.own && c.naive.deletions > c.own.deletions)
    lines.push(
      `  · \`git diff main..${branch}\` (deux points) affiche ${fmtStat(c.naive)} : ce sont les avancées de main depuis le départ, pas des suppressions de la branche. Ne le lis pas.`,
    );
  if (c.baseSource === "fusion")
    lines.push("  · base de départ inconnue : comparé à la base de fusion, une suppression reçue AVANT que l'agent se recale sur main ne se voit pas.");
  lines.push(`  ${wipCheckVerdictLine(c, branch)}`);
  return lines;
}
