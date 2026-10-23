/**
 * L'environnement d'une session lancée par le daemon : une LISTE BLANCHE.
 *
 * Le réflexe naïf est `{ ...process.env }` moins une clé ou deux. Chaque `claude -p` (réveils, jobs,
 * tâches de fond) et chaque commande qu'il lance (un `npm test` dans un dépôt tiers cloné par un job,
 * le script d'une dépendance) reçoit alors TOUS les secrets du daemon : clés d'API, jetons de webhook,
 * identifiants cloud. Un script de dépendance qui aspire `process.env` (le geste le plus banal d'une
 * attaque de chaîne d'approvisionnement) repart avec tout.
 *
 * Ici on ne transmet que ce qu'une session, ou un script qu'elle lance, lit réellement dans son
 * environnement. Une variable INCONNUE n'est pas transmise : la position de repos est le refus.
 * Ce que seul le daemon utilise reste au daemon.
 *
 * Limite, à dire : la session tourne sous le même utilisateur système et peut lire le fichier `.env`
 * du daemon. Cette liste n'est pas un cloisonnement, elle retire les secrets de l'environnement que
 * tout processus enfant hérite sans rien demander.
 *
 * Module PUR. Les listes par défaut ne contiennent que du système ; ajoute les tiennes avec
 * `createChildEnv({ allow: [...] })`.
 */

/** Système et outils : shell, locale, proxys et certificats, répertoires XDG, réglages du CLI. */
export const SYSTEM_ENV: readonly string[] = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "COLORTERM",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "CLAUDE_CONFIG_DIR", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT", "MAX_MCP_OUTPUT_TOKENS",
  "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS",
];

/** Familles transmises par préfixe : locale (`LC_*`) et réglages du CLI. */
export const SYSTEM_ENV_PREFIXES: readonly string[] = ["LC_", "CLAUDE_CODE_", "DISABLE_"];

/**
 * Retirés MÊME s'ils matchent une règle :
 *  - la clé d'API (garde-fou de facturation : une session doit tourner sur l'abonnement, jamais sur une clé
 *    héritée par accident) ;
 *  - les plugins de l'appelant (une session de job ne charge pas ceux de la session qui l'a lancée).
 */
export const ALWAYS_STRIPPED: readonly string[] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_PLUGIN_DIRS"];

export interface ChildEnvPolicy {
  /** Noms exacts transmis en plus du système (chemins du daemon, identifiants non secrets, secrets que
   *  tes scripts lisent vraiment dans leur environnement). */
  allow?: readonly string[];
  /** Préfixes transmis en plus de `SYSTEM_ENV_PREFIXES`. */
  allowPrefixes?: readonly string[];
  /** Noms retirés même s'ils matchent (s'ajoutent à `ALWAYS_STRIPPED`). */
  strip?: readonly string[];
}

export interface ChildEnvFilter {
  allows(name: string): boolean;
  /** L'env transmis à une session : la liste blanche appliquée à l'env du daemon. */
  env(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/**
 * Construit le filtre. Garde pour toi une liste séparée des variables « réservées au daemon » et
 * exige dans un test que chaque variable connue de ton `.env` figure dans l'une ou l'autre liste :
 * c'est ce qui rend la classification vérifiable le jour où quelqu'un ajoute un secret.
 */
export function createChildEnv(policy: ChildEnvPolicy = {}): ChildEnvFilter {
  const allow = new Set<string>([...SYSTEM_ENV, ...(policy.allow ?? [])]);
  const prefixes = [...SYSTEM_ENV_PREFIXES, ...(policy.allowPrefixes ?? [])];
  const stripped = new Set<string>([...ALWAYS_STRIPPED, ...(policy.strip ?? [])]);
  const allows = (name: string): boolean => {
    if (stripped.has(name)) return false;
    return allow.has(name) || prefixes.some((p) => name.startsWith(p));
  };
  return {
    allows,
    env(parent) {
      const out: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(parent)) if (v !== undefined && allows(k)) out[k] = v;
      return out;
    },
  };
}
