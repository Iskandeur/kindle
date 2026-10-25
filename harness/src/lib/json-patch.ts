/**
 * json-patch — patcher un JSON protégé (réglages, config d'outils) par une spec DÉCLARATIVE.
 *
 * Deux briques :
 *  - `applyPatch` (PUR) : applique `{set, appendUnique, unset}` à une copie d'un objet. Chemins pointés
 *    (`"mcpServers.search"`, `"permissions.allow"`). `set` écrit une valeur (crée les niveaux manquants) ;
 *    `appendUnique` pousse dans un tableau (le crée si absent) sans dupliquer une valeur déjà présente
 *    (comparaison structurelle, pas `===`) ; `unset` retire une clé (absente = rien à faire, jamais
 *    d'erreur : le patch reste idempotent).
 *  - `patchJsonFile` : le geste complet sur un fichier. DRY-RUN par défaut (montre avant/après, n'écrit
 *    rien) ; `apply` exige une autorisation (`authorize`, p. ex. `checkApprovalGate` d'`approval-gate.ts`)
 *    calculée sur l'EMPREINTE du patch ; sauvegarde horodatée AVANT d'écrire ; re-lecture + re-parse
 *    après coup, et restauration immédiate depuis la sauvegarde si le résultat n'est pas du JSON valide
 *    (jamais un fichier de config cassé, qui bloquerait le prochain démarrage).
 *
 * POURQUOI une spec déclarative et un fichier de spec séparé : le fichier protégé ne peut pas être
 * édité par l'outil d'édition de l'agent (anti-élévation de privilèges), mais l'écriture par une
 * commande reste possible. Plutôt que de laisser l'agent bricoler un `sed`, on lui donne UN geste
 * qui montre ce qu'il fera, demande l'accord de l'humain sur ce patch exact, puis l'applique une fois.
 */
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

export interface PatchSpec {
  set?: Record<string, unknown>;
  appendUnique?: Record<string, unknown[]>;
  /** Clés à retirer (chemins pointés). `set` ne sait qu'ajouter : il faut pouvoir ôter une entrée qui échoue. */
  unset?: string[];
}

function splitPath(path: string): string[] {
  const keys = path.split(".");
  if (keys.some((k) => k.length === 0)) throw new Error(`json-patch: chemin invalide "${path}"`);
  return keys;
}

/** Les clés qui ouvriraient la chaîne de prototypes : un patch ne les écrit jamais. */
function assertSafeKeys(keys: string[], path: string): void {
  if (keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) {
    throw new Error(`json-patch: chemin refusé "${path}"`);
  }
}

/** Navigue jusqu'au parent du dernier segment, créant les objets manquants en route. Mute `root`. */
function walkToParent(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Applique `patch` à une COPIE de `input` (jamais de mutation de l'original) et la renvoie. */
export function applyPatch(input: unknown, patch: PatchSpec): unknown {
  const clone = JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;

  for (const [path, value] of Object.entries(patch.set ?? {})) {
    const keys = splitPath(path);
    assertSafeKeys(keys, path);
    const parent = walkToParent(clone, keys);
    parent[keys[keys.length - 1]] = value;
  }

  for (const [path, values] of Object.entries(patch.appendUnique ?? {})) {
    const keys = splitPath(path);
    assertSafeKeys(keys, path);
    const parent = walkToParent(clone, keys);
    const lastKey = keys[keys.length - 1];
    if (!Array.isArray(parent[lastKey])) parent[lastKey] = [];
    const arr = parent[lastKey] as unknown[];
    for (const v of values) {
      if (!arr.some((existing) => sameValue(existing, v))) arr.push(v);
    }
  }

  for (const path of patch.unset ?? []) {
    const keys = splitPath(path);
    assertSafeKeys(keys, path);
    let cur: unknown = clone;
    for (const k of keys.slice(0, -1)) {
      cur = typeof cur === "object" && cur !== null && !Array.isArray(cur) ? (cur as Record<string, unknown>)[k] : undefined;
    }
    if (typeof cur === "object" && cur !== null && !Array.isArray(cur)) delete (cur as Record<string, unknown>)[keys[keys.length - 1]];
  }

  return clone;
}

/** Ce que rend une autorisation : `ok`, ou le refus avec sa raison. `release` annule l'effet (rend la
 *  demande réutilisable) si l'écriture échoue ensuite ; `commit` est appelé pour « consommer » la demande. */
export interface Authorization {
  ok: boolean;
  reason?: string;
  /** Appelé AVANT d'écrire, pour consommer l'approbation de façon atomique ; faux = déjà utilisée ailleurs. */
  consume?: () => boolean;
  /** Appelé si l'écriture a dû être annulée : l'acte n'a pas eu lieu, l'approbation redevient valable. */
  release?: () => void;
}

export interface PatchFileOptions {
  /** Écrit pour de vrai. Sinon : dry-run. */
  apply?: boolean;
  /** Obligatoire dès que `apply` est vrai. Reçoit le chemin ABSOLU résolu de la cible (pour l'empreinte). */
  authorize?: (targetAbsPath: string) => Authorization;
  now?: () => number;
}

export type PatchFileResult =
  | { status: "unchanged" }
  | { status: "dry-run"; before: string; after: string }
  | { status: "applied"; before: string; after: string; backup: string }
  | { status: "refused"; reason: string }
  | { status: "restored"; reason: string; backup: string }
  | { status: "error"; reason: string };

/**
 * Patch d'un fichier JSON. Ne lève pas sur les erreurs d'usage : elles reviennent dans le résultat.
 * L'autorisation passe AVANT toute écriture et avant d'annoncer quoi que ce soit en mode `apply` : un
 * refus ne doit pas ressembler à une application réussie dans un journal lu en diagonale.
 */
export function patchJsonFile(target: string, patch: PatchSpec, o: PatchFileOptions = {}): PatchFileResult {
  if (!existsSync(target)) return { status: "error", reason: `fichier cible introuvable : ${target}` };
  const before = readFileSync(target, "utf8");
  let beforeObj: unknown;
  try {
    beforeObj = JSON.parse(before);
  } catch (e) {
    return { status: "error", reason: `la cible n'est pas un JSON valide : ${(e as Error).message}` };
  }
  let after: string;
  try {
    after = JSON.stringify(applyPatch(beforeObj, patch), null, 2) + "\n";
  } catch (e) {
    return { status: "error", reason: (e as Error).message };
  }
  if (before.trim() === after.trim()) return { status: "unchanged" };
  if (!o.apply) return { status: "dry-run", before, after };

  if (!o.authorize) return { status: "refused", reason: "apply sans autorisation : refusé." };
  const auth = o.authorize(realpathSync(target));
  if (!auth.ok) return { status: "refused", reason: auth.reason ?? "autorisation refusée" };
  if (auth.consume && !auth.consume()) return { status: "refused", reason: "approbation déjà consommée par un autre processus." };

  const real = realpathSync(target);
  const backup = `${real}.bak-${(o.now ?? Date.now)()}`;
  try {
    copyFileSync(real, backup);
    writeFileSync(real, after);
  } catch (e) {
    auth.release?.();
    try {
      if (existsSync(backup)) copyFileSync(backup, real);
    } catch {
      /* restauration impossible aussi : la raison renvoyée dit de vérifier le fichier */
    }
    return { status: "error", reason: `écriture impossible (${(e as Error).message}) ; vérifie ${real}` };
  }
  try {
    JSON.parse(readFileSync(real, "utf8"));
  } catch (e) {
    copyFileSync(backup, real);
    auth.release?.();
    return { status: "restored", reason: `JSON invalide après écriture : ${(e as Error).message}`, backup };
  }
  return { status: "applied", before, after, backup };
}
