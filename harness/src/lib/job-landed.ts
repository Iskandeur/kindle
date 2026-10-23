/**
 * « Le travail de ce job est-il dans `main` ? » : la question que le statut d'un job ne pose pas.
 *
 * ## Le piège
 *
 * Le statut d'un job (`done`, `error`) porte le **code de sortie du processus `claude -p`**, pas le sort
 * du travail. Un job qui commite, ouvre sa PR, fusionne, puis épuise son budget sur le dernier tour (celui
 * du compte rendu) sort en `error` avec tout son travail dans `main`. Un bilan qui ne compte que les `done`
 * annonce alors « le mécanisme de réparation ne produit rien » alors qu'il a livré, et désigne comme
 * chantier prioritaire un problème qui n'existe pas. Inversement, un job « réussi » qui n'a jamais poussé
 * perd tout son travail avec son worktree.
 *
 * ## La preuve retenue, et celles qui ont été jetées
 *
 * Chacune a été testée sur des jobs réels, chacune tuée par un contre-exemple :
 *
 * 1. **L'ascendance du sha** (`merge-base --is-ancestor`) : le rebase la casse, le correctif est dans
 *    `main` sous un autre sha que celui que le job a écrit.
 * 2. **L'égalité du sujet de commit** : le squash-merge la casse (`main` porte « … (#493) », le job a
 *    écrit le sujet nu).
 * 3. **« Tous les fichiers touchés existent dans main »** : trop facile à satisfaire, donc sans valeur ;
 *    un job peut éditer un fichier préexistant sans jamais rien fusionner.
 *
 * Ce qui reste est une preuve **positive** : au moins un blob du commit du job est byte-identique dans
 * `main`. Un sha de blob ne coïncide pas par hasard. Son prix : elle **s'érode avec le temps** (le jour où
 * `main` a réécrit tous les fichiers d'un vieux job, il redevient « non livré »). Elle est faite pour la
 * fenêtre de quelques jours que lit un bilan, pas pour un audit d'archives. Un `unlanded` n'est pas une
 * preuve d'absence, c'est une absence de preuve : l'afficher À CÔTÉ du statut, pas à sa place.
 *
 * ## Un voyant bloqué au rouge n'apprend plus rien
 *
 * Un filet qui crie sur 7 jobs sur 8 est ignoré, et le jour où il a raison personne ne l'écoute. La cause
 * typique : discriminer par la provenance du parent (« le premier commit non-`wip` est déjà ancêtre de
 * `main` ») confond le sol d'où le job est parti avec le travail du job qui a fusionné normalement. Ce qui
 * discrimine est le **contenu de l'instantané `wip`**, pas la provenance : le commit de préservation est un
 * `git add -A` ; ce qu'il porte hors `scratch/` est, par construction, du travail qui n'est dans aucune
 * branche. Donc :
 *
 *   - l'instantané porte du non-scratch : on crie (le travail ne vit que là) ;
 *   - il n'en porte pas : le job a tout commité, son dernier commit propre répond, par ascendance (sûre)
 *     ou par blob (squash-merge, rebase).
 *
 * L'ascendance est ainsi une preuve **suffisante**, jamais nécessaire.
 *
 * ## Le commit de tête n'est pas forcément du job
 *
 * La branche de préservation du job peut pointer le `main` d'où il est parti (une autre voie a poussé
 * entre-temps) : ascendance et blob sont alors vrais par construction, ils prouvent que *ce commit* est dans
 * `main`, pas qu'il est *du job*. Le verdict demande donc la **provenance** : un commit que le job n'a pas
 * pu écrire ne prouve rien. Deux témoins, chacun suffisant, aucun nécessaire :
 *   - `baseSha` (le sha d'où le worktree est parti la première fois) : la base elle-même ou un de ses
 *     ancêtres existait avant le job ;
 *   - `createdAt` : un commit dont la date de *commit* (`%ct`, que rebase et cherry-pick refont) précède la
 *     création du job n'est pas de lui. Seul témoin des jobs d'avant la colonne `baseSha`.
 * Le verdict est alors `nothing-committed` : ni « atterri », ni « travail à récupérer ».
 *
 * ## Les conventions supposées
 *
 *   - la référence de préservation s'écrit `job-<id>-wip@<sha>` ;
 *   - le commit d'instantané a un sujet `wip(job #<id>) …` (`WIP_SUBJECT`) ;
 *   - le scratch du job vit sous un dossier `scratch*` et n'a pas vocation à atterrir.
 */

/** Exécute `git <args>` et rend la sortie, ou `null` si la commande échoue. Injecté pour rester
 *  testable sans dépôt : c'est la seule impureté de ce module, et elle est au bout d'un paramètre. */
export type GitRunner = (args: string[]) => string | null;

/** Le commit que le daemon pose après une interruption : il ne contient que les fichiers en cours
 *  d'édition (souvent du scratch), pas le travail. Le vrai commit est en dessous. */
export const WIP_SUBJECT = /^wip\(job #\d+\)/;

/** Profondeur maximale de la remontée : un historique dont chaque parent est encore un `wip` (ou qui se
 *  referme sur lui-même) doit rendre un verdict. */
const MAX_DEPTH = 4;

/** Marge contre une horloge un peu décalée (merge de l'hébergeur, commit d'une autre machine). */
const COMMIT_CLOCK_SLACK_MS = 60_000;

/**
 * Les fichiers touchés par `rev`, hors `scratch`. Rend `null` si git n'a pas su répondre, à distinguer
 * d'une liste vide, qui est une réponse : sans ça, une commande en échec se lirait « rien à signaler » et
 * ferait taire le filet exactement quand il ne voit plus rien.
 */
function filesOutsideScratch(rev: string, git: GitRunner): string[] | null {
  const out = git(["show", "--name-only", "--format=", "--first-parent", rev]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !f.startsWith("scratch"))
    .filter((f) => !isGitlink(rev, f, git));
}

/**
 * `f` est-il, dans `rev`, un lien vers un dépôt imbriqué (mode 160000) ? Un job qui clone un dépôt tiers dans
 * son worktree n'en laisse dans l'instantané qu'un POINTEUR vers un commit d'un autre dépôt, dont aucun objet
 * n'est ici : le compter comme « travail qui ne vit que là » ferait lister le job en travail garé, avec la
 * consigne de fusionner, alors que fusionner n'apporterait qu'un pointeur vide. Git muet : pas un lien (on
 * reste du côté qui crie).
 */
function isGitlink(rev: string, f: string, git: GitRunner): boolean {
  return git(["ls-tree", rev, "--", f])?.startsWith("160000 ") ?? false;
}

/** Au moins un blob de `tip` est-il byte-identique dans `branch` ? La preuve positive. */
function blobProof(tip: string, git: GitRunner, branch: string): boolean {
  for (const f of filesOutsideScratch(tip, git) ?? []) {
    const inJob = git(["rev-parse", `${tip}:${f}`]);
    if (!inJob) continue;
    if (inJob === git(["rev-parse", `${branch}:${f}`])) return true;
  }
  return false;
}

/** Ce qu'on sait du point de départ du job : sert à rejeter un commit qu'il n'a pas pu écrire. */
export interface JobProvenance {
  /** Epoch ms de création du job. */
  createdAt?: number | null;
  /** Sha du commit d'où le worktree est parti la première fois. */
  baseSha?: string | null;
}

/** `landed` : preuve positive dans `branch`. `unlanded` : du travail du job, non retrouvé (ou preuve
 *  absente : on crie). `nothing-committed` : le commit de tête existait avant le job. */
export type JobWorkVerdict = "landed" | "unlanded" | "nothing-committed";

/** `rev` existait-il avant le job ? Rend `false` dès qu'un témoin manque ou que git se tait. */
function predatesJob(rev: string, git: GitRunner, p: JobProvenance): boolean {
  const base = p.baseSha?.trim();
  if (base) {
    if (base.startsWith(rev) || rev.startsWith(base)) return true;
    if (git(["merge-base", "--is-ancestor", rev, base]) !== null) return true;
  }
  if (p.createdAt) {
    const ct = Number(git(["log", "-1", "--format=%ct", rev]));
    if (Number.isFinite(ct) && ct > 0 && ct * 1000 < p.createdAt - COMMIT_CLOCK_SLACK_MS) return true;
  }
  return false;
}

/**
 * Le travail référencé par `wipRef` (`job-<id>-wip@<sha>`) est-il dans `branch` ?
 *
 * Rend `unlanded`, jamais une exception, quand la preuve manque : pas de référence, sha inconnu, git muet,
 * aucun blob retrouvé. La remontée traverse les commits `wip(job #N)` (des instantanés, pas du travail) mais
 * **lit ce qu'ils portent** avant de passer. Le premier commit propre n'est jugé que s'il est du job.
 */
export function jobWorkVerdict(
  wipRef: string | null | undefined,
  git: GitRunner,
  provenance: JobProvenance = {},
  branch = "main",
): JobWorkVerdict {
  const sha = (wipRef ?? "").split("@")[1]?.trim();
  if (!sha) return "unlanded";

  let cur: string | null = sha;
  for (let i = 0; i < MAX_DEPTH && cur; i++) {
    const subject = git(["log", "-1", "--format=%s", cur]);
    if (subject === null) return "unlanded";
    if (!WIP_SUBJECT.test(subject)) {
      if (predatesJob(cur, git, provenance)) return "nothing-committed";
      // `--is-ancestor` sort 0 si oui : le runner rend `""` (succès sans sortie) et `null` sinon.
      // Suffisante, jamais nécessaire : le rebase et le squash-merge la mettent en défaut, d'où le repli sur le blob.
      if (git(["merge-base", "--is-ancestor", cur, branch]) !== null) return "landed";
      return blobProof(cur, git, branch) ? "landed" : "unlanded";
    }
    const carried = filesOutsideScratch(cur, git);
    if (carried === null || carried.length > 0) return "unlanded";
    cur = git(["log", "-1", "--format=%P", cur])?.split(" ")[0]?.trim() || null;
  }
  return "unlanded";
}

/** `jobWorkVerdict(...) === "landed"` : la question binaire que posent la plupart des appelants. */
export function jobWorkLanded(
  wipRef: string | null | undefined,
  git: GitRunner,
  branch = "main",
  provenance: JobProvenance = {},
): boolean {
  return jobWorkVerdict(wipRef, git, provenance, branch) === "landed";
}
