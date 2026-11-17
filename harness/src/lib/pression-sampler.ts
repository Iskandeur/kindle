/**
 * pression-sampler — lire un gel APRÈS COUP : sans mesure, un serveur qui a gelé une heure ne dit pas pourquoi.
 *
 * Toutes les 60 s : PSI (cpu, mémoire, io), MemAvailable/MemTotal/swap, charge 1/5/15 min et les 5 plus gros RSS, dans
 * `data/pression-samples.jsonl`, un fichier TOURNANT (au-delà de `PRESSION_FICHIER_MAX_MO`, il passe en `.1`, l'ancien `.1`
 * est écrasé : au plus 2× la borne sur le disque). Le même passage peut écrire un battement du daemon
 * (`daemon_heartbeat_at`, via l'option `battement`) : au redémarrage, l'écart avec ce battement mesure la durée du trou.
 *
 * Les lectures sont du texte /proc passé aux fonctions PURES ; les I/O sont injectables. Un passage ne lève jamais.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const PRESSION_FICHIER = "pression-samples.jsonl";
export const PRESSION_INTERVALLE_MS = 60_000;
export const PRESSION_FICHIER_MAX_MO = 5;
export const HEARTBEAT_KEY = "daemon_heartbeat_at";

export interface Psi {
  /** moyennes glissantes (%) et cumul (µs) de la ligne `some` ; `full` absent pour le CPU sur certains noyaux. */
  someAvg10: number;
  someAvg60: number;
  someTotalUs: number;
  fullAvg10: number | null;
  fullAvg60: number | null;
  fullTotalUs: number | null;
}

/** /proc/pressure/<x> → Psi ; null si la ligne `some` est illisible (un 0 ressemblerait à « aucune pression »). PUR. */
export function parsePsi(texte: string | null): Psi | null {
  if (!texte) return null;
  const ligne = (kind: string): { a10: number; a60: number; total: number } | null => {
    const m = texte.match(new RegExp(`^${kind} avg10=([\\d.]+) avg60=([\\d.]+) avg300=[\\d.]+ total=(\\d+)`, "m"));
    return m ? { a10: Number(m[1]), a60: Number(m[2]), total: Number(m[3]) } : null;
  };
  const some = ligne("some");
  if (!some) return null;
  const full = ligne("full");
  return {
    someAvg10: some.a10,
    someAvg60: some.a60,
    someTotalUs: some.total,
    fullAvg10: full?.a10 ?? null,
    fullAvg60: full?.a60 ?? null,
    fullTotalUs: full?.total ?? null,
  };
}

export interface Meminfo {
  totalMo: number;
  disponibleMo: number;
  swapTotalMo: number;
  swapLibreMo: number;
}

/** /proc/meminfo → Mo ; null si MemTotal ou MemAvailable manque. PUR. */
export function parseMeminfo(texte: string | null): Meminfo | null {
  if (!texte) return null;
  const kb = (cle: string): number | null => {
    const m = texte.match(new RegExp(`^${cle}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const dispo = kb("MemAvailable");
  if (total === null || dispo === null) return null;
  const mo = (k: number | null): number => Math.round((k ?? 0) / 1024);
  return { totalMo: mo(total), disponibleMo: mo(dispo), swapTotalMo: mo(kb("SwapTotal")), swapLibreMo: mo(kb("SwapFree")) };
}

/** MemAvailable en Mo depuis le texte de /proc/meminfo ; null si illisible. PUR. */
export function memDisponibleMo(texte: string | null): number | null {
  return parseMeminfo(texte)?.disponibleMo ?? null;
}

export function lireMemDisponibleMo(): number | null {
  try {
    return memDisponibleMo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

export interface GrosProcessus {
  pid: number;
  nom: string;
  rssMo: number;
}

/** Les N plus gros VmRSS à partir de couples (pid, texte de /proc/<pid>/status). PUR. */
export function plusGrosRss(statuts: { pid: number; texte: string }[], n = 5): GrosProcessus[] {
  const out: GrosProcessus[] = [];
  for (const { pid, texte } of statuts) {
    const rss = texte.match(/^VmRSS:\s+(\d+)\s*kB/m);
    if (!rss) continue; // thread noyau : pas de RSS
    out.push({ pid, nom: (texte.match(/^Name:\s+(.+)$/m)?.[1] ?? "?").trim().slice(0, 40), rssMo: Math.round(Number(rss[1]) / 1024) });
  }
  return out.sort((a, b) => b.rssMo - a.rssMo).slice(0, n);
}

export function lireStatuts(procDir = "/proc"): { pid: number; texte: string }[] {
  const out: { pid: number; texte: string }[] = [];
  let noms: string[] = [];
  try {
    noms = readdirSync(procDir);
  } catch {
    return out;
  }
  for (const nom of noms) {
    if (!/^\d+$/.test(nom)) continue;
    try {
      out.push({ pid: Number(nom), texte: readFileSync(`${procDir}/${nom}/status`, "utf8") });
    } catch {
      /* processus mort entre-temps */
    }
  }
  return out;
}

export interface Echantillon {
  ts: number;
  uptimeS: number | null;
  charge: [number, number, number] | null;
  mem: Meminfo | null;
  psi: { cpu: Psi | null; memoire: Psi | null; io: Psi | null };
  top: GrosProcessus[];
}

export interface SourcesProc {
  psiCpu: string | null;
  psiMemoire: string | null;
  psiIo: string | null;
  meminfo: string | null;
  loadavg: string | null;
  uptime: string | null;
  statuts: { pid: number; texte: string }[];
}

/** Compose UN échantillon à partir des textes bruts. PUR. */
export function composerEchantillon(src: SourcesProc, now: number, nTop = 5): Echantillon {
  const la = (src.loadavg ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
  const charge = la.length === 3 && la.every(Number.isFinite) ? ([la[0]!, la[1]!, la[2]!] as [number, number, number]) : null;
  const up = Number.parseFloat((src.uptime ?? "").split(" ")[0] ?? "");
  return {
    ts: now,
    uptimeS: Number.isFinite(up) ? Math.round(up) : null,
    charge,
    mem: parseMeminfo(src.meminfo),
    psi: { cpu: parsePsi(src.psiCpu), memoire: parsePsi(src.psiMemoire), io: parsePsi(src.psiIo) },
    top: plusGrosRss(src.statuts, nTop),
  };
}

function lire(chemin: string): string | null {
  try {
    return readFileSync(chemin, "utf8");
  } catch {
    return null;
  }
}

export function lireSourcesProc(): SourcesProc {
  return {
    psiCpu: lire("/proc/pressure/cpu"),
    psiMemoire: lire("/proc/pressure/memory"),
    psiIo: lire("/proc/pressure/io"),
    meminfo: lire("/proc/meminfo"),
    loadavg: lire("/proc/loadavg"),
    uptime: lire("/proc/uptime"),
    statuts: lireStatuts(),
  };
}

/** Ajoute une ligne ; au-delà de `maxOctets`, le fichier passe en `<chemin>.1` (écrasé) et on repart à vide. */
export function ecrireTournant(chemin: string, ligne: string, maxOctets: number): void {
  mkdirSync(dirname(chemin), { recursive: true });
  try {
    if (statSync(chemin).size >= maxOctets) renameSync(chemin, `${chemin}.1`);
  } catch {
    /* fichier absent : rien à tourner */
  }
  appendFileSync(chemin, ligne + "\n");
}

export interface PressionSamplerOpts {
  chemin: string;
  intervalMs?: number;
  maxMo?: number;
  /** écrit le battement (settings) ; appelé à chaque passage. */
  battement?: (now: number) => void;
  lire?: () => SourcesProc;
  now?: () => number;
}

/** UN passage : lit, écrit, bat. Ne lève jamais ; rend l'échantillon écrit (ou null si l'écriture a échoué). */
export function passerEchantillon(o: PressionSamplerOpts): Echantillon | null {
  const now = (o.now ?? Date.now)();
  try {
    o.battement?.(now);
  } catch (e) {
    console.error("[pression] battement non écrit:", (e as Error).message);
  }
  try {
    const e = composerEchantillon((o.lire ?? lireSourcesProc)(), now);
    ecrireTournant(o.chemin, JSON.stringify(e), (o.maxMo ?? PRESSION_FICHIER_MAX_MO) * 1024 * 1024);
    return e;
  } catch (e) {
    console.error("[pression] échantillon non écrit:", (e as Error).message);
    return null;
  }
}

/** Lance la boucle (timer non retenant). Un premier passage tout de suite. Rend l'arrêt. */
export function demarrerPression(o: PressionSamplerOpts): () => void {
  passerEchantillon(o);
  const t = setInterval(() => passerEchantillon(o), o.intervalMs ?? PRESSION_INTERVALLE_MS);
  t.unref();
  return () => clearInterval(t);
}
