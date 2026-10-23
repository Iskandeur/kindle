/**
 * succession : le registre « ancien organe → successeur → extinction ».
 *
 * Le piège : quand tu construis un organe neuf (un capteur, une boucle périodique, un script, une règle), tu
 * oublies d'éteindre celui qu'il remplace. Une marche qui remplace sans éteindre ne se voit pas, elle se
 * paie : deux voix pour la même question, deux réveils pour le même geste. La règle : activer le successeur
 * et éteindre l'ancien partent dans la même PR ; un registre écrit la décision, et une sonde la rend
 * vérifiable (chaque organe porte la commande qui dit s'il tourne). Un capteur sonne quand l'ancien et le
 * nouveau tournent ensemble.
 *
 * Quatre statuts, et ce que la vérification en fait :
 *  - `coexistence` : les deux restent, c'est voulu (la raison le dit, la condition de bascule aussi s'il y en a
 *    une), jamais une alarme ;
 *  - `a-trancher` : doublon constaté, décision à ton humain : signalé tant que les deux tournent, jamais une alarme ;
 *  - `a-eteindre` : décidé, **alarme** tant que l'ancien tourne (échéance dépassée dite en plus) ;
 *  - `eteint` : fait, **alarme** si l'ancien tourne encore (une régression : un réveil recréé, un runner rebranché).
 *
 * Une sonde qui ne peut pas conclure (`aucune`, ou lecture cassée) rend « non vérifiable », jamais « éteint » :
 * un instrument muet ne doit pas pouvoir passer pour une extinction faite. Et une extinction exige une sonde sur
 * l'ancien, sinon elle ne sonnerait jamais.
 *
 * Logique PURE. Les sondes qui touchent ton monde (une table de réveils, une liste de boucles, un service)
 * sont les tiennes : tu produis une `Observation` et tu la donnes à `juger`. Ce module fournit le type de
 * sonde `fichier` (observer un fichier lu par toi) et le type `custom` (un nom de sonde que ton code résout).
 */

export const STATUTS = ["coexistence", "a-trancher", "a-eteindre", "eteint"] as const;
export type Statut = (typeof STATUTS)[number];

/** Comment savoir si un organe tourne. */
export type SondeSuccession =
  /** Un fichier du dépôt (relatif à la racine) présent, et qui contient le motif s'il est donné. */
  | { type: "fichier"; chemin: string; motif?: string }
  /** Une sonde que TON code sait résoudre (réveil en attente, boucle câblée, service actif…), désignée par un nom. */
  | { type: "custom"; nom: string; argument?: string }
  /** Rien à sonder (outil manuel, successeur pas encore construit) : la raison le dit. */
  | { type: "aucune"; raison: string };

export interface Organe {
  nom: string;
  sonde: SondeSuccession;
}

export interface EntreeSuccession {
  id: string;
  ancien: Organe;
  successeur: Organe;
  statut: Statut;
  /** Constat ou décision (AAAA-MM-JJ) ; pour `a-eteindre`, l'échéance d'extinction. */
  date: string;
  raison: string;
  /** Ce qui a été vérifié pour poser le statut (fichier:ligne, mesure). */
  preuve: string;
  /** Pour `coexistence` : ce qui ferait basculer en `a-eteindre`. */
  bascule?: string;
  /** Pour `a-trancher` : la décision proposée. */
  proposition?: string;
}

export interface Registre {
  entrees: EntreeSuccession[];
}

/** Ce que la sonde a vu : `tourne: null` = non vérifiable. */
export interface Observation {
  tourne: boolean | null;
  preuve: string;
}

/** Les erreurs de forme du registre (vide = valide). PUR. */
export function validerRegistre(r: unknown): string[] {
  const erreurs: string[] = [];
  const entrees = (r as Registre | null)?.entrees;
  if (!Array.isArray(entrees)) return ["le registre n'a pas de tableau « entrees »"];
  const vus = new Set<string>();
  const sondeOk = (s: unknown): boolean => {
    const o = s as Record<string, unknown> | null;
    if (!o || typeof o.type !== "string") return false;
    if (o.type === "fichier") return typeof o.chemin === "string" && o.chemin.length > 0 && (o.motif === undefined || typeof o.motif === "string");
    if (o.type === "custom") return typeof o.nom === "string" && o.nom.length > 0 && (o.argument === undefined || typeof o.argument === "string");
    if (o.type === "aucune") return typeof o.raison === "string" && o.raison.length > 0;
    return false;
  };
  for (const [n, e] of entrees.entries()) {
    const ou = `entrée ${n + 1}${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    if (typeof e?.id !== "string" || !e.id) erreurs.push(`${ou} : id manquant`);
    else if (vus.has(e.id)) erreurs.push(`${ou} : id en double`);
    else vus.add(e.id);
    if (!STATUTS.includes(e?.statut)) erreurs.push(`${ou} : statut inconnu « ${String(e?.statut)} » (${STATUTS.join(", ")})`);
    if (typeof e?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(Date.parse(e.date))) erreurs.push(`${ou} : date AAAA-MM-JJ attendue`);
    for (const champ of ["raison", "preuve"] as const) if (typeof e?.[champ] !== "string" || !e[champ]) erreurs.push(`${ou} : ${champ} manquante`);
    for (const cote of ["ancien", "successeur"] as const) {
      if (typeof e?.[cote]?.nom !== "string" || !e[cote].nom) erreurs.push(`${ou} : ${cote}.nom manquant`);
      if (!sondeOk(e?.[cote]?.sonde)) erreurs.push(`${ou} : ${cote}.sonde invalide`);
    }
    if (e?.statut === "a-trancher" && !e.proposition) erreurs.push(`${ou} : un doublon à trancher porte sa proposition`);
    // Une extinction qu'aucune sonde ne peut constater ne sonnerait jamais : « non vérifiable » pour toujours.
    if ((e?.statut === "a-eteindre" || e?.statut === "eteint") && e.ancien?.sonde?.type === "aucune") erreurs.push(`${ou} : une extinction exige une sonde sur l'ancien`);
  }
  return erreurs;
}

export type Niveau = "alarme" | "doublon" | "inconnu" | "ok";

export interface Verdict {
  entree: EntreeSuccession;
  niveau: Niveau;
  texte: string;
}

/** Le verdict d'une entrée, vu ce que les sondes disent. `aujourdhui` en AAAA-MM-JJ. PUR. */
export function juger(e: EntreeSuccession, ancien: Observation, successeur: Observation, aujourdhui: string): Verdict {
  const v = (niveau: Niveau, texte: string): Verdict => ({ entree: e, niveau, texte });
  const ensemble = successeur.tourne === true ? ", en même temps que son successeur" : "";
  if (e.statut === "eteint") {
    if (ancien.tourne === true) return v("alarme", `éteint le ${e.date}, mais l'ancien tourne encore${ensemble} (${ancien.preuve})`);
    if (ancien.tourne === null) return v("inconnu", `éteint le ${e.date}, non vérifiable (${ancien.preuve})`);
    return v("ok", `éteint (${ancien.preuve})`);
  }
  if (e.statut === "a-eteindre") {
    const echu = e.date < aujourdhui ? `, échéance du ${e.date} dépassée` : `, échéance ${e.date}`;
    if (ancien.tourne === true) return v("alarme", `à éteindre : l'ancien tourne encore${ensemble}${echu} (${ancien.preuve})`);
    if (ancien.tourne === null) return v("inconnu", `à éteindre, non vérifiable (${ancien.preuve})`);
    return v("ok", `l'ancien ne tourne plus : passer l'entrée en « eteint » (${ancien.preuve})`);
  }
  if (e.statut === "a-trancher") {
    if (ancien.tourne === true && successeur.tourne === true) return v("doublon", `doublon à trancher, les deux tournent (${ancien.preuve} ; ${successeur.preuve}) → proposé : ${e.proposition ?? "?"}`);
    if (ancien.tourne === null || successeur.tourne === null) return v("inconnu", `à trancher, non vérifiable (${ancien.preuve} ; ${successeur.preuve})`);
    return v("ok", `à trancher, mais un seul tourne (${ancien.tourne ? "l'ancien" : successeur.tourne ? "le successeur" : "aucun"})`);
  }
  return v("ok", `coexistence voulue${e.bascule ? ` · bascule : ${e.bascule}` : ""}`);
}

const SIGNE: Record<Niveau, string> = { alarme: "🔴", doublon: "🟠", inconnu: "?", ok: "✓" };
const ORDRE: Record<Niveau, number> = { alarme: 0, doublon: 1, inconnu: 2, ok: 3 };

export function formaterVerdict(v: Verdict): string {
  return `${SIGNE[v.niveau]} ${v.entree.ancien.nom} → ${v.entree.successeur.nom} : ${v.texte}`;
}

/** Le rendu complet, alarmes et doublons en tête. PUR. */
export function rapportSuccession(verdicts: readonly Verdict[]): string {
  const n = (x: Niveau) => verdicts.filter((v) => v.niveau === x).length;
  const tri = [...verdicts].sort((a, b) => ORDRE[a.niveau] - ORDRE[b.niveau]);
  return [`Successions : ${verdicts.length} entrées, ${n("alarme")} alarme(s), ${n("doublon")} doublon(s) à trancher, ${n("inconnu")} non vérifiable(s)`, ...tri.map(formaterVerdict)].join("\n");
}

/** Pour un bilan quotidien : les seules alarmes, ou « rien » (jamais une sortie vide). PUR. */
export function blocAlarmes(verdicts: readonly Verdict[]): string {
  const a = verdicts.filter((v) => v.niveau === "alarme");
  return a.length ? a.map(formaterVerdict).join("\n") : "rien";
}

/** Sonde `fichier` : présent, et contient le motif s'il est donné. PUR (`texte` null = absent). */
export function observerFichier(s: { chemin: string; motif?: string }, texte: string | null): Observation {
  if (texte === null) return { tourne: false, preuve: `${s.chemin} absent` };
  if (s.motif && !texte.includes(s.motif)) return { tourne: false, preuve: `${s.chemin} ne contient plus « ${s.motif} »` };
  return { tourne: true, preuve: `${s.chemin}${s.motif ? ` contient « ${s.motif} »` : " présent"}` };
}

/** Observation d'une sonde `aucune` : toujours non vérifiable, avec la raison. */
export function observerAucune(s: { raison: string }): Observation {
  return { tourne: null, preuve: `non sondé : ${s.raison}` };
}
