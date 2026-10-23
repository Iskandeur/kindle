/**
 * autonomous-denials — les refus communs aux sessions NON INTERACTIVES (jobs, maillons de chaîne du rêve,
 * réveils programmés, capteurs).
 *
 * Idée : certains gestes (arbitrer un disjoncteur, réarmer une série, élargir un droit) appartiennent à
 * l'humain ou à la session où il est présent. Un verbe de CLI qui refuse de tourner quand une variable
 * d'environnement dit « je suis un job » est un verrou faible : une variable s'efface. Le niveau solide est
 * celui des permissions de la session, passées au binaire `claude` par `--disallowedTools` (« un refus bat
 * toute permission ») : le moteur refuse, quoi que le job écrive. Les deux verrous coexistent (le verbe garde
 * sa propre garde) : une indirection de shell (`bash -c "$(…)"`, `eval`, une variable qui porte le nom du
 * verbe) échappe à un motif textuel.
 *
 * Pourquoi pas `.claude/settings.json` : il vaut aussi pour la session interactive de l'humain, qui doit
 * pouvoir arbitrer. Les refus des sessions autonomes se passent en ligne de commande, session par session.
 *
 * Syntaxe des motifs : `Bash(<motif>)` accepte le joker `*` PARTOUT (début, milieu, fin), pas seulement le
 * suffixe. Un motif qui commence par `*` couvre le préfixe de la commande quel qu'il soit (`node`, un chemin
 * absolu, `cd x && …` qui est découpée en sous-commandes). Les chemins de `Write`/`Edit` suivent la syntaxe
 * gitignore ; `//chemin` = absolu, sinon relatif au cwd.
 *
 * Pour CITER le verbe dans un texte (commentaire, brief), passe le texte par un fichier (`text-arg.ts`) :
 * le motif refuse toute commande qui CONTIENT le texte, ne l'assouplis pas.
 */

/** Une forme du verbe à refuser, avec ou sans guillemets autour du sous-verbe, quel que soit l'espacement. */
export function verbVariants(script: string, subverb: string): string[] {
  return [`${script} ${subverb}`, `${script}  ${subverb}`, `${script} "${subverb}`, `${script} '${subverb}`];
}

export interface DenialSpec {
  /** Verbes de CLI à refuser : `{ script: "arbiter.ts", subverb: "override" }`. */
  verbs?: ReadonlyArray<{ script: string; subverb: string }>;
  /** Dossiers (relatifs au dépôt) où aucune session autonome n'écrit : les arbitrages de l'humain. */
  protectedDirs?: readonly string[];
}

/** Les refus, tels qu'ils sont passés à `--disallowedTools` (liste, pas chaîne : on les fusionne avec d'autres). PUR. */
export function buildDenials(spec: DenialSpec): string[] {
  const out: string[] = [];
  for (const v of spec.verbs ?? []) for (const f of verbVariants(v.script, v.subverb)) out.push(`Bash(*${f}*)`);
  // Relatif au cwd (le worktree du job), à toute profondeur sous le cwd, ET absolu (`//`, syntaxe gitignore) :
  // un job écrit dans son worktree mais pourrait viser le chemin absolu du dépôt.
  for (const d of spec.protectedDirs ?? []) {
    for (const tool of ["Write", "Edit"]) out.push(`${tool}(${d}/**)`, `${tool}(**/${d}/**)`, `${tool}(//**/${d}/**)`);
  }
  return out;
}

/**
 * Ajoute les refus des sessions autonomes à ceux déjà posés, sans doublon. PUR.
 * `existing` est la chaîne séparée par des virgules d'une option `disallowedTools`.
 */
export function withDenials(denials: readonly string[], existing?: string): string {
  const out = (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of denials) if (!out.includes(r)) out.push(r);
  return out.join(",");
}

/**
 * Une source d'évènement est-elle une session NON INTERACTIVE ? `wake` (réveil programmé, capteurs), `cron`,
 * `agent`. Les tours de conversation (messagerie, tableau de bord) restent libres : c'est là que l'humain parle
 * à l'agent et peut arbitrer. `extra` : tes propres sources autonomes.
 */
export function isAutonomousSource(source: string, extra: readonly string[] = []): boolean {
  return source === "wake" || source === "cron" || source === "agent" || extra.includes(source);
}
