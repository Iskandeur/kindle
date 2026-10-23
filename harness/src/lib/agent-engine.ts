/**
 * agent-engine — le contrat minimal d'un moteur d'agent : `invoke`, `status`, `cancel`.
 *
 * Pourquoi : un système d'agents décide QUAND réveiller un agent et avec QUEL contexte ; ce qui exécute le
 * réveil (un job Claude, un job d'un autre moteur, demain un autre fournisseur) ne devrait pas être connu
 * de ces décisions. Trois méthodes suffisent, et un moteur qui ne sait pas annuler le dit (`ok: false` +
 * raison) au lieu de faire semblant.
 *
 * Ce module nomme l'interface et en donne UNE implémentation, la file de jobs (`jobsEngine`), qui enveloppe
 * trois opérations de ta base (`addJobDeduped`, `getJob`, `cancelPendingJob`) sans changer leur comportement.
 * Un nouveau moteur s'écrit en branchant ces trois méthodes ; `jobState` fixe le vocabulaire d'état commun.
 *
 * Récupération après plantage : visible, jamais une réattribution silencieuse. Un job en `echec` reste
 * `echec` avec son résultat ; c'est à l'appelant de décider de le relancer.
 */

/** Vocabulaire d'état commun à tous les moteurs. */
export type InvocationState = "en_file" | "en_cours" | "suspendu" | "fini" | "echec" | "annule" | "inconnu";

/** Ce qu'on demande à un moteur. `intent` = la consigne complète ; `by` = qui la demande (trace, dédup). */
export interface InvocationRequest {
  intent: string;
  by: string;
  /** Modèle demandé, null/absent = défaut du moteur. */
  model?: string | null;
  /** Epoch ms au plus tôt pour démarrer. */
  notBefore?: number | null;
}

export interface InvocationReceipt {
  /** Identifiant propre au moteur, à repasser à `status` et `cancel`. */
  id: string;
  /** Vrai si une invocation équivalente était déjà en vol (dédup) : rien de nouveau n'a été lancé. */
  alreadyInFlight: boolean;
}

export interface InvocationStatus {
  state: InvocationState;
  /** Résultat ou motif d'échec/d'annulation quand le moteur en a un. */
  result: string | null;
}

export type CancelResult = { ok: true } | { ok: false; reason: string };

export interface AgentEngine {
  /** Nom court du moteur (`jobs`, `codex`…), pour les traces. */
  readonly name: string;
  invoke(request: InvocationRequest): InvocationReceipt;
  status(id: string): InvocationStatus;
  cancel(id: string, reason: string): CancelResult;
}

/** L'état commun d'un statut de ta table de jobs (`pending`, `running`, `quota_hold`, `done`, `error`, `cancelled`). */
export function jobState(status: string | null | undefined): InvocationState {
  switch (status) {
    case "pending":
      return "en_file";
    case "running":
      return "en_cours";
    case "quota_hold":
      return "suspendu";
    case "done":
      return "fini";
    case "error":
      return "echec";
    case "cancelled":
      return "annule";
    default:
      return "inconnu";
  }
}

/** Le sous-ensemble de ta base dont le moteur de jobs a besoin (injectable pour les tests). */
export interface JobStore {
  addJobDeduped(intent: string, createdBy: string, model?: string | null, opts?: { notBefore?: number }): { id: number; created: boolean };
  getJob(id: number): { status: string; result: string | null } | null;
  cancelPendingJob(id: number, reason: string): { ok: true } | { ok: false; status: string | null };
}

const jobIdOf = (id: string): number | null => (/^\d+$/.test(id) ? Number(id) : null);

/** Le moteur « file de jobs du daemon ». */
export function jobsEngine(store: JobStore): AgentEngine {
  return {
    name: "jobs",
    invoke(d) {
      const r = store.addJobDeduped(d.intent, d.by, d.model ?? null, d.notBefore ? { notBefore: d.notBefore } : {});
      return { id: String(r.id), alreadyInFlight: !r.created };
    },
    status(id) {
      const n = jobIdOf(id);
      const job = n === null ? null : store.getJob(n);
      return job ? { state: jobState(job.status), result: job.result } : { state: "inconnu", result: null };
    },
    cancel(id, reason) {
      const n = jobIdOf(id);
      if (n === null) return { ok: false, reason: `identifiant de job invalide : « ${id} »` };
      const r = store.cancelPendingJob(n, `Annulé : ${reason}`);
      if (r.ok) return { ok: true };
      if (r.status === null) return { ok: false, reason: `job #${n} inconnu` };
      return { ok: false, reason: `job #${n} ${r.status} : seul un job encore en file s'annule d'ici` };
    },
  };
}
