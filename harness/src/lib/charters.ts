/**
 * charters — les chartes et la nomenclature d'un registre d'agents spécialisés.
 *
 * Idée : derrière l'agent principal, des agents spécialisés (un trieur de tickets, un relecteur, un gardien
 * de l'infrastructure…) ne sont pas du code mais une CHARTE : un fichier court qui dit qui ils sont, ce
 * qu'ils ont le droit de faire, quel moteur les exécute, quelles données ils peuvent lire. Deux sources, et
 * seulement deux :
 *  - `nomenclature.json` : le SEUL endroit où un nom affiché est écrit (renommer = changer une ligne) ;
 *  - `chartes/<id>.md` : une charte par agent ou service, frontmatter + sections `## Mission`,
 *    `## Ce qui reste à écrire`, `## Leçons`.
 *
 * Le validateur porte des garde-fous DÉCLARATIFS (« aucun garde-fou en prose seule ») :
 *  - la sensibilité de la donnée suit le moteur : une charte sensible ne peut pas déclarer un moteur externe
 *    (qui sort les données du périmètre maîtrisé) ;
 *  - un gardien ne s'éteint pas en silence : il observe au moins ;
 *  - un rattachement désigne une entité connue ; un organe (fichier de code) cité doit exister ;
 *  - un agent pas encore actif doit dire à quelle marche (étape de déploiement) il naît ;
 *  - une charte sans entrée de nomenclature, ou un agent sans charte, est une erreur.
 * Un organigramme publiable (`buildOrgChart`) est GÉNÉRÉ d'ici ; un test de ton dépôt peut échouer s'il
 * dérive des chartes.
 *
 * Zéro dépendance : le frontmatter est un sous-ensemble volontairement étroit (clé: valeur, et listes
 * `[a, b]` sans virgule dans les éléments). Ce qui sort du format est une erreur, pas une interprétation.
 * Le vocabulaire (statuts, droits, moteurs…) est un paramètre : les défauts ci-dessous sont un point de départ.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Vocabulary {
  types: readonly string[];
  statuses: readonly string[];
  /** droits, du plus faible au plus fort : observer < reversible < proposer */
  rights: readonly string[];
  engines: readonly string[];
  /** moteurs qui sortent les données du périmètre maîtrisé : interdits hors sensibilité `generic` */
  externalEngines: readonly string[];
  sensitivities: readonly string[];
  /** la dernière marche (étape) du déploiement progressif */
  maxStep: number;
}

export const DEFAULT_VOCABULARY: Vocabulary = {
  types: ["agent", "service", "processus", "lieu"],
  statuses: ["actif", "louveteau", "a-naitre"],
  rights: ["observer", "reversible", "proposer"],
  engines: ["claude", "local", "externe", "aucun"],
  externalEngines: ["externe"],
  sensitivities: ["generic", "perso", "secu", "tiers"],
  maxStep: 7,
};

export interface NameEntry {
  nom: string;
  type: string;
  role: string;
}

export interface Nomenclature {
  entites: Record<string, NameEntry>;
}

export interface Charter {
  id: string;
  statut: string;
  marche: number | null;
  gardien: boolean;
  droits: string[];
  moteur: string;
  sensibilite: string;
  rattachement: string | null;
  organes: string[];
  declencheurs: string[];
  mission: string;
  delta: string;
  /** Les puces de « ## Leçons » : ce que le rêve a monté du carnet. Injectées à chaque réveil. */
  lecons: string[];
}

/** Les puces d'une section : une ligne `- …` et ses lignes de suite indentées font une puce. PUR. */
export function bulletsOf(text: string): string[] {
  const r: string[] = [];
  for (const l of text.split("\n")) {
    if (/^- /.test(l)) r.push(l.slice(2).trim());
    else if (/^\s+\S/.test(l) && r.length) r[r.length - 1] += ` ${l.trim()}`;
  }
  return r.filter(Boolean);
}

/** Lit un frontmatter étroit. PUR. Lève sur toute ligne hors format. */
export function parseCharter(text: string, file = "?"): Charter {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${file} : frontmatter absent`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`${file} : ligne hors format « ${line} »`);
    const key = line.slice(0, i).trim();
    if (key in fields) throw new Error(`${file} : clé en double « ${key} »`);
    fields[key] = line.slice(i + 1).trim();
  }
  const list = (key: string): string[] => {
    const v = fields[key];
    if (v === undefined) return [];
    if (!v.startsWith("[") || !v.endsWith("]")) throw new Error(`${file} : « ${key} » doit être une liste [a, b]`);
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((s) => s.trim()).filter(Boolean) : [];
  };
  const required = (key: string): string => {
    const v = fields[key];
    if (!v) throw new Error(`${file} : champ « ${key} » manquant`);
    return v;
  };
  const body = m[2];
  const section = (title: string): string => {
    const r = new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
    return r ? r[1].trim() : "";
  };
  let marche: number | null = null;
  if (fields.marche !== undefined) {
    if (!/^\d+$/.test(fields.marche)) throw new Error(`${file} : « marche » doit être un entier`);
    marche = Number(fields.marche);
  }
  const guardian = fields.gardien ?? "non";
  if (guardian !== "oui" && guardian !== "non") throw new Error(`${file} : « gardien » vaut oui ou non`);
  return {
    id: required("id"),
    statut: required("statut"),
    marche,
    gardien: guardian === "oui",
    droits: list("droits"),
    moteur: required("moteur"),
    sensibilite: required("sensibilite"),
    rattachement: fields.rattachement || null,
    organes: list("organes"),
    declencheurs: list("declencheurs"),
    mission: section("Mission"),
    delta: section("Ce qui reste à écrire"),
    lecons: bulletsOf(section("Leçons")),
  };
}

/**
 * Les erreurs d'un ensemble nomenclature + chartes. PUR sauf `exists` (injecté, pour les tests).
 * Liste vide = valide. `rootId` : une entité exemptée de « doit dire à quelle marche elle naît » (le chef d'orchestre).
 */
export function validate(
  nomenclature: Nomenclature,
  charters: Charter[],
  opts: { vocabulary?: Vocabulary; exists?: (path: string) => boolean; rootId?: string } = {},
): string[] {
  const v = opts.vocabulary ?? DEFAULT_VOCABULARY;
  const exists = opts.exists ?? (() => true);
  const errors: string[] = [];
  const names = nomenclature.entites;
  const ids = new Set(Object.keys(names));
  const byId = new Map(charters.map((c) => [c.id, c]));

  for (const [id, e] of Object.entries(names)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`nomenclature : identifiant invalide « ${id} »`);
    if (!e.nom?.trim()) errors.push(`nomenclature : « ${id} » sans nom`);
    if (!v.types.includes(e.type)) errors.push(`nomenclature : « ${id} » type inconnu « ${e.type} »`);
    if ((e.type === "agent" || e.type === "service") && !byId.has(id)) errors.push(`« ${id} » est un ${e.type} sans charte (chartes/${id}.md)`);
  }

  for (const c of charters) {
    const where = `charte « ${c.id} »`;
    if (!ids.has(c.id)) errors.push(`${where} : absente de la nomenclature`);
    else if (names[c.id].type !== "agent" && names[c.id].type !== "service") errors.push(`${where} : une charte est réservée aux agents et services`);
    if (!v.statuses.includes(c.statut)) errors.push(`${where} : statut inconnu « ${c.statut} »`);
    if (!v.engines.includes(c.moteur)) errors.push(`${where} : moteur inconnu « ${c.moteur} »`);
    if (!v.sensitivities.includes(c.sensibilite)) errors.push(`${where} : sensibilité inconnue « ${c.sensibilite} »`);
    for (const d of c.droits) if (!v.rights.includes(d)) errors.push(`${where} : droit inconnu « ${d} »`);
    if (c.droits.length === 0) errors.push(`${where} : aucun droit déclaré`);
    if (c.marche !== null && (c.marche < 0 || c.marche > v.maxStep)) errors.push(`${where} : marche hors 0..${v.maxStep}`);
    if (c.statut !== "actif" && c.marche === null && c.id !== opts.rootId) {
      errors.push(`${where} : un agent pas encore actif doit dire à quelle marche il naît`);
    }
    // Le moteur suit la sensibilité de la donnée, par le code.
    if (c.sensibilite !== "generic" && v.externalEngines.includes(c.moteur)) {
      errors.push(`${where} : sensibilité « ${c.sensibilite} » interdit le moteur « ${c.moteur} »`);
    }
    // Un gardien ne s'éteint pas en silence ; il observe au moins.
    if (c.gardien && !c.droits.includes("observer")) errors.push(`${where} : un gardien doit au moins observer`);
    if (c.rattachement !== null && !ids.has(c.rattachement)) errors.push(`${where} : rattachement inconnu « ${c.rattachement} »`);
    if (c.rattachement === c.id) errors.push(`${where} : rattaché à lui-même`);
    for (const o of c.organes) if (!exists(o)) errors.push(`${where} : organe introuvable « ${o} »`);
    if (!c.mission) errors.push(`${where} : section « Mission » vide`);
  }
  return errors;
}

export interface OrgEntity extends NameEntry {
  id: string;
  statut: string | null;
  marche: number | null;
  gardien: boolean;
  droits: string[];
  moteur: string | null;
  sensibilite: string | null;
  rattachement: string | null;
  organes: string[];
  declencheurs: string[];
  mission: string;
  delta: string;
}

export interface OrgChart {
  version: 1;
  source: string;
  entites: OrgEntity[];
}

/** L'organigramme publié : une entité par nom, enrichie de sa charte si elle en a une. PUR. */
export function buildOrgChart(nomenclature: Nomenclature, charters: Charter[], source = "nomenclature.json + chartes/*.md"): OrgChart {
  const byId = new Map(charters.map((c) => [c.id, c]));
  const entites: OrgEntity[] = Object.entries(nomenclature.entites).map(([id, e]) => {
    const c = byId.get(id);
    return {
      id, nom: e.nom, type: e.type, role: e.role,
      statut: c?.statut ?? null, marche: c?.marche ?? null, gardien: c?.gardien ?? false,
      droits: c?.droits ?? [], moteur: c?.moteur ?? null, sensibilite: c?.sensibilite ?? null,
      rattachement: c?.rattachement ?? null, organes: c?.organes ?? [], declencheurs: c?.declencheurs ?? [],
      mission: c?.mission ?? "", delta: c?.delta ?? "",
    };
  });
  return { version: 1, source, entites };
}

/** Charge nomenclature et chartes depuis `dir` (contenant `nomenclature.json` et `chartes/`). */
export function loadRegistry(dir: string): { nomenclature: Nomenclature; charters: Charter[] } {
  const nomenclature = JSON.parse(readFileSync(join(dir, "nomenclature.json"), "utf8")) as Nomenclature;
  const chartersDir = join(dir, "chartes");
  const charters = readdirSync(chartersDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const c = parseCharter(readFileSync(join(chartersDir, f), "utf8"), f);
      if (`${c.id}.md` !== f) throw new Error(`${f} : l'id « ${c.id} » ne correspond pas au nom du fichier`);
      return c;
    });
  return { nomenclature, charters };
}

/** `exists` réel, relatif à la racine du dépôt. */
export function existsFrom(root: string): (path: string) => boolean {
  return (path) => existsSync(join(root, path));
}

/** Sérialisation stable (le fichier versionné se compare octet pour octet). */
export function serializeOrgChart(o: OrgChart): string {
  return `${JSON.stringify(o, null, 2)}\n`;
}
