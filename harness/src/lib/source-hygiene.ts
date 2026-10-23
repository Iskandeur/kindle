/**
 * source-hygiene — un seul octet peut rendre un fichier source INVISIBLE à `grep`.
 *
 * Vécu : `grep -n "setSession" orchestrator.ts` renvoyait ZÉRO résultat. Pas une erreur, pas un
 * avertissement : zéro ligne, comme si le symbole n'existait pas. Cause : un octet **NUL brut** (0x00),
 * collé par mégarde dans un littéral de gabarit. `grep` classe alors le fichier en BINAIRE et se tait par
 * défaut. Le fichier le plus gros du daemon était donc muet à toute recherche : on en conclut « ce code
 * n'existe pas » et on le réécrit ailleurs.
 *
 * Le coût réel n'est pas l'octet, c'est le MODE D'ÉCHEC : silencieux et convaincant. D'où cette garde,
 * à brancher dans un test : un octet de contrôle dans un fichier suivi devient un test rouge, pas une énigme.
 *
 * Ce qu'on interdit : tout octet < 0x20 SAUF tabulation (0x09), LF (0x0A), CR (0x0D). L'échappement écrit
 * en toutes lettres dans le code (barre oblique inverse + u0000) reste évidemment autorisé : ce sont six
 * caractères ASCII, pas un octet NUL.
 */

/** Un octet de contrôle trouvé dans un fichier : sa position, sa valeur, sa ligne (1-indexée). */
export interface ControlByteHit {
  offset: number;
  byte: number;
  line: number;
}

/** Le tabulateur, LF et CR sont les seuls octets < 0x20 légitimes dans un fichier texte. */
function isAllowed(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * Tous les octets de contrôle d'un contenu. PUR : prend les octets, ne lit aucun fichier.
 * `max` borne le nombre de résultats (un vrai binaire en contient des milliers, inutile de tout
 * remonter : la garde veut le PREMIER, pas l'inventaire).
 */
export function findControlBytes(bytes: Uint8Array, max = 5): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x0a) {
      line++;
      continue;
    }
    if (byte < 0x20 && !isAllowed(byte)) {
      hits.push({ offset: i, byte, line });
      if (hits.length >= max) return hits;
    }
  }
  return hits;
}

/** Message d'échec lisible (le fichier, l'octet, la ligne), pour l'assertion du test. */
export function describeControlBytes(path: string, hits: readonly ControlByteHit[]): string {
  const first = hits[0];
  if (!first) return "";
  return (
    `${path} contient ${hits.length} octet(s) de contrôle, 1er : 0x${first.byte.toString(16).padStart(2, "0")} ` +
    `ligne ${first.line} (offset ${first.offset}). grep classera ce fichier en BINAIRE et se taira : ` +
    `remplace l'octet brut par son échappement (\\u0000, \\x1b…) ou par du texte lisible.`
  );
}
