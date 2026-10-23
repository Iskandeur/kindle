/**
 * Capteurs « zéro token » — des pré-filtres DÉTERMINISTES exécutés AVANT de dépenser une session LLM.
 *
 * Un réveil récurrent coûte une session à chaque tir, que le monde ait bougé ou non. Un capteur est le
 * PORTIER : une fonction pure Node (aucun LLM) qui répond à une seule question, « du neuf ? ».
 *  - `changed: false` → on réarme le réveil récurrent, AUCUNE session ne démarre ;
 *  - `changed: true`  → on réveille comme d'habitude, avec la `note` (ce qui a bougé) ajoutée à
 *    l'intent, pour que la session ne redécouvre pas à l'aveugle.
 *
 * Distinction à garder nette :
 *  - CAPTEUR = comparaison mécanique (ids, horodatages, hachages) → « ça a bougé ? ». Gratuit.
 *  - VEILLE  = jugement sémantique à chaque cycle (« cette réponse est-elle une vraie question ? »)
 *    → exige une session. Coûte des tokens. Le capteur est le portier, la veille n'ouvre l'œil que
 *    quand il voit du neuf.
 *
 * Ce module apporte le CONTRAT, un REGISTRE, la porte (`prefetchSensorGate`) qui se branche sur le
 * scheduler, et deux capteurs d'exemple génériques (flux RSS/Atom, release GitHub), tous deux en
 * « amorçage puis différence » : le premier passage mémorise l'état courant SANS réveiller (sinon le
 * premier tick déverserait tout l'historique), les suivants ne signalent que le neuf.
 *
 * Toute I/O est injectée (`fetchFn`, `store`, `now`) : rien ici ne touche le réseau ni le disque tout seul.
 */
import type { WakeGate, WakeRow } from "../scheduler.ts";
import type { PrudenceGate } from "./prudence.ts";

// ── Contrat ───────────────────────────────────────────────────────────────────────────────────

export interface SensorResult {
  /** true → réveiller une session (du neuf) ; false → silence, pas de session. */
  changed: boolean;
  /** Résumé de ce qui a changé, ajouté à l'intent du réveil (facultatif). */
  note?: string;
}

export type Sensor = () => Promise<SensorResult>;

/** Magasin clé/valeur minimal pour l'état d'un capteur (une table `settings` suffit). */
export interface KvStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

// ── Registre ──────────────────────────────────────────────────────────────────────────────────

export interface SensorRegistry {
  register(name: string, sensor: Sensor): void;
  get(name: string): Sensor | undefined;
  names(): string[];
}

/** Un registre minimal, vide. Chaque déploiement y inscrit SES capteurs au démarrage. */
export function createSensorRegistry(): SensorRegistry {
  const map = new Map<string, Sensor>();
  return {
    register(name, sensor) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`nom de capteur invalide : « ${name} »`);
      if (map.has(name)) throw new Error(`capteur déjà inscrit : « ${name} »`);
      map.set(name, sensor);
    },
    get: (name) => map.get(name),
    names: () => [...map.keys()],
  };
}

// ── Porte du scheduler ────────────────────────────────────────────────────────────────────────

/**
 * Un réveil désigne son capteur par un préfixe d'intent : `@sensor:nom reste de l'intent`.
 * Convention volontairement textuelle : elle n'impose AUCUNE colonne de plus au magasin de réveils.
 */
export function parseSensorTag(intent: string): { sensor: string; rest: string } | null {
  const m = /^@sensor:([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(intent.trim());
  return m ? { sensor: m[1]!, rest: (m[2] ?? "").trim() } : null;
}

export interface SensorOptions {
  registry: SensorRegistry;
  /** Plafond des réveils « par prudence » (capteur inconnu / en échec). Absent = toujours réveiller. */
  prudence?: PrudenceGate;
  log?: (msg: string) => void;
}

export interface SensorVerdict {
  fire: boolean;
  /** Pourquoi : « changed », « quiet », « unknown », « error », « prudence-cap ». */
  reason: "changed" | "quiet" | "unknown" | "error" | "prudence-cap";
  note?: string;
}

/**
 * Évalue UN capteur par son nom. Ne lève jamais.
 *
 * Politique « fail-open, mais plafonnée » : un capteur inconnu (retiré du registre sans retirer son
 * réveil) ou en échec réveille PAR PRUDENCE — mieux vaut une session de trop qu'un silence sur une
 * alerte de sûreté. Mais chaque prudence est une session : sans plafond, un capteur fantôme à cadence
 * rapide coûte une session par tick, pour toujours. D'où `prudence.claim` (cf. `prudence.ts`).
 */
export async function evaluateSensor(name: string, opts: SensorOptions, now = Date.now()): Promise<SensorVerdict> {
  const log = opts.log ?? ((m) => console.warn(m));
  const sensor = opts.registry.get(name);
  if (!sensor) {
    const note = `⚠️ ANOMALIE — capteur « ${name} » inconnu du registre : réveil par prudence.`;
    return claimPrudence(opts, `capteur inconnu « ${name} »`, "unknown", note, now, log);
  }
  try {
    const r = await sensor();
    return r.changed ? { fire: true, reason: "changed", note: r.note } : { fire: false, reason: "quiet" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const note = `⚠️ ANOMALIE — capteur « ${name} » en échec (${msg.slice(0, 200)}) : réveil par prudence.`;
    return claimPrudence(opts, `capteur « ${name} » en échec`, "error", note, now, log);
  }
}

function claimPrudence(
  opts: SensorOptions,
  why: string,
  reason: "unknown" | "error",
  note: string,
  now: number,
  log: (m: string) => void,
): SensorVerdict {
  if (opts.prudence && !opts.prudence.claim(why, now)) {
    log(`[sensors] ${why} : plafond de prudence atteint, pas de session`);
    return { fire: false, reason: "prudence-cap" };
  }
  return { fire: true, reason, note };
}

/**
 * Prépare la porte d'un tick : évalue (une seule fois par NOM de capteur, même si deux réveils le
 * partagent — sinon le second verrait l'état déjà avancé par le premier et perdrait le changement)
 * les capteurs des réveils dus, puis rend un `WakeGate` SYNCHRONE à passer à `processDueWakes`.
 *
 * Les réveils sans balise `@sensor:` ne sont pas concernés (la porte rend `undefined` : ils tirent
 * comme avant). La porte ne ferme que les RÉCURRENTS (cf. `processDueWakes`).
 */
export async function prefetchSensorGate(due: WakeRow[], opts: SensorOptions, now = Date.now()): Promise<WakeGate> {
  const verdicts = new Map<string, SensorVerdict>();
  for (const w of due) {
    const tag = parseSensorTag(w.intent);
    if (!tag || verdicts.has(tag.sensor)) continue;
    verdicts.set(tag.sensor, await evaluateSensor(tag.sensor, opts, now));
  }
  return (w) => {
    const tag = parseSensorTag(w.intent);
    if (!tag) return undefined;
    const v = verdicts.get(tag.sensor)!;
    if (!v.fire) return { fire: false };
    const body = tag.rest || `Le capteur « ${tag.sensor} » a vu du neuf.`;
    return { fire: true, intent: v.note ? `${body}\n\nCe qui a bougé : ${v.note}` : body };
  };
}

// ── Exemple 1 : un flux RSS / Atom a un nouvel item ───────────────────────────────────────────

/** Combien d'identifiants on retient au plus (un flux ne dépasse guère quelques dizaines d'items). */
const MAX_SEEN = 300;

export interface FeedItem {
  id: string;
  title: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeEntities(m[1]!) : null;
}

/** Extrait les items d'un flux RSS 2.0 (`<item>`, clé `guid`/`link`) ou Atom (`<entry>`, clé `id`). */
export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];
  for (const b of blocks) {
    const body = b[2]!;
    let id = tagText(body, "guid") ?? tagText(body, "id");
    if (!id) {
      id = tagText(body, "link");
      if (!id) {
        const href = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(body);
        id = href ? href[1]! : null;
      }
    }
    const title = tagText(body, "title") ?? "(sans titre)";
    // Un item sans aucune clé stable ne peut pas être différencié : on se rabat sur le titre.
    out.push({ id: id ?? title, title });
  }
  return out;
}

export interface FeedSensorOptions {
  url: string;
  /** Nom court, sert de clé d'état : `sensor:feed:<key>`. */
  key: string;
  fetchFn: FetchFn;
  store: KvStore;
  /** Combien de titres citer dans la note. */
  maxTitles?: number;
}

/**
 * « Un flux a un nouvel item ». Clé de différence = l'identifiant de l'item, JAMAIS sa date de
 * publication : une date peut être absente, mal fuseau-horairée ou réécrite, un id stable ne l'est pas.
 * Amorçage silencieux au premier passage. Une réponse HTTP en échec ou sans aucun item LÈVE (le
 * portier dit « panne », pas « rien de neuf ») : un flux devenu vide ne doit pas effacer l'état.
 */
export function feedSensor(opts: FeedSensorOptions): Sensor {
  const stateKey = `sensor:feed:${opts.key}`;
  return async () => {
    const res = await opts.fetchFn(opts.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${opts.url}`);
    const items = parseFeed(await res.text());
    if (items.length === 0) throw new Error("flux illisible ou sans item");

    const raw = opts.store.getSetting(stateKey);
    const seen: string[] = raw ? safeStringArray(raw) : [];
    const known = new Set(seen);
    const fresh = items.filter((i) => !known.has(i.id));
    // Les plus récents d'abord dans la mémoire : l'élagage retire les plus anciens.
    const next = [...new Set([...items.map((i) => i.id), ...seen])].slice(0, MAX_SEEN);
    opts.store.setSetting(stateKey, JSON.stringify(next));

    if (raw === null || fresh.length === 0) return { changed: false }; // amorçage, ou rien de neuf
    const shown = fresh.slice(0, opts.maxTitles ?? 5).map((i) => `« ${i.title} »`);
    const more = fresh.length > shown.length ? ` (+${fresh.length - shown.length} autres)` : "";
    return { changed: true, note: `${fresh.length} nouvel(s) item(s) sur ${opts.url} : ${shown.join(", ")}${more}` };
  };
}

function safeStringArray(raw: string): string[] {
  try {
    const p: unknown = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ── Exemple 2 : une release GitHub nouvelle sur un dépôt ──────────────────────────────────────

export interface GithubReleaseSensorOptions {
  /** `owner/repo`. */
  repo: string;
  fetchFn: FetchFn;
  store: KvStore;
  /** Jeton facultatif (limite de débit plus haute, dépôts privés). Ne jamais le journaliser. */
  token?: string;
}

/**
 * « Une release nouvelle sur un dépôt ». Lit `releases/latest` (qui écarte brouillons et
 * pré-releases). Un dépôt SANS release (404) n'est pas une panne : l'état « aucune » est mémorisé, et
 * la première release qui apparaît plus tard est bien signalée (l'amorçage a eu lieu). Amorçage
 * silencieux au premier passage.
 */
export function githubReleaseSensor(opts: GithubReleaseSensorOptions): Sensor {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`dépôt attendu au format owner/repo : « ${opts.repo} »`);
  const stateKey = `sensor:github-release:${opts.repo}`;
  return async () => {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "companion-sensor" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await opts.fetchFn(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    let tag = "";
    let title = "";
    if (res.status === 404) {
      tag = ""; // pas (encore) de release
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status} sur ${opts.repo}`);
    } else {
      const j = JSON.parse(await res.text()) as { tag_name?: unknown; name?: unknown };
      if (typeof j.tag_name !== "string" || !j.tag_name) throw new Error("réponse sans tag_name");
      tag = j.tag_name;
      title = typeof j.name === "string" ? j.name : "";
    }
    const prev = opts.store.getSetting(stateKey);
    opts.store.setSetting(stateKey, tag);
    if (prev === null || tag === "" || tag === prev) return { changed: false };
    return {
      changed: true,
      note: `release ${tag}${title && title !== tag ? ` (« ${title} »)` : ""} sur ${opts.repo}${prev ? `, précédente ${prev}` : ""}`,
    };
  };
}
