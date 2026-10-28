/**
 * Sonde de RÉPONSE du daemon : `GET /health` en loopback.
 *
 * Pourquoi. `systemctl is-active` mesure l'EXISTENCE du processus ; il ne dit rien de sa RÉPONSE.
 * Un job gourmand lancé dans le cgroup du daemon peut dépasser `MemoryHigh` : le noyau gare alors
 * tout le cgroup (daemon compris, état D), l'unité reste `active`, la file d'attente du socket se
 * remplit sans qu'une connexion soit acceptée, et plus rien n'est journalisé. Pour qui ne mesure
 * que l'existence, un daemon gelé est indiscernable d'un daemon sain, et l'humain découvre la
 * panne lui-même, des heures plus tard.
 *
 * Le `/health` du daemon doit être un handler synchrone trivial (`res.writeHead(200).end("ok")`) :
 * il répond si et seulement si la boucle d'événements tourne. C'est le discriminateur voulu.
 *
 * Ce module ne dépend de rien qui puisse mourir avec le daemon : un socket loopback et un
 * timeout. Ni base, ni LLM, ni réseau sortant.
 *
 * Usage côté watchdog : ne lire la santé que sur une unité `active` (un daemon en cours de
 * démarrage est muet sans être en panne), et décider sur la DURÉE de la surdité (une grâce de
 * plusieurs minutes), jamais sur une sonde ratée isolée.
 */

export type HealthState = "ok" | "ko" | "skipped";

/** URL sondée. `WATCHDOG_HEALTH_URL` prime, sinon le port du webhook (défaut 8787) en loopback. */
export function healthUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.WATCHDOG_HEALTH_URL?.trim();
  if (explicit) return explicit;
  const port = env.WEBHOOK_PORT?.trim() || "8787";
  return `http://127.0.0.1:${port}/health`;
}

/**
 * Sonde une fois. Tout ce qui n'est pas un 2xx franc est un "ko" (refus de connexion, timeout,
 * 5xx) : un filet conclut sur ce qu'il observe. `WATCHDOG_NO_HEALTH` désactive la sonde
 * ("skipped") pour un hôte qui n'expose pas de `/health`.
 */
export async function probeHealth(opts: { url?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<HealthState> {
  const env = opts.env ?? process.env;
  if (env.WATCHDOG_NO_HEALTH) return "skipped";
  try {
    const res = await fetch(opts.url ?? healthUrl(env), { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    return res.ok ? "ok" : "ko";
  } catch {
    return "ko";
  }
}
