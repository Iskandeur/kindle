/**
 * Les veilleurs — « un bout de code qui attend que le monde soit dans un certain état ».
 *
 * Un agent pose souvent une attente : « préviens-moi quand ce déploiement répond », « quand cette PR
 * est fusionnée », « quand ce service redémarre ». Sans veilleur, cette attente n'a pas de porteur : soit
 * une session LLM la ré-interroge à chaque tour (des tokens pour regarder un monde immobile), soit
 * personne ne la lève et la tâche reste suspendue pour toujours.
 *
 * Un veilleur = une SONDE DÉTERMINISTE attachée à une cible (un ticket, une tâche, un identifiant libre)
 * et une date limite. Le daemon les évalue toutes les quelques minutes (`tour`), sans LLM : zéro token
 * tant que rien ne bouge. Dès que l'état est vu, il LÈVE l'attente avec la preuve (via la fonction
 * `lever` que TU injectes : commentaire sur le ticket, réveil de l'agent, message…). Date limite passée
 * sans rien vu : il appelle `pasVu` et se range. Le module ne connaît ni ton tableau de tickets ni ton
 * gateway : il ne fait que sonder, décider, et dire.
 *
 * Sondes fournies : `url` (statut ou contenu d'une page), `commande` (code de sortie d'une commande en
 * lecture seule, sur liste blanche, SANS shell), `pr` (PR fusionnée, via une fonction injectée),
 * `custom` (n'importe quelle fonction que tu inscris, par nom).
 *
 * Pièges évités :
 *  - Une lecture qui ÉCHOUE ne vaut pas « pas vu » : elle est notée et l'attente n'est pas touchée (un
 *    réseau coupé ne doit pas faire croire qu'un déploiement n'a pas eu lieu).
 *  - Un veilleur sans fin est une dépense sans porteur : la limite par défaut est d'une semaine.
 *  - Une commande lancée par une sonde est une surface d'attaque : préfixe exact d'argv sur liste
 *    blanche, aucune option après le verbe (`git ls-remote --upload-pack=…` exécute du code,
 *    `systemctl -H` ouvre une connexion), jamais de shell.
 *  - Un tour peut durer longtemps (sondes réseau) : le registre est réécrit en relisant le fichier, pour
 *    ne pas écraser un veilleur ajouté PENDANT le tour (`fusionnerRegistre`).
 *  - Le même veilleur demandé deux fois sur la même cible n'en crée pas un second.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Sans `limite` : une semaine. */
export const LIMITE_DEFAUT_MS = 7 * 86_400_000;
/** On garde les veilleurs finis 30 jours (pour répondre « qu'a-t-il vu ? »), pas plus. */
export const GARDE_FINIS_MS = 30 * 86_400_000;

/** Les commandes qu'une sonde peut lancer (préfixe exact de l'argv, sans shell). Lecture seule. */
export const COMMANDES_PERMISES: readonly string[][] = [
  ["test"],
  ["systemctl", "is-active"],
  ["systemctl", "is-failed"],
  ["systemctl", "is-enabled"],
  ["docker", "inspect"],
  ["git", "ls-remote"],
  ["getent", "hosts"],
];

export type Sonde =
  | { type: "url"; url: string; contient?: string; statut?: number }
  | { type: "commande"; argv: string[]; code?: number }
  | { type: "pr"; pr: string }
  | { type: "custom"; nom: string; args?: string };

export interface Veilleur {
  id: string;
  /** La cible de l'attente (clé de ticket, id de tâche…). Libre : elle est rendue telle quelle à `lever`. */
  cle: string;
  quoi: string;
  sonde: Sonde;
  depuis: number;
  limite: number;
  creePar: string;
  dernierTour?: number;
  dernierEtat?: string;
  fini?: { at: number; vu: boolean; preuve: string; leve: boolean };
}

export interface Constat {
  vu: boolean;
  preuve: string;
}

/** Les I/O des sondes, injectées. */
export interface SondeDeps {
  now: () => number;
  fetchUrl: (url: string) => Promise<{ status: number; body: string }>;
  /** Lance un argv SANS shell, rend le code de sortie. N'est appelée que pour une commande permise. */
  run: (argv: string[]) => Promise<number>;
  prState: (pr: string) => Promise<"merged" | "closed" | "open" | null>;
  /** Sondes `custom`, par nom. */
  custom?: Record<string, (args: string | undefined) => Promise<Constat>>;
}

/** Ce que fait le veilleur de son verdict — à brancher sur ton tableau de tickets / ta messagerie. */
export interface Levee {
  /** Vu : lever l'attente avec la preuve. Rend `true` si c'est fait (sinon on retentera au tour suivant). */
  vu(v: Veilleur, preuve: string): Promise<boolean>;
  /** Limite passée sans rien vu. Rend `true` si c'est fait. */
  pasVu(v: Veilleur, dernierEtat: string): Promise<boolean>;
}

// ── Pur ────────────────────────────────────────────────────────────────────────────────────────

export function heureLocale(ts: number, tz = "UTC"): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ts));
}

/** Une commande est-elle sur la liste blanche ? Préfixe exact, et aucune option après le verbe. */
export function commandePermise(argv: string[], permises: readonly string[][] = COMMANDES_PERMISES): boolean {
  if (!argv.length || argv.some((a) => typeof a !== "string" || a.length > 300)) return false;
  const pre = permises.find((p) => p.length <= argv.length && p.every((x, i) => argv[i] === x));
  if (!pre) return false;
  // Seul `test` garde ses opérateurs (-e, -f…), qui ne font que lire.
  const reste = argv.slice(pre.length);
  return pre[0] === "test" ? reste.every((a) => !a.startsWith("-") || /^-[a-zA-Z]{1,2}$/.test(a)) : reste.every((a) => !a.startsWith("-"));
}

/** Valide une sonde ; renvoie un message d'erreur, ou null. */
export function erreurSonde(s: Sonde): string | null {
  if (s.type === "url") return /^https?:\/\//.test(s.url) ? null : "url doit commencer par http(s)://";
  if (s.type === "pr") return /^[\w.-]+\/[\w.-]+#\d+$/.test(s.pr) ? null : "pr doit lire owner/repo#N";
  if (s.type === "commande") {
    return commandePermise(s.argv) ? null : `commande hors liste blanche (permises : ${COMMANDES_PERMISES.map((p) => p.join(" ")).join(" · ")})`;
  }
  if (s.type === "custom") return /^[\w-]+$/.test(s.nom) ? null : "nom de sonde custom invalide";
  return "sonde inconnue";
}

/** Ce que la sonde attend, en mots (utilisé si `quoi` n'est pas donné). */
export function quoiParDefaut(s: Sonde): string {
  if (s.type === "url") return `${s.url} ${s.contient ? `contient « ${s.contient} »` : `répond ${s.statut ?? 200}`}`;
  if (s.type === "pr") return `la PR ${s.pr} est fusionnée`;
  if (s.type === "custom") return `la sonde « ${s.nom} » est satisfaite`;
  return `\`${s.argv.join(" ")}\` sort avec ${s.code ?? 0}`;
}

/** Évalue une sonde. Une lecture qui échoue THROW (le tour le note, l'attente n'est pas touchée). */
export async function evaluer(v: Veilleur, d: SondeDeps): Promise<Constat> {
  const s = v.sonde;
  if (s.type === "pr") {
    const st = await d.prState(s.pr);
    if (st === null) throw new Error(`état de ${s.pr} illisible`);
    return { vu: st === "merged", preuve: `${s.pr} : ${st}` };
  }
  if (s.type === "url") {
    const r = await d.fetchUrl(s.url);
    const vu = s.contient ? r.status < 400 && r.body.includes(s.contient) : r.status === (s.statut ?? 200);
    return { vu, preuve: `${s.url} → HTTP ${r.status}${s.contient ? (vu ? `, contient « ${s.contient} »` : `, sans « ${s.contient} »`) : ""}` };
  }
  if (s.type === "custom") {
    const f = d.custom?.[s.nom];
    if (!f) throw new Error(`sonde custom « ${s.nom} » non inscrite`);
    return f(s.args);
  }
  // Revalidée À L'ÉVALUATION : un registre édité à la main ne contourne pas la liste blanche.
  if (!commandePermise(s.argv)) throw new Error("commande hors liste blanche");
  const code = await d.run(s.argv);
  return { vu: code === (s.code ?? 0), preuve: `\`${s.argv.join(" ")}\` → code ${code}` };
}

// ── Registre ───────────────────────────────────────────────────────────────────────────────────

export function lireVeilleurs(path: string): Veilleur[] {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j) ? (j as Veilleur[]) : [];
  } catch {
    return [];
  }
}

/** Écriture atomique (fichier temporaire puis renommage) : un crash en plein milieu ne tronque pas le registre. */
export function ecrireVeilleurs(path: string, vs: Veilleur[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(vs, null, 2) + "\n");
  renameSync(tmp, path);
}

export function nouvelId(vs: Veilleur[]): string {
  const n = vs.reduce((m, v) => Math.max(m, Number(/^V(\d+)$/.exec(v.id)?.[1] ?? 0)), 0);
  return `V${n + 1}`;
}

/** Garde `GARDE_FINIS_MS` de veilleurs finis, pas plus. */
export function elaguer(vs: Veilleur[], now: number): Veilleur[] {
  return vs.filter((v) => !v.fini || now - v.fini.at < GARDE_FINIS_MS);
}

/**
 * Réécrit le registre en relisant le fichier : seuls les veilleurs `maj` (par id) remplacent leur ligne ;
 * un veilleur ajouté pendant un tour (sondes réseau = des dizaines de secondes) n'est pas écrasé.
 */
export function fusionnerRegistre(path: string, maj: Veilleur[], now = Date.now()): void {
  const parId = new Map(maj.map((v) => [v.id, v]));
  const frais = lireVeilleurs(path).map((v) => parId.get(v.id) ?? v);
  ecrireVeilleurs(path, elaguer(frais, now));
}

export interface Bilan {
  evalues: number;
  vus: string[];
  pasVus: string[];
  erreurs: string[];
}

/**
 * Un tour : chaque veilleur actif évalué une fois. Mute `vs` (état, fini) ; l'appelant écrit ensuite le
 * registre avec `fusionnerRegistre`. Un veilleur dont la levée échoue N'EST PAS rangé : il sera retenté.
 */
export async function tour(vs: Veilleur[], d: SondeDeps, levee: Levee): Promise<Bilan> {
  const bilan: Bilan = { evalues: 0, vus: [], pasVus: [], erreurs: [] };
  for (const v of vs) {
    if (v.fini) continue;
    const now = d.now();
    let constat: Constat | null = null;
    if (now <= v.limite) {
      try {
        constat = await evaluer(v, d);
        bilan.evalues++;
      } catch (e) {
        v.dernierEtat = `lecture en échec : ${(e as Error).message.slice(0, 200)}`;
        bilan.erreurs.push(`${v.id} ${v.cle} : ${(e as Error).message.slice(0, 120)}`);
      }
      v.dernierTour = now;
    }
    if (constat) v.dernierEtat = constat.preuve;
    if (constat?.vu) {
      const leve = await levee.vu(v, constat.preuve).catch(() => false);
      if (leve) {
        v.fini = { at: now, vu: true, preuve: constat.preuve, leve };
        bilan.vus.push(`${v.id} ${v.cle}`);
      }
      continue;
    }
    if (now > v.limite) {
      const leve = await levee.pasVu(v, v.dernierEtat ?? "aucun").catch(() => false);
      if (leve) {
        v.fini = { at: now, vu: false, preuve: v.dernierEtat ?? "aucun relevé", leve };
        bilan.pasVus.push(`${v.id} ${v.cle}`);
      }
    }
  }
  return bilan;
}

/** Valide, inscrit le veilleur dans le registre et le rend. Un veilleur identique déjà actif est rendu tel quel. */
export function ajouterVeilleur(
  path: string,
  o: { cle: string; sonde: Sonde; quoi?: string; depuis?: number | null; limite?: number | null; par?: string },
  now = Date.now(),
): Veilleur {
  const err = erreurSonde(o.sonde);
  if (err) throw new Error(err);
  if (!o.cle.trim()) throw new Error("cible (cle) requise");
  const limite = o.limite ?? now + LIMITE_DEFAUT_MS;
  if (limite <= now) throw new Error("la limite est déjà passée");
  const vs = lireVeilleurs(path);
  const meme = vs.find((x) => !x.fini && x.cle === o.cle && JSON.stringify(x.sonde) === JSON.stringify(o.sonde));
  if (meme) return meme;
  const v: Veilleur = {
    id: nouvelId(vs),
    cle: o.cle,
    quoi: (o.quoi ?? quoiParDefaut(o.sonde)).slice(0, 300),
    sonde: o.sonde,
    depuis: o.depuis ?? now,
    limite,
    creePar: o.par ?? "agent",
  };
  ecrireVeilleurs(path, [...vs, v]);
  return v;
}
