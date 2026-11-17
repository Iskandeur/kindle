/**
 * memoire-gate — ne pas démarrer de job sous une mémoire disponible trop basse (un serveur dont la RAM est déjà au
 * plafond gèle au job suivant). Sœur de `load-gate.ts` (qui ne regarde que la charge) : MemAvailable (/proc/meminfo)
 * sous `MEM_DISPO_BASSE_MO` pendant `MEM_DUREE_MS` → plus de nouvelle réclamation sur la machine ; remonte au-dessus de
 * `MEM_DISPO_REPRISE_MO` pendant `MEM_REPRISE_MS` → la file repart. Les jobs en vol continuent. Une mesure illisible ne
 * change rien (on ne suspend pas sur une ignorance).
 *
 * Seuils par l'env : `MEM_DISPO_BASSE_MO` (défaut 512), `MEM_DISPO_REPRISE_MO` (défaut 1024), `MEM_DUREE_MS` (défaut 60 s),
 * `MEM_REPRISE_MS` (défaut 120 s). `MEM_GARDE=off` coupe la garde. Une alerte par épisode, au plus une par heure.
 */
import { lireMemDisponibleMo } from "./pression-sampler.ts";

export interface SeuilsMemoire {
  basseMo: number;
  repriseMo: number;
  dureeMs: number;
  repriseMs: number;
}

export const SEUILS_MEMOIRE_DEFAUT: SeuilsMemoire = { basseMo: 512, repriseMo: 1024, dureeMs: 60_000, repriseMs: 120_000 };
export const MEM_ALERTE_COOLDOWN_MS = 3600_000;

function entierPositif(v: string | undefined, defaut: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : defaut;
}

/** Les seuils, depuis l'env ; une valeur absente ou absurde retombe sur le défaut. Reprise ≥ basse, toujours. */
export function seuilsMemoireDepuisEnv(env: Record<string, string | undefined> = process.env): SeuilsMemoire {
  const d = SEUILS_MEMOIRE_DEFAUT;
  const basseMo = entierPositif(env.MEM_DISPO_BASSE_MO, d.basseMo);
  return {
    basseMo,
    repriseMo: Math.max(entierPositif(env.MEM_DISPO_REPRISE_MO, d.repriseMo), basseMo),
    dureeMs: entierPositif(env.MEM_DUREE_MS, d.dureeMs),
    repriseMs: entierPositif(env.MEM_REPRISE_MS, d.repriseMs),
  };
}

export interface EtatMemoire {
  basseDepuis: number | null;
  hauteDepuis: number | null;
  suspendu: boolean;
  derniereAlerte: number;
}

export const ETAT_MEMOIRE_INITIAL: EtatMemoire = { basseDepuis: null, hauteDepuis: null, suspendu: false, derniereAlerte: Number.NEGATIVE_INFINITY };

export interface DecisionMemoire {
  etat: EtatMemoire;
  transition: "suspendre" | "reprendre" | null;
  alerter: boolean;
}

/** Une observation de MemAvailable (Mo). PUR. */
export function observerMemoire(etat: EtatMemoire, dispoMo: number | null, now: number, s: SeuilsMemoire = SEUILS_MEMOIRE_DEFAUT): DecisionMemoire {
  if (dispoMo === null || !Number.isFinite(dispoMo)) return { etat, transition: null, alerter: false };
  if (!etat.suspendu) {
    if (dispoMo >= s.basseMo) return { etat: { ...etat, basseDepuis: null }, transition: null, alerter: false };
    const basseDepuis = etat.basseDepuis ?? now;
    if (now - basseDepuis < s.dureeMs) return { etat: { ...etat, basseDepuis }, transition: null, alerter: false };
    const alerter = now - etat.derniereAlerte >= MEM_ALERTE_COOLDOWN_MS;
    return {
      etat: { basseDepuis, hauteDepuis: null, suspendu: true, derniereAlerte: alerter ? now : etat.derniereAlerte },
      transition: "suspendre",
      alerter,
    };
  }
  if (dispoMo < s.repriseMo) return { etat: { ...etat, hauteDepuis: null }, transition: null, alerter: false };
  const hauteDepuis = etat.hauteDepuis ?? now;
  if (now - hauteDepuis < s.repriseMs) return { etat: { ...etat, hauteDepuis }, transition: null, alerter: false };
  return { etat: { ...etat, basseDepuis: null, hauteDepuis: null, suspendu: false }, transition: "reprendre", alerter: false };
}

export function texteAlerteMemoire(dispoMo: number, enVol: number, s: SeuilsMemoire): string {
  return `🧠 Il reste ${dispoMo} Mo de mémoire disponible sur la machine depuis ${s.dureeMs / 1000} s (seuil ${s.basseMo} Mo) : ` +
    `je ne lance plus de nouveau job ici tant qu'elle n'est pas remontée au-dessus de ${s.repriseMo} Mo pendant ${s.repriseMs / 1000} s. ` +
    `${enVol} job(s) en vol continuent. Rien à faire de ton côté.`;
}

/** L'état vivant de la porte, tenu par le runner de jobs. */
export class GardeMemoire {
  etat: EtatMemoire = ETAT_MEMOIRE_INITIAL;
  private readonly lire: () => number | null;
  private readonly alerte: (texte: string) => void;
  private readonly seuils: SeuilsMemoire;
  constructor(o: { lire?: () => number | null; alerte: (texte: string) => void; seuils?: SeuilsMemoire }) {
    this.lire = o.lire ?? lireMemDisponibleMo;
    this.alerte = o.alerte;
    this.seuils = o.seuils ?? seuilsMemoireDepuisEnv();
  }
  /** Une observation ; rend true si les réclamations de jobs sont suspendues. Ne lève jamais. */
  observer(now: number, enVol: number): boolean {
    try {
      const dispo = this.lire();
      const d = observerMemoire(this.etat, dispo, now, this.seuils);
      this.etat = d.etat;
      if (d.transition === "suspendre") {
        console.warn(`[jobs] mémoire disponible ${dispo} Mo < ${this.seuils.basseMo} Mo depuis ${this.seuils.dureeMs / 1000} s : plus aucune nouvelle réclamation sur cette machine`);
        if (d.alerter && dispo !== null) this.alerte(texteAlerteMemoire(dispo, enVol, this.seuils));
      } else if (d.transition === "reprendre") {
        console.log(`[jobs] mémoire remontée (${dispo} Mo) : la réclamation reprend`);
      }
    } catch (e) {
      console.error(`[jobs] garde mémoire en échec (${(e as Error).message})`);
    }
    return this.etat.suspendu;
  }
}
