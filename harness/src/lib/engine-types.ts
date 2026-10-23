/** Types communs aux adaptateurs de moteur (`engine-claude.ts`, `engine-openai.ts`, `engine-opencode.ts`). */
import type { ModelRole } from "./engine-config.ts";

export interface TurnRequest {
  prompt: string;
  /** Rôle du modèle (défaut : `fort`). Ignoré si `model` est donné. */
  role?: ModelRole;
  /** Modèle explicite (un épinglage humain, par exemple). */
  model?: string;
  /** `true` = tour agentique avec outils (bash, édition, MCP) ; `false` = un appel de texte seul. */
  tools?: boolean;
  /** Dossier de travail du tour agentique (le dépôt du compagnon). */
  cwd?: string;
  systemPrompt?: string;
  /** Fichier de config MCP au format du moteur `claude` (`--mcp-config`). */
  mcpConfig?: string;
  timeoutMs?: number;
}

export interface TurnResult {
  ok: boolean;
  /** Réponse finale de l'agent. */
  text: string;
  engine: string;
  model: string;
  /** Coût en dollars quand le moteur le chiffre, sinon null (jamais 0 inventé). */
  costUsd: number | null;
  usage: { input: number | null; output: number | null };
  /** Noms des outils appelés pendant le tour (vide si le moteur ne les rapporte pas). */
  toolCalls: string[];
  /** Message d'erreur, avec le code HTTP quand il y en a un (`HTTP 429 …`), pour `engine-failover`. */
  error?: string;
}
