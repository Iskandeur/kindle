/**
 * file-lock — un verrou par FICHIER, à renouvellement, pour passer l'un après l'autre un travail lourd.
 *
 * Cas d'usage : plusieurs sessions de l'agent lancent en même temps des tests dans des conteneurs ou
 * des constructions d'image ; sur une petite machine (2 vCPU) la charge monte à 40 et les sondes de
 * santé expirent. Les travaux lourds passent donc l'un après l'autre : un fichier verrou, créé de façon
 * exclusive (`wx`), qui porte le pid de son détenteur et l'heure.
 *
 * RENOUVELLEMENT : le détenteur réécrit l'heure du verrou toutes les minutes tant qu'il travaille (une
 * suite de tests dure vingt minutes). Un verrou n'est donc « vieux » que par son SILENCE. Un pid qu'on ne
 * voit pas n'est pas forcément mort (autre espace de pids : conteneur) : on ne vole un verrou à pid
 * absent qu'après un délai de silence (3 min = trois renouvellements manqués), pas à la première vérif.
 *
 * LIMITE ASSUMÉE : le vol d'un verrou périmé n'est pas atomique. Deux attendeurs qui le jugent périmé
 * retirent chacun le fichier (seulement s'il porte encore le contenu jugé) puis se disputent la création
 * exclusive : un seul gagne. Reste une fenêtre de quelques microsecondes entre la relecture et
 * l'effacement ; au pire, deux travaux un court instant au lieu de cinq. Ce n'est pas une serrure de
 * sécurité, c'est un RÉGULATEUR DE CHARGE : il doit rater vers « un travail de trop », jamais vers
 * « jamais de travail ».
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Un verrou resté SANS renouvellement plus longtemps est périmé quoi qu'en dise son pid (un pid se réutilise). */
export const PEREMPTION_MS = 10 * 60_000;
/** Le détenteur renouvelle son verrou à ce rythme. */
export const RENOUVELLEMENT_MS = 60_000;
/** Un verrou dont le pid est introuvable (mort, ou dans un autre espace de pids) n'est volé qu'après ce silence. */
export const GRACE_PID_MORT_MS = 3 * 60_000;
/** Combien de temps on attend un verrou pris avant d'échouer proprement. */
export const ATTENTE_MAX_MS = 40 * 60_000;
/** Le pas du sondage. */
export const SONDAGE_MS = 15_000;
/** Un verrou illisible n'est périmé qu'après ce délai (le temps de son détenteur d'écrire son contenu). */
export const GRACE_ILLISIBLE_MS = 60_000;

export interface Verrou {
  pid: number;
  at: number;
}

/** Le contenu d'un verrou : « pid heure », une ligne. PUR. */
export function contenuVerrou(pid: number, at: number): string {
  return `${pid} ${at}\n`;
}

/** Lit un verrou ; null si le contenu n'est pas « pid heure ». PUR. */
export function lireVerrou(texte: string): Verrou | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(texte);
  if (!m) return null;
  const pid = Number(m[1]);
  const at = Number(m[2]);
  return pid > 0 && at > 0 ? { pid, at } : null;
}

/**
 * Le verrou est-il périmé ? Oui s'il est resté plus de 10 min sans renouvellement ; ou si son pid est
 * introuvable ET qu'il est resté plus de 3 min sans renouvellement (un pid d'un autre espace, vivant, se
 * renouvelle : il n'est pas volé). Un verrou illisible (vide : son détenteur n'a pas fini d'écrire) ne
 * l'est qu'après une minute, d'après l'âge du FICHIER. PUR.
 */
export function verrouPerime(v: Verrou | null, maintenant: number, pidVivant: (pid: number) => boolean, ageFichierMs = 0): boolean {
  if (!v) return ageFichierMs > GRACE_ILLISIBLE_MS;
  const silence = maintenant - v.at;
  if (silence > PEREMPTION_MS) return true;
  return silence > GRACE_PID_MORT_MS && !pidVivant(v.pid);
}

/** Un pid existe-t-il (signal 0) ? EPERM = il existe, mais à un autre utilisateur. */
export function pidVivantReel(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface OptionsVerrou {
  maintenant?: () => number;
  pidVivant?: (pid: number) => boolean;
  dormir?: (ms: number) => Promise<void>;
  pid?: number;
  attenteMaxMs?: number;
  sondageMs?: number;
  /** appelé UNE fois, quand le verrou est pris et qu'on attend */
  surAttente?: (v: Verrou | null) => void;
  /** `avecVerrou` : le rythme du renouvellement automatique (0 = aucun ; les tests renouvellent à la main) */
  renouvellementMs?: number;
  /** annulation : l'attente du verrou s'arrête (lève `VerrouAnnule`) ; un verrou déjà pris est rendu comme d'habitude */
  signal?: AbortSignal;
}

/** Ce que rend `prendreVerrou` : de quoi le rendre, et `renouveler` (réécrit l'heure ; faux si le verrou n'est plus à nous). */
export type Detention = (() => void) & { renouveler: () => boolean };

/** Une attente qui a dépassé sa borne. */
export class VerrouTropLong extends Error {}

/** Une attente interrompue par un signal d'annulation (le verrou n'a pas été pris). */
export class VerrouAnnule extends Error {}

/**
 * Prend le verrou (création exclusive), attend par sondage s'il est pris, le vole s'il est périmé. Rend
 * de quoi le rendre. Lève `VerrouTropLong` au bout de `attenteMaxMs`.
 */
export async function prendreVerrou(chemin: string, o: OptionsVerrou = {}): Promise<Detention> {
  const maintenant = o.maintenant ?? Date.now;
  const pidVivant = o.pidVivant ?? pidVivantReel;
  const signal = o.signal;
  // Un sommeil que l'annulation réveille (sinon on dormirait jusqu'au sondage suivant avant de s'en apercevoir).
  const dormir =
    o.dormir ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const fin = (): void => {
          clearTimeout(t);
          signal?.removeEventListener("abort", fin);
          r();
        };
        const t = setTimeout(fin, ms);
        signal?.addEventListener("abort", fin, { once: true });
      }));
  const pid = o.pid ?? process.pid;
  const attenteMax = o.attenteMaxMs ?? ATTENTE_MAX_MS;
  const sondage = o.sondageMs ?? SONDAGE_MS;
  const debut = maintenant();
  let dit = false;
  mkdirSync(dirname(chemin), { recursive: true });
  for (;;) {
    if (signal?.aborted) throw new VerrouAnnule("attente du verrou annulée");
    let contenu = contenuVerrou(pid, maintenant());
    try {
      writeFileSync(chemin, contenu, { flag: "wx" });
      // On ne rend que ce qui est encore à nous : un verrou volé entre-temps n'est pas à effacer.
      const rendre = (): void => {
        try {
          if (readFileSync(chemin, "utf8") === contenu) rmSync(chemin, { force: true });
        } catch {
          /* déjà parti */
        }
      };
      // Renouveler = remplacer l'heure, par un fichier voisin renommé (un lecteur ne voit jamais un fichier
      // vide), et seulement si le verrou est encore le nôtre.
      const renouveler = (): boolean => {
        try {
          if (readFileSync(chemin, "utf8") !== contenu) return false;
          const neuf = contenuVerrou(pid, maintenant());
          const tmp = `${chemin}.${pid}.tmp`;
          writeFileSync(tmp, neuf);
          renameSync(tmp, chemin);
          contenu = neuf;
          return true;
        } catch {
          return false;
        }
      };
      return Object.assign(rendre, { renouveler });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Pris : par qui, et est-il périmé ?
    let texte = "";
    let age = 0;
    try {
      texte = readFileSync(chemin, "utf8");
      age = Date.now() - statSync(chemin).mtimeMs; // l'âge du FICHIER est celui de l'horloge du système de fichiers
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // il vient d'être rendu : on retente tout de suite
      // Illisible pour une autre raison (droits) : on ne boucle pas à vide, on attend comme pour un verrou pris.
    }
    const v = lireVerrou(texte);
    if (verrouPerime(v, maintenant(), pidVivant, age)) {
      try {
        // Ne retire que celui qu'on a jugé : s'il a changé entre-temps, on laisse.
        if (readFileSync(chemin, "utf8") === texte) rmSync(chemin, { force: true });
      } catch {
        /* déjà parti */
      }
      continue;
    }
    if (maintenant() - debut >= attenteMax) throw new VerrouTropLong(`verrou pris depuis ${Math.round((maintenant() - (v?.at ?? debut)) / 60_000)} min par le pid ${v?.pid ?? "?"}, attendu ${Math.round(attenteMax / 60_000)} min`);
    if (!dit) {
      dit = true;
      o.surAttente?.(v);
    }
    await dormir(sondage);
  }
}

/**
 * Exécute `fn` en tenant le verrou, le renouvelle toutes les minutes pendant qu'elle travaille, et le
 * rend quoi qu'il arrive. `fn` doit laisser la boucle d'événements respirer (pas de `spawnSync` de
 * plusieurs minutes) : sinon le renouvellement ne part pas, et le verrou paraîtra abandonné.
 */
export async function avecVerrou<T>(chemin: string, fn: () => T | Promise<T>, o: OptionsVerrou = {}): Promise<T> {
  const detention = await prendreVerrou(chemin, o);
  const rythme = o.renouvellementMs ?? RENOUVELLEMENT_MS;
  const minuteur = rythme > 0 ? setInterval(() => detention.renouveler(), rythme) : null;
  minuteur?.unref();
  try {
    return await fn();
  } finally {
    if (minuteur) clearInterval(minuteur);
    detention();
  }
}

/**
 * `spawnSync` sans bloquer la boucle d'événements : pendant une construction ou une suite de tests, le
 * verrou (`avecVerrou`) se renouvelle toutes les minutes ; un `spawnSync` de vingt minutes l'en
 * empêcherait et un attendeur le croirait abandonné. Même contrat que `spawnSync` : `status` (null si
 * tué), `stdout`, `stderr`.
 *
 * `auDelai` : appelé quand le délai est dépassé (ou sur annulation), AVANT de tuer le client. Tuer
 * `docker run` ne tue pas le conteneur (c'est le démon qui le porte) : le verrou serait rendu alors que la
 * charge continue. L'appelant y fait `docker kill <nom>`. Une exception du crochet n'empêche pas de tuer
 * le client.
 */
export function lancerSansBloquer(
  cmd: string,
  args: string[],
  o: { input?: string; timeoutMs: number; auDelai?: () => void; signal?: AbortSignal },
): Promise<{ status: number | null; stdout: string; stderr: string; delaiDepasse: boolean; annule: boolean }> {
  return new Promise((resolve) => {
    // Déjà annulé : rien n'est lancé.
    if (o.signal?.aborted) return resolve({ status: null, stdout: "", stderr: "", delaiDepasse: false, annule: true });
    let annule = false;
    let stdout = "";
    let stderr = "";
    let delaiDepasse = false;
    const enfant = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const fin = setTimeout(() => {
      delaiDepasse = true;
      try {
        o.auDelai?.();
      } catch {
        /* le client est tué quoi qu'il arrive */
      }
      enfant.kill("SIGKILL");
    }, o.timeoutMs);
    const surAnnulation = (): void => {
      annule = true;
      try {
        o.auDelai?.();
      } catch {
        /* le client est tué quoi qu'il arrive */
      }
      enfant.kill("SIGKILL");
    };
    o.signal?.addEventListener("abort", surAnnulation, { once: true });
    enfant.stdout.on("data", (d: Buffer) => { stdout = (stdout + d.toString("utf8")).slice(-2_000_000); });
    enfant.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2_000_000); });
    enfant.on("error", (e) => {
      clearTimeout(fin);
      o.signal?.removeEventListener("abort", surAnnulation);
      resolve({ status: null, stdout, stderr: `${stderr}${e.message}`, delaiDepasse, annule });
    });
    enfant.on("close", (code) => {
      clearTimeout(fin);
      o.signal?.removeEventListener("abort", surAnnulation);
      resolve({ status: code, stdout, stderr, delaiDepasse, annule });
    });
    enfant.stdin.on("error", () => {});
    enfant.stdin.end(o.input ?? "");
  });
}
