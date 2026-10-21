/**
 * Lire un horodatage sans se faire piéger par son format. PUR, zéro dépendance.
 *
 * 🪤 **Le piège.** Une base d'état stocke souvent ses champs `*_at` en epoch millisecondes (un
 * entier à 13 chiffres), alors que les fichiers d'état JSON du même projet portent les MÊMES noms
 * de champs en ISO (`measuredAt`, `lastRunAt`…). Les deux mondes coexistent avec le même
 * vocabulaire, et le suffixe `_at` ne dit pas lequel on lit.
 *
 * `Date.parse("1789089511574")` rend `NaN`. Un âge `NaN` ne lève pas, et `NaN > seuil` est faux :
 * le verdict qui suit tombe du côté où la comparaison échoue, c'est-à-dire presque toujours du côté
 * rassurant (« consommateur vivant », « rien de périmé »).
 *
 * *Un garde-fou écrit en prose ne s'applique qu'à qui lit le fichier où il est écrit.* Les requêtes
 * ad hoc, celles qui produisent les verdicts, n'ouvrent jamais le schéma. D'où une FONCTION qu'on
 * atteint par son nom, plutôt qu'un paragraphe qu'il faut avoir lu : on accepte les deux formes, et
 * on **lève** sur le reste.
 */

/** Un epoch en millisecondes plausible s'écrit sur 13 chiffres (≈ 2001 → 2286). */
const EPOCH_MS_RE = /^\d{13}$/;

/**
 * Rend l'instant en millisecondes, que `v` soit un epoch-ms (nombre ou chaîne de 13 chiffres) ou
 * une chaîne ISO. **LÈVE** si aucune lecture ne donne un nombre fini.
 *
 * Le `throw` est le cœur : un contrôle qui ne sait pas lire doit dire « je ne sais pas », jamais
 * « tout va bien ».
 */
export function instantMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  if (EPOCH_MS_RE.test(s)) return Number(s);
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;
  throw new Error(`horodatage illisible : ${JSON.stringify(v)} (ni epoch-ms 13 chiffres, ni ISO)`);
}

/** Âge en jours, positif dans le passé. Lève avec `instantMs` plutôt que de rendre un `NaN`. */
export function ageJours(v: unknown, nowMs = Date.now()): number {
  return (nowMs - instantMs(v)) / 86_400_000;
}

/**
 * Variante explicite pour les cas où l'absence est LÉGITIME (colonne nullable, état jamais écrit).
 * Rend `null` pour `null`/`undefined`/`""`, et lève quand même sur une valeur PRÉSENTE mais
 * illisible : là c'est une panne, pas une absence.
 */
export function instantMsOuNull(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  return instantMs(v);
}
