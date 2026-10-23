/**
 * approval-gate — l'approbation de ton humain devient une serrure, plus seulement une discipline.
 *
 * LE CONSTAT. Les gestes les plus sensibles d'un agent (écrire en ton nom, élargir ses propres droits,
 * rendre quelque chose public, fusionner du code sensible) suivent un flux documenté : « demander →
 * l'humain réagit → exécuter ». Si rien ne vérifie l'approbation au moment d'exécuter, ce flux ne tient
 * que par la bonne volonté de l'agent : un job, une session distraite ou un contenu tiers qui l'aurait
 * manipulé peut lancer l'acte sans demande, avant la réponse, après un refus, ou avec un autre texte
 * que celui que l'humain avait lu.
 *
 * CE QUE CE MODULE VÉRIFIE, pour une demande #N et l'acte qu'on s'apprête à faire :
 *   1. la demande existe et a été créée LIÉE à un acte (une empreinte posée à la création) ;
 *   2. l'acte est exactement celui que l'humain a vu : mêmes destination + texte, mêmes fichier cible +
 *      patch. Un mot changé après son accord = refus ;
 *   3. le système a enregistré SA décision, et c'est un pouce levé (teintes de peau comprises) ou un
 *      « ok » tapé. Tout autre emoji est refusé, y compris ceux qu'une demande aurait proposés en option :
 *      le verrou ne lit pas les conventions en prose ;
 *   4. elle n'a pas déjà servi (une approbation = UN acte) ;
 *   5. sa décision a moins de 24 h (`APPROVAL_GATE_TTL_MS`) ;
 *   6. elle n'a pas été annulée / périmée / remplacée.
 *
 * CE QU'IL NE FAIT PAS. C'est une serrure de PROCÉDURE, pas un coffre : si l'agent peut lire la clé de
 * l'API d'envoi, un script écrit à la main qui appelle l'API directement ne passe pas par ici. Le verrou
 * ferme le chemin documenté, celui qu'un agent prend naturellement ; il ne rend pas l'abus impossible.
 * À dire tel quel, jamais à gonfler.
 *
 * PUR : zéro I/O. Le code appelant lit la base (ses demandes d'approbation) et appelle `checkApprovalGate`.
 */
import { createHash } from "node:crypto";

/** Durée de validité d'une décision pour exécuter l'acte (24 h après qu'il a décidé). Au-delà, le
 *  contexte qui rendait l'acte juste a pu bouger : on redemande. */
export const APPROVAL_GATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Statuts qui ferment une demande quoi qu'en dise le verdict (posés à la main ou par la péremption). */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "denied", "lapsed", "superseded"]);

/** Normalise un texte comme les deux bouts du flux le lisent (fichier `trimEnd`, fins de ligne CRLF). */
function normText(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Empreinte d'un envoi en ton nom : la destination ET le texte. Le même texte vers un autre fil
 *  n'est pas l'acte que l'humain a validé. */
export function sendFingerprint(chatId: string, text: string): string {
  return sha256(`send\n${chatId.trim()}\n${normText(text)}`);
}

/** Empreinte d'un patch : le fichier cible (chemin ABSOLU résolu) ET le patch, en JSON (indifférent à
 *  l'indentation du fichier de spec, sensible à tout le reste, y compris l'ordre des clés). */
export function patchFingerprint(targetAbsPath: string, patch: unknown): string {
  return sha256(`patch-json\n${targetAbsPath}\n${JSON.stringify(patch)}`);
}

/** Empreinte d'un acte quelconque décrit par un texte exact : une commande Bash, un appel d'outil en JSON
 *  canonique, une fusion « dépôt#pr au commit X »… Un caractère de plus = un autre acte. `kind`
 *  sépare les familles d'actes : le même texte sous deux familles ne partage pas d'approbation. */
export function actFingerprint(kind: string, act: string): string {
  return sha256(`${kind}\n${normText(act)}`);
}

/** Un verdict qui vaut OUI : 👍 (avec ou sans teinte de peau / sélecteur de variante), ou « ok » tapé. */
export function isApprovingVerdict(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  const v = verdict.trim();
  if (v.toLowerCase() === "ok") return true;
  // 👍 = U+1F44D ; teintes U+1F3FB–U+1F3FF ; sélecteur de variante U+FE0F.
  return v.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "") === "\u{1F44D}";
}

/** Ce que le verrou lit d'une demande (sous-ensemble de ta table d'approbations). */
export interface GateRow {
  id: number;
  status: string;
  fingerprint: string | null;
  verdict: string | null;
  /** Instant (ms epoch) où l'humain a décidé. */
  verdict_at: number | null;
  /** Instant (ms epoch) où l'acte a été exécuté sous cette demande, ou null. */
  consumed_at: number | null;
}

export type GateDecision = { ok: true } | { ok: false; reason: string };

const fmtHours = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;

/**
 * Décide si l'acte d'empreinte `expected` peut s'exécuter sous la demande `row`. L'ordre des refus
 * va du plus structurel au plus temporel, pour que la raison affichée soit celle qui dit quoi faire.
 */
export function checkApprovalGate(
  row: GateRow | null,
  expected: string,
  now: number,
  ttlMs: number = APPROVAL_GATE_TTL_MS,
): GateDecision {
  if (!row) return { ok: false, reason: "demande introuvable dans la base." };
  const n = `#${row.id}`;
  if (!row.fingerprint) {
    return {
      ok: false,
      reason: `la demande ${n} n'est liée à aucun acte (créée sans empreinte). Elle ne peut rien autoriser : redemande en mode lié.`,
    };
  }
  if (row.fingerprint !== expected) {
    return {
      ok: false,
      reason:
        `ce que tu t'apprêtes à faire n'est pas ce qui a été validé sous ${n} ` +
        "(destination, texte, fichier cible ou patch différents, même d'un caractère). Redemande avec le texte exact.",
    };
  }
  if (CLOSED_STATUSES.has(row.status)) {
    return { ok: false, reason: `la demande ${n} est fermée (statut « ${row.status} »).` };
  }
  if (!row.verdict) {
    return {
      ok: false,
      reason: `aucune décision enregistrée sur ${n} : l'humain n'a pas encore réagi, ou sa réaction n'est pas arrivée jusqu'ici. Attends son accord, ou demande-lui de taper « ok ${row.id} ».`,
    };
  }
  if (!isApprovingVerdict(row.verdict)) {
    return { ok: false, reason: `la décision sur ${n} est « ${row.verdict} », pas un pouce levé ni un « ok ${row.id} ».` };
  }
  if (row.consumed_at !== null && row.consumed_at !== undefined) {
    return {
      ok: false,
      reason: `la demande ${n} a déjà servi (${new Date(Number(row.consumed_at)).toISOString()}). Une approbation vaut UN acte.`,
    };
  }
  const age = now - Number(row.verdict_at ?? 0);
  if (!row.verdict_at || age > ttlMs) {
    return {
      ok: false,
      reason: `la décision sur ${n} date de ${fmtHours(age)}, au-delà de ${fmtHours(ttlMs)} : redemande.`,
    };
  }
  return { ok: true };
}
