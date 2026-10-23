/**
 * merge-gate — le NOYAU PUR d'un verrou de fusion : « cette PR peut-elle être fusionnée maintenant ? »
 *
 * Quand un agent fusionne ses propres PR, la fusion est le dernier geste avant que le code tourne. Ce
 * module ne fait aucune I/O (ni GitHub, ni git, ni base) : tu lui passes le dossier de la PR, il rend
 * `{ ok, raison, ... }`. Ton hook (PreToolUse sur l'outil de fusion, ou sur `gh pr merge`) rassemble le
 * dossier et applique la décision. ÉCHEC FERMÉ partout : une information absente vaut refus.
 *
 * Ce que le verrou exige, dans l'ordre :
 *  1. un dossier qui porte sur CETTE PR et sur la tête EXACTE (même sha, ou préfixe l'un de l'autre) :
 *     un dossier d'une tête précédente ne prouve rien sur le code d'aujourd'hui ;
 *  2. une relecture adverse (un second modèle/agent qui ne l'a pas écrit) dont le verdict est « ok » —
 *     « ok sous réserve » n'ouvre jamais le verrou sans arbitrage explicite (`arbitrage: true`) ;
 *  3. des tests verts sur cette tête, si le dépôt a une suite (`testsRequis`) ; « pas de suite » est un
 *     fait constaté (`tests: null` ET `testsRequis` faux), jamais une valeur par défaut ;
 *  4. l'accord HUMAIN (`approuve`) quand la PR touche un chemin sensible. Deux niveaux :
 *     - `dur` : toujours l'accord humain (ce qui décide d'une autorisation, d'un secret, d'une dépense) ;
 *     - `souple` : permis sans lui si le relecteur CERTIFIE « serrures : aucune » (rien de ce qui décide
 *       d'une autorisation n'est touché), ou « touchées » dans un sens qui ne desserre rien
 *       (`restreint` / `neutre`) AVEC une preuve citée. Une déclaration absente, illisible, « touchées »
 *       sans preuve ou qui ÉLARGIT vaut accord humain.
 *     Un dépôt qui PUBLIE (`depotPublic`) exige l'accord humain quels que soient les chemins : fusionner =
 *     mettre en ligne.
 *
 * L'accord humain n'est pas lu ici : `approuve` vient de `approval-gate.ts` (`checkApprovalGate` sur
 * l'empreinte de `mergeActText(...)`). Le texte de l'acte inclut le sha de tête : un push après l'accord
 * change l'acte, donc exige un nouvel accord.
 */

/** Un motif de chemin (`**`, `*`) en expression régulière ancrée. PUR. */
export function globToRegex(motif: string): RegExp {
  const m = motif.trim();
  let re = "";
  for (let i = 0; i < m.length; i++) {
    if (m.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (m.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (m[i] === "*") re += "[^/]*";
    else re += m[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface Niveaux {
  dur: string[];
  souple: string[];
}

/**
 * Les motifs d'un fichier de chemins sensibles, par niveau (commentaires `#` et lignes vides ignorés).
 * Les en-têtes `[dur]` / `[souple]` changent de niveau pour ce qui suit. Avant tout en-tête, c'est `dur` ;
 * un en-tête inconnu vaut `dur` aussi (échec fermé). PUR.
 */
export function lireNiveaux(texte: string): Niveaux {
  const res: Niveaux = { dur: [], souple: [] };
  let niveau: "dur" | "souple" = "dur";
  for (const brut of texte.split("\n")) {
    const l = brut.trim();
    if (!l || l.startsWith("#")) continue;
    const entete = /^\[([^\]]*)\]$/.exec(l);
    if (entete) {
      niveau = entete[1].trim().toLowerCase() === "souple" ? "souple" : "dur";
      continue;
    }
    res[niveau].push(l);
  }
  return res;
}

/** Les fichiers qui répondent à au moins un motif. PUR. */
export function fichiersSensibles(fichiers: readonly string[], motifs: readonly string[]): string[] {
  const res = motifs.map(globToRegex);
  return fichiers.filter((f) => res.some((r) => r.test(f)));
}

/** Les fichiers d'une PR par niveau. Un fichier qui répond aux deux niveaux est `dur`. PUR. */
export function classerFichiers(fichiers: readonly string[], niveaux: Niveaux): { dur: string[]; souples: string[] } {
  const dur = fichiersSensibles(fichiers, niveaux.dur);
  const souples = fichiersSensibles(fichiers, niveaux.souple).filter((f) => !dur.includes(f));
  return { dur, souples };
}

/** Ce que le relecteur a déclaré des serrures : `aucune`, `touchees`, ou null (absent / illisible). */
export type Serrures = "aucune" | "touchees" | null;
/** Le SENS d'une serrure touchée : `elargit` (une permission, un secret, une dépense, une publication
 *  gagnent du terrain), `restreint` (ils en perdent), `neutre` (même périmètre). */
export type SensSerrures = "elargit" | "restreint" | "neutre";

export type VerdictRelecture = "ok" | "ok-sous-reserve" | "corriger" | "bloquer";

export interface DossierFusion {
  depot: string;
  pr: number;
  /** La tête relue et testée. */
  sha: string;
  /** null = personne n'a relu. */
  relecture: { verdict: VerdictRelecture; points: string[] } | null;
  serrures?: Serrures;
  serruresSens?: SensSerrures;
  /** La ligne du diff citée en preuve d'un sens `restreint` / `neutre`. */
  serruresPreuve?: string;
  /** null = AUCUNE suite connue pour ce dépôt (constaté, pas supposé) ; une suite non lancée ou illisible = ok:false. */
  tests: { ok: boolean; resume: string } | null;
  /** Vrai quand le dépôt a une suite connue : alors `tests: null` vaut refus. */
  testsRequis?: boolean;
}

/**
 * Le sens retenu d'un dossier : `restreint` / `neutre` seulement si les serrures sont « touchées » avec ce
 * sens ET une preuve ; tout le reste vaut `elargit` (échec fermé). Null si les serrures ne sont pas
 * « touchées ». PUR.
 */
export function sensDuDossier(d: Pick<DossierFusion, "serrures" | "serruresSens" | "serruresPreuve"> | null | undefined): SensSerrures | null {
  if (d?.serrures !== "touchees") return null;
  if ((d.serruresSens === "restreint" || d.serruresSens === "neutre") && typeof d.serruresPreuve === "string" && d.serruresPreuve.trim()) return d.serruresSens;
  return "elargit";
}

/** Une preuve de sens n'est valable que si c'est une ligne ENTIÈRE ajoutée ou retirée du diff relu (préfixe `+` ou
 *  `-` compris, en-têtes `+++` / `---` exclus, espaces de bord ignorés, 12 caractères utiles au moins). Une sous-chaîne,
 *  une ligne de contexte ou un en-tête ne valent rien : le sens retombe à `elargit`. PUR. */
export function verifierPreuveSerrures<T extends { serrures: Serrures; serruresSens?: SensSerrures; serruresPreuve?: string }>(v: T, diff: string): T {
  if (v.serrures !== "touchees" || (v.serruresSens !== "restreint" && v.serruresSens !== "neutre")) return v;
  const m = /^([+-])\s*(.*)$/.exec((v.serruresPreuve ?? "").trim());
  const utile = m ? m[2].trim() : "";
  const lignes = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l));
  const trouve = !!m && utile.length >= 12 && lignes.some((l) => l[0] === m[1] && l.slice(1).trim() === utile);
  return trouve ? v : { ...v, serruresSens: "elargit" };
}

/** Deux sha désignent la même tête si l'un est le préfixe de l'autre (court contre long). Vide = jamais. */
export function memeTete(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** L'acte exact que l'accord humain valide pour une fusion. Le sha de tête y figure. PUR. */
export function mergeActText(depot: string, pr: number, sha: string, sensibles: readonly string[]): string {
  return `merge ${depot.toLowerCase()}#${pr} at ${sha.slice(0, 12)} (sensitive paths: ${sensibles.join(", ")})`;
}

function liste(xs: readonly string[]): string {
  return xs.length > 3 ? `${xs.slice(0, 3).join(", ")} +${xs.length - 3}` : xs.join(", ");
}

/** La queue d'un refus : « — chemins sensibles : dur … / souple … » ou « aucun ». Elle dit d'emblée si un
 *  accord humain est en jeu (voir `guard-journal.tronquerRaison`, qui la garde entière). PUR. */
export function queueChemins(dur: readonly string[], souples: readonly string[]): string {
  const parts = [dur.length ? `dur ${liste(dur)}` : "", souples.length ? `souple ${liste(souples)}` : ""].filter(Boolean);
  return ` — chemins sensibles : ${parts.length ? parts.join(" / ") : "aucun"}`;
}

export interface EntreeFusion {
  depot: string;
  pr: number;
  /** La tête que la fusion va introduire (celle que l'appel vise). */
  sha: string;
  fichiers: readonly string[];
  niveaux: Niveaux;
  dossier: DossierFusion | null;
  /** L'accord humain sur l'acte `mergeActText` est valide (cf. `approval-gate.ts`). */
  approuve: boolean;
  /** Un arbitrage humain explicite autorise de passer outre un verdict « ok sous réserve ». */
  arbitrage?: boolean;
  /** Le dépôt publie ce qu'il contient (pages, package, site) : toute fusion y est une mise en ligne. */
  depotPublic?: boolean;
  /** Le nom de la commande qui prépare un dossier (relecture + tests), citée dans les refus. */
  commandePreparer?: string;
}

export interface DecisionFusion {
  ok: boolean;
  raison: string;
  /** Les chemins pour lesquels l'accord humain est EXIGÉ (vide quand la fusion s'en passe). */
  sensibles: string[];
  /** Les chemins souples laissés passer SANS accord (à signaler dans un rapport). */
  souples: string[];
  serrures: Serrures;
}

/** La décision du verrou de fusion. PUR. Échec fermé. */
export function decisionFusion(o: EntreeFusion): DecisionFusion {
  const { dur, souples } = classerFichiers(o.fichiers, o.niveaux);
  const d = o.dossier;
  const serrures: Serrures = d?.serrures === "aucune" || d?.serrures === "touchees" ? d.serrures : null;
  const sens = sensDuDossier(d);
  const dispense = serrures === "aucune" || (serrures === "touchees" && (sens === "restreint" || sens === "neutre"));
  const parSouple = dur.length === 0 && souples.length > 0 && !dispense;
  const parPublication = o.depotPublic === true;
  const exige = dur.length > 0 || parSouple || parPublication;
  // L'acte couvre les chemins durs ET les souples qui les accompagnent ; sur un dépôt qui publie, TOUS les fichiers.
  const sensibles = parPublication ? [...o.fichiers] : dur.length ? [...dur, ...souples] : exige ? souples : [];
  const sansAccord = !exige ? souples : [];
  const prepare = o.commandePreparer ?? "prépare un dossier (relecture adverse + tests) pour cette tête";
  const refus = (raison: string): DecisionFusion => ({
    ok: false,
    raison: `${raison}${queueChemins(dur, souples)}`,
    sensibles: dur.length ? [...dur, ...souples] : souples,
    souples: [],
    serrures,
  });

  if (!d) return refus(`pas de dossier de fusion pour ${o.depot}#${o.pr} : ${prepare}.`);
  if (d.depot.toLowerCase() !== o.depot.toLowerCase() || d.pr !== o.pr)
    return refus(`le dossier trouvé est celui de ${d.depot}#${d.pr}, pas de ${o.depot}#${o.pr} : ${prepare}.`);
  if (!memeTete(d.sha, o.sha)) return refus(`le dossier porte sur une autre tête (${d.sha.slice(0, 12)}) que celle visée (${o.sha.slice(0, 12)}) : ${prepare}.`);
  if (!d.relecture) return refus(`personne n'a relu cette PR : ${prepare}.`);
  const v = d.relecture.verdict;
  if (v === "ok-sous-reserve" && !o.arbitrage) {
    return refus(`la relecture a rendu « ok sous réserve » : le verrou refuse sans arbitrage humain explicite. Points : ${d.relecture.points.slice(0, 3).join(" ; ")}.`);
  }
  if (v !== "ok" && v !== "ok-sous-reserve") {
    return refus(`la relecture a rendu « ${v} » : ${d.relecture.points.slice(0, 3).join(" ; ")}. Corrige, pousse, relance : ${prepare}.`);
  }
  if (!d.tests && d.testsRequis) return refus(`ce dépôt a une suite de tests et elle n'a pas tourné sur cette tête : ${prepare}.`);
  if (d.tests && !d.tests.ok) return refus(`les tests ont échoué sur la tête de la PR : ${d.tests.resume}.`);
  if (exige && !o.approuve) {
    const pourquoi = dur.length
      ? `cette PR touche des chemins qui ne se fusionnent jamais sans l'accord humain (${dur.join(", ")})${souples.length ? `, et des chemins souples que cet accord couvre aussi (${souples.join(", ")})` : ""}`
      : parPublication
        ? `cette PR vise ${o.depot}, qui publie ce qu'il contient : la fusionner met en ligne, l'accord humain est exigé quels que soient les chemins`
        : `cette PR ne touche que des chemins souples (${souples.join(", ")}) mais le relecteur n'a pas certifié « serrures : aucune » ni une serrure touchée qui restreint (${serrures === "touchees" ? "serrures touchées qui ÉLARGISSENT, ou sans preuve lue dans le diff" : "déclaration absente ou illisible"})`;
    return {
      ok: false,
      sensibles,
      souples: [],
      serrures,
      raison: `${pourquoi}. Demande l'accord humain sur l'acte ci-dessous, tel quel, puis relance la même fusion.\n--- acte ---\n${mergeActText(o.depot, o.pr, o.sha, sensibles)}\n--- fin ---`,
    };
  }
  const reserve = v === "ok-sous-reserve" ? " [ok sous réserve, arbitré]" : "";
  const testsTexte = d.tests ? "tests verts" : "tests non vérifiés (aucune suite)";
  const raison = exige
    ? `fusion autorisée par l'accord humain, ${testsTexte}${reserve}`
    : sansAccord.length
      ? `relecture ok, ${testsTexte}, chemins souples seulement (${sansAccord.join(", ")}), serrures ${serrures === "aucune" ? "aucune" : `touchées (${sens})`} : fusion sans accord humain${reserve}`
      : `relecture ok, ${testsTexte}, aucun chemin sensible${reserve}`;
  return { ok: true, sensibles, souples: sansAccord, serrures, raison };
}
