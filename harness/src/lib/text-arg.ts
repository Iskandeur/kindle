/**
 * text-arg — le texte libre d'un verbe de CLI, inline ou lu dans un fichier (`@<chemin>`).
 *
 * Pourquoi : un texte long ou riche (commentaire de ticket, brief de job) passe mal par un argument de shell
 * (guillemets, retours à la ligne, longueur). Et une session autonome peut refuser toute commande dont la
 * ligne CONTIENT un motif interdit (`autonomous-denials.ts`) : un commentaire qui CITE ce motif était refusé
 * avec lui. Passé par un fichier, le texte n'est plus dans la commande : le motif ne le voit pas, et il n'a
 * pas à s'assouplir.
 *
 * Forme fichier : UN seul argument, qui commence par `@` et contient un `/` (`@/tmp/c.txt`, `@./c.txt`) OU
 * finit par une extension (`@reponse.txt`, `@c.md`). Un tag seul (« @alice ») reste inline. Un fichier
 * illisible ou vide est refusé, jamais remplacé par le chemin littéral.
 *
 * Piège : `@reponse.txt` (sans `/`) partait tel quel à l'humain dans un message, deux fois en une matinée.
 * D'où la règle de l'extension.
 */

/** Un argument unique qui DÉSIGNE un fichier : `@` puis un `/`, ou `@` puis un nom à extension, sans espace. */
export function pointsToFile(arg: string): boolean {
  if (!arg.startsWith("@") || /\s/.test(arg)) return false;
  return arg.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(arg);
}

export type TextRead = { ok: true; text: string; file: string | null } | { ok: false; reason: string };

/** `words` : les arguments qui forment le texte (options déjà retirées). `read` : la lecture du fichier (injectée). */
export function textFromArgs(words: readonly string[], read: (path: string) => string): TextRead {
  const single = words.length === 1 ? words[0] : null;
  if (single !== null && pointsToFile(single)) {
    const path = single.slice(1);
    let raw: string;
    try {
      raw = read(path);
    } catch (e) {
      return { ok: false, reason: `fichier ${path} illisible (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
    }
    const text = raw.trim();
    if (!text) return { ok: false, reason: `fichier ${path} vide` };
    return { ok: true, text, file: path };
  }
  const text = words.join(" ");
  if (!text.trim()) return { ok: false, reason: "texte vide" };
  return { ok: true, text, file: null };
}
