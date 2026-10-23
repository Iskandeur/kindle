/**
 * job-stall : un job EN VOL est-il bloqué ?
 *
 * Le runner de jobs ne voit qu'un mur-horloge (le plafond de durée, plusieurs heures). Entre « tout va
 * bien » et ce plafond, un job peut rester des heures sur une commande suspendue, muet, ou répéter la même
 * erreur. Ici, un détecteur PUR sur la transcription JSONL de la session du job (les enregistrements
 * `tool_use` / `tool_result` de Claude Code) : trois signaux, chacun avec un seuil.
 *
 *  - `commande-longue` : un `tool_use` sans `tool_result` depuis au moins COMMANDE_LONGUE_MS (une suite de
 *    tests dure un quart d'heure, le seuil est donc au-dessus) ;
 *  - `silence` : plus aucun enregistrement depuis SILENCE_MS et rien en attente (agent muet, session figée) ;
 *  - `boucle-echecs` : les BOUCLE_MIN derniers résultats d'outil sont des erreurs sur la MÊME clé d'appel
 *    (outil + entrée normalisée), sans succès entre eux.
 *
 * Alerte sobre : `nouveauxSignaux` ne rend un signal qu'une fois par (job, genre) tant qu'il tient ; il se
 * ré-arme quand le signal a disparu. Ce module ne lit ni disque ni réseau : tu lui donnes les lignes.
 */
import { createHash } from "node:crypto";

export const COMMANDE_LONGUE_MS = 25 * 60_000;
export const SILENCE_MS = 20 * 60_000;
export const BOUCLE_MIN = 3;

export type GenreBlocage = "commande-longue" | "silence" | "boucle-echecs";

export interface Blocage {
  genre: GenreBlocage;
  /** Une phrase lisible : ce qui bloque, depuis combien de temps. */
  detail: string;
  /** Depuis quand (epoch ms). */
  depuis: number;
}

interface Appel { id: string; outil: string; cle: string; at: number }

export interface Releve {
  /** Dernier enregistrement horodaté (epoch ms), 0 si aucun. */
  dernierAt: number;
  /** Appels d'outil sans résultat. */
  enAttente: Appel[];
  /** Résultats d'outil dans l'ordre : clé d'appel et erreur ou non. */
  resultats: { cle: string; outil: string; erreur: boolean; at: number }[];
  appels: number;
  erreurs: number;
}

/** Clé stable d'un appel : l'outil + le début normalisé de son entrée (espaces écrasés, chiffres masqués). */
export function cleAppel(outil: string, entree: unknown): string {
  const brut = typeof entree === "string" ? entree : JSON.stringify(entree ?? {});
  const norme = brut.replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 400);
  return `${outil}:${createHash("sha1").update(norme).digest("hex").slice(0, 12)}`;
}

/** Réduit les lignes JSONL d'une transcription à ce que les trois signaux lisent. Une ligne illisible est sautée. */
export function relever(lignes: readonly string[]): Releve {
  const attente = new Map<string, Appel>();
  const connus = new Map<string, Appel>();
  const r: Releve = { dernierAt: 0, enAttente: [], resultats: [], appels: 0, erreurs: 0 };
  for (const ligne of lignes) {
    if (!ligne.trim()) continue;
    let o: { timestamp?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(ligne);
    } catch {
      continue;
    }
    const at = Date.parse(o.timestamp ?? "");
    if (Number.isFinite(at) && at > r.dernierAt) r.dernierAt = at;
    const contenu = o.message?.content;
    if (!Array.isArray(contenu)) continue;
    for (const b of contenu as Record<string, unknown>[]) {
      if (b?.type === "tool_use" && typeof b.id === "string") {
        const outil = String(b.name ?? "?");
        const a: Appel = { id: b.id, outil, cle: cleAppel(outil, b.input), at: Number.isFinite(at) ? at : r.dernierAt };
        attente.set(a.id, a);
        connus.set(a.id, a);
        r.appels++;
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const a = connus.get(b.tool_use_id);
        attente.delete(b.tool_use_id);
        const erreur = b.is_error === true;
        if (erreur) r.erreurs++;
        r.resultats.push({ cle: a?.cle ?? "?", outil: a?.outil ?? "?", erreur, at: Number.isFinite(at) ? at : r.dernierAt });
      }
    }
  }
  r.enAttente = [...attente.values()];
  return r;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/** Les blocages d'un relevé à l'instant `maintenant`. `dernierAt` retombe sur `demarreAt` si la transcription est vide. */
export function detecter(r: Releve, maintenant: number, demarreAt: number): Blocage[] {
  const out: Blocage[] = [];
  const plusVieux = r.enAttente.reduce<Appel | null>((m, a) => (m === null || a.at < m.at ? a : m), null);
  if (plusVieux && maintenant - plusVieux.at >= COMMANDE_LONGUE_MS) {
    out.push({ genre: "commande-longue", depuis: plusVieux.at, detail: `${plusVieux.outil} sans retour depuis ${minutes(maintenant - plusVieux.at)}` });
  }
  const dernier = Math.max(r.dernierAt, demarreAt);
  if (r.enAttente.length === 0 && maintenant - dernier >= SILENCE_MS) {
    out.push({ genre: "silence", depuis: dernier, detail: `aucune activité depuis ${minutes(maintenant - dernier)}` });
  }
  const fin = r.resultats.slice(-BOUCLE_MIN);
  if (fin.length === BOUCLE_MIN && fin.every((x) => x.erreur && x.cle === fin[0]!.cle)) {
    out.push({ genre: "boucle-echecs", depuis: fin[0]!.at, detail: `${fin[0]!.outil} échoue ${BOUCLE_MIN} fois de suite sur le même appel` });
  }
  return out;
}

/** Mémoire de l'alerte : `jobId` → genres déjà signalés. */
export type Signales = Record<string, GenreBlocage[]>;

/**
 * Ce qui est NEUF depuis le dernier passage, et la mémoire à garder. Un genre qui n'est plus actif sort de
 * la mémoire (il pourra de nouveau alerter) ; un job qui n'est plus en vol disparaît.
 */
export function nouveauxSignaux(
  actifs: Record<string, Blocage[]>,
  avant: Signales,
): { neufs: { jobId: string; blocage: Blocage }[]; apres: Signales } {
  const neufs: { jobId: string; blocage: Blocage }[] = [];
  const apres: Signales = {};
  for (const [jobId, bloc] of Object.entries(actifs)) {
    if (bloc.length === 0) continue;
    apres[jobId] = bloc.map((b) => b.genre);
    for (const b of bloc) if (!(avant[jobId] ?? []).includes(b.genre)) neufs.push({ jobId, blocage: b });
  }
  return { neufs, apres };
}
