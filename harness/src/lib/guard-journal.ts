/**
 * guard-journal — chaque décision d'une serrure de sécurité laisse une trace : autorisée ET refusée,
 * horodatée, l'outil, la raison, une EMPREINTE du contenu (jamais le contenu).
 *
 * Pourquoi : une serrure qui n'écrit son état que sur le chemin autorisé, ou qui rend un `deny` à
 * l'agent et rien d'autre, ne laisse de trace de ses refus que dans la conversation. Impossible alors
 * de compter ses refus, de savoir si un garde a déjà bloqué quelque chose, ou de tester qu'il bloque
 * encore (un « canari » : un geste interdit rejoué exprès, qu'on vérifie dans le journal). Un journal
 * d'ACTES, autorisés comme refusés, est le complément de ce que la serrure laisse passer.
 *
 * Règle d'or : ce module ne lève JAMAIS. Une serrure ne doit pas tomber parce que son journal tombe.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LigneSerrure {
  at: number;
  serrure: string;
  outil: string;
  decision: "deny" | "allow" | "laisse";
  raison: string;
  empreinte: string;
}

/** La décision qu'une serrure a écrite sur sa sortie (JSON de hook `permissionDecision`). PUR. */
export function decisionDeSortie(sortie: string): { decision: LigneSerrure["decision"]; raison: string } {
  const d = /"permissionDecision"\s*:\s*"(deny|allow)"/.exec(sortie)?.[1] as "deny" | "allow" | undefined;
  const r = /"permissionDecisionReason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(sortie)?.[1] ?? "";
  return { decision: d ?? "laisse", raison: tronquerRaison(r.replace(/\\"/g, '"'), 200) };
}

/**
 * Tronque une raison de refus à `max` caractères en gardant ENTIÈRE sa queue. Convention : un refus
 * peut finir par une queue ` — règles : …` ou ` — chemins sensibles : …`, qui dit QUOI a refusé ; c'est
 * elle qu'on lit en premier, la couper rendrait le journal muet là où il parle. PUR.
 */
export function tronquerRaison(raison: string, max: number): string {
  if (raison.length <= max) return raison;
  const i = Math.max(raison.lastIndexOf(" — règles : "), raison.lastIndexOf(" — chemins sensibles : "));
  if (i < 0) return raison.slice(0, max);
  const queue = raison.slice(i);
  if (queue.length + 1 >= max) return `…${queue.slice(0, max - 1)}`;
  return `${raison.slice(0, max - queue.length - 1)}…${queue}`;
}

/** L'empreinte d'une entrée d'outil : 16 hex de SHA-256, pour apparier un canari sans garder la valeur. PUR. */
export function empreinte(entree: unknown): string {
  return createHash("sha256").update(JSON.stringify(entree ?? {})).digest("hex").slice(0, 16);
}

/** Ajoute une ligne JSON au journal `fichier`. Ne lève jamais. */
export function ecrireLigneSerrure(ligne: LigneSerrure, fichier: string): void {
  try {
    mkdirSync(dirname(fichier), { recursive: true });
    appendFileSync(fichier, `${JSON.stringify(ligne)}\n`);
  } catch {
    /* une serrure ne tombe pas pour son journal */
  }
}

/**
 * La ligne d'une décision du verrou d'approbation (`approval-gate.ts`). Ce verrou n'est pas un hook :
 * ses portes sont des commandes qui refusaient sur stderr, donc un refus ne survivait que dans la
 * conversation. L'empreinte porte sur la demande et sur l'empreinte SHA-256 de l'acte (déjà sans la
 * valeur) : un canari futur s'apparie dessus. PUR.
 */
export function ligneApprovalGate(o: { porte: string; demande: number | null; acte: string; ok: boolean; raison: string; at: number }): LigneSerrure {
  return {
    at: o.at,
    serrure: "approval-gate",
    outil: o.porte.slice(0, 120),
    decision: o.ok ? "allow" : "deny",
    raison: o.raison.replace(/\s+/g, " ").trim().slice(0, 200),
    empreinte: empreinte({ demande: o.demande, acte: o.acte }),
  };
}

/** Trace une décision du verrou d'approbation, autorisée ET refusée. Ne lève jamais. */
export function tracerApprovalGate(
  o: { porte: string; demande: number | null; acte: string; ok: boolean; raison: string },
  fichier: string,
  now: () => number = Date.now,
): void {
  ecrireLigneSerrure(ligneApprovalGate({ ...o, at: now() }), fichier);
}

/**
 * Branche le journal sur la sortie du processus d'une serrure-hook : à sa sortie, une ligne est écrite
 * dans `fichier`. À appeler juste après avoir lu l'évènement du hook. Rend de quoi noter la raison d'un
 * « laisse » : une serrure qui laisse passer n'écrit rien sur sa sortie (et ne doit jamais écrire
 * `allow`, qui court-circuiterait les permissions de l'agent), donc elle note elle-même pourquoi.
 */
export function brancherJournalSerrure(serrure: string, evt: { tool_name?: string; tool_input?: unknown }, fichier: string): (raison: string) => void {
  let sortie = "";
  let raisonLaisse = "";
  const ecrire = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...reste: unknown[]) => {
    try {
      sortie += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    } catch {
      /* jamais bloquant */
    }
    return (ecrire as (...a: unknown[]) => boolean)(chunk, ...reste);
  }) as typeof process.stdout.write;
  process.on("exit", () => {
    try {
      const { decision, raison } = decisionDeSortie(sortie);
      ecrireLigneSerrure(
        { at: Date.now(), serrure, outil: String(evt.tool_name ?? "?").slice(0, 120), decision, raison: decision === "laisse" && !raison ? raisonLaisse.slice(0, 200) : raison, empreinte: empreinte(evt.tool_input) },
        fichier,
      );
    } catch {
      /* une serrure ne tombe pas pour son journal */
    }
  });
  return (raison: string) => {
    raisonLaisse = raison;
  };
}
