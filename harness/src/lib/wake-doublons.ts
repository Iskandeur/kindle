/**
 * `wake-doublons` — deux réveils PONCTUELS qui portent le même sujet et tomberont le même jour.
 *
 * **La panne que ça soigne** : deux réveils posés à des heures différentes portent tous deux
 * « vérifier si tel service a régénéré tel contenu », avec le même contexte, la même demande citée, et
 * chacun prévoit d'écrire à l'humain. Deux messages sur le même sujet à 45 minutes d'écart — du bruit
 * pur. Aucun contrôle ne le voyait : un audit de prémisses cherche des prémisses MORTES, jamais des
 * intents JUMEAUX, et une liste qui tronque les intents à 70 caractères suffit à cacher que deux
 * réveils disent la même chose. Un doublon d'intent n'est pas un défaut du daemon : c'est un message
 * de trop chez l'humain.
 *
 * **Pourquoi ça se produit sans que personne ne se trompe** : deux sessions différentes répondent à la
 * même phrase de l'humain (« sans faute demain vérifie si c'est revenu »), chacune pose son porteur
 * dans la minute — exactement la bonne discipline —, et aucune des deux ne voit celui de l'autre. La
 * règle « une promesse a un porteur » fabrique le doublon quand elle est bien suivie par deux lanes à
 * la fois. Le remède ne peut donc pas être « faire attention » : il faut un contrôle qui relise
 * l'ensemble après coup.
 *
 * **Comment on décide que deux intents parlent du même sujet, sans IA ni devinette.** On compare leurs
 * mots RARES — rares au sens du corpus des réveils en attente : un mot présent dans au plus `maxDocs`
 * intents. « vérifier », « message » sont partout et ne prouvent rien ; un nom propre, un identifiant
 * ou un nom de fichier ne sont nulle part ailleurs. Cette rareté se calcule sur le corpus du jour, donc
 * elle suit l'évolution des réveils sans réglage à la main.
 *
 * ⚠️ Ce module TROUVE, il ne juge pas et ne supprime rien. Deux réveils peuvent légitimement parler du
 * même sujet le même jour (l'un constate, l'autre agit) — c'est à la session qui lit de trancher en
 * ouvrant les deux intents. Un contrôle qui annulerait tout seul un réveil ferait plus de dégâts que le
 * doublon qu'il prévient.
 */

/**
 * L'échappatoire, et elle vit DANS l'intent — jamais dans un drapeau.
 *
 * Une fois la paire croisée (chacun sachant que l'autre existe et qui parle en premier), elle ne doit
 * plus ressortir : un contrôle qui re-signale chaque nuit ce qu'on a déjà tranché devient un contrôle
 * qu'on saute. Écrire `CROISEMENT VÉRIFIÉ #<id de l'autre>` dans l'un des deux intents suffit à taire
 * la paire — et seulement celle-là, puisque l'id y est nommé. La trace reste lisible par la session qui
 * ouvrira l'intent, au lieu d'un `--force` qui ne laisse rien.
 *
 * 🪤 Le motif est volontairement tolérant sur la flexion (`vérifié`, `verifie`, `vérifiés`) : un
 * contrôle littéral sur une langue flexionnelle fabrique une lacune qui n'existe pas.
 *
 * ⚠️ Et il y a une raison MÉCANIQUE de l'avoir : le texte qu'on ajoute en croisant deux intents
 * (« croisement posé », « l'autre réveil », les deux ids) devient lui-même du vocabulaire rare commun.
 * Mesuré : 7 mots communs avant le croisement, 15 après. Sans échappatoire, corriger une paire la rend
 * plus suspecte — le geste de réparation gonfle le juge qui l'a demandé.
 */
const MARQUE_CROISEMENT = /croisements?\s+v[ée]rifi[ée]?s?\s*#\s*(\d+)/gi;

/** Les ids déclarés « déjà croisés » par un intent. */
export function croisementsDeclares(intent: string): Set<number> {
  const out = new Set<number>();
  for (const m of intent.matchAll(MARQUE_CROISEMENT)) out.add(Number(m[1]));
  return out;
}

/** Un réveil, réduit à ce qu'il faut pour décider. */
export interface WakePourDoublon {
  id: number;
  /** Échéance, en ms epoch. */
  dueAt: number;
  intent: string;
  /** Période en ms pour un récurrent, `null`/absent pour un ponctuel. */
  recurrenceMs?: number | null;
  /** Nom du capteur qui garde ce réveil, s'il en a un. */
  sensor?: string | null;
}

export interface PaireSuspecte {
  a: number;
  b: number;
  /** Les mots rares que les deux intents partagent, du plus rare au moins rare. */
  communs: string[];
  /** Écart entre les deux échéances, en minutes. */
  ecartMinutes: number;
  /** Le jour (AAAA-MM-JJ, fuseau donné) sur lequel les deux tombent. */
  jour: string;
}

export interface OptionsDoublons {
  /** Un mot compte comme rare s'il n'apparaît que dans au plus tant d'intents. */
  maxDocs?: number;
  /** Nombre de mots rares communs à partir duquel on signale. */
  seuilCommuns?: number;
  /** Longueur minimale d'un mot retenu. */
  longueurMin?: number;
  /** Fuseau IANA utilisé pour décider du « même jour » : celui de TON humain, pas du serveur. */
  timeZone?: string;
}

/**
 * Le seuil vient d'une MESURE, pas d'une intuition — et il est périssable.
 *
 * Distribution relevée sur ~35 réveils ponctuels en attente, en comptant les mots rares communs de
 * chaque paire tombant le même jour : deux doublons confirmés à **47** et **30**, deux paires voisines
 * à **20** et **13**, un cas limite (sujets voisins, objets distincts) à **7**, puis un bruit de fond
 * à **3, 3, 3, 2, 2, 2, 2, 2, 1**. Le décrochage est net entre 7 et 3 : les paires à 3 partagent des
 * mots ordinaires qui ne prouvent rien.
 *
 * D'où `seuilCommuns = 6` : au-dessus du bruit mesuré, en dessous du cas limite utile. ⚠️ Si ton
 * corpus change de nature (beaucoup plus de réveils, ou des intents beaucoup plus courts), cette
 * distribution est à re-mesurer avant de faire confiance au seuil — un seuil hérité d'un autre corpus
 * mesure l'ancien corpus.
 */
const DEFAUTS: Required<OptionsDoublons> = {
  maxDocs: 3,
  seuilCommuns: 6,
  longueurMin: 4,
  timeZone: "UTC",
};

/**
 * Les mots d'un intent, normalisés et dédoublonnés.
 *
 * Les accents sont GARDÉS : les replier sur l'ASCII confondrait un nom propre avec des mots ordinaires.
 */
export function motsDe(intent: string, longueurMin = DEFAUTS.longueurMin): Set<string> {
  const mots = intent
    .toLowerCase()
    .split(/[^0-9a-zà-öø-ÿ_-]+/u)
    .filter((m) => m.length >= longueurMin && !/^\d+$/.test(m));
  return new Set(mots);
}

/** Le jour local d'une échéance, en AAAA-MM-JJ. */
export function jourLocal(ms: number, timeZone = DEFAUTS.timeZone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Cherche les paires de réveils PONCTUELS qui tombent le même jour et partagent assez de mots rares.
 *
 * Les récurrents sont écartés d'emblée : un capteur qui tire toutes les 20 minutes n'est pas un
 * porteur de promesse, et deux veilles voisines (deux sondes de prix, deux veilles de modèles) se
 * ressemblent par nature sans qu'aucun message en double n'en sorte.
 */
export function trouverDoublons(wakes: WakePourDoublon[], options: OptionsDoublons = {}): PaireSuspecte[] {
  const o = { ...DEFAUTS, ...options };
  const ponctuels = wakes.filter((w) => !w.recurrenceMs && !w.sensor);
  if (ponctuels.length < 2) return [];

  // Fréquence documentaire sur le corpus des PONCTUELS : c'est entre eux qu'on cherche des jumeaux, et
  // y mêler 40 intents de capteurs ferait passer pour rare un mot banal de tes veilles.
  const sacs = new Map<number, Set<string>>();
  const docs = new Map<string, number>();
  for (const w of ponctuels) {
    const sac = motsDe(w.intent, o.longueurMin);
    sacs.set(w.id, sac);
    for (const m of sac) docs.set(m, (docs.get(m) ?? 0) + 1);
  }

  const out: PaireSuspecte[] = [];
  for (let i = 0; i < ponctuels.length; i++) {
    for (let j = i + 1; j < ponctuels.length; j++) {
      const a = ponctuels[i]!;
      const b = ponctuels[j]!;
      const jour = jourLocal(a.dueAt, o.timeZone);
      if (jour !== jourLocal(b.dueAt, o.timeZone)) continue;
      if (croisementsDeclares(a.intent).has(b.id) || croisementsDeclares(b.intent).has(a.id)) continue;
      const sa = sacs.get(a.id)!;
      const sb = sacs.get(b.id)!;
      const communs = [...sa]
        .filter((m) => sb.has(m) && (docs.get(m) ?? 0) <= o.maxDocs)
        .sort((x, y) => (docs.get(x) ?? 0) - (docs.get(y) ?? 0) || x.localeCompare(y));
      if (communs.length < o.seuilCommuns) continue;
      out.push({
        a: a.id,
        b: b.id,
        communs,
        ecartMinutes: Math.round(Math.abs(a.dueAt - b.dueAt) / 60000),
        jour,
      });
    }
  }
  return out.sort((x, y) => y.communs.length - x.communs.length);
}

/** Le rapport lisible. 🟢 quand il n'y a rien : un contrôle muet est indiscernable d'un contrôle mort. */
export function formatDoublons(paires: PaireSuspecte[], ponctuels: number): string {
  if (paires.length === 0) {
    return `🟢 Aucun doublon d'intent parmi les ${ponctuels} réveils ponctuels en attente.`;
  }
  const lignes = [
    `⚠️ ${paires.length} paire(s) de réveils ponctuels parlent du même sujet le même jour.`,
    `   Ouvre les DEUX intents avant de trancher : garder le plus complet, reprendre dedans ce que`,
    `   l'autre avait en plus, annuler le second.`,
    `   S'ils ont chacun leur raison d'être, écris « CROISEMENT VÉRIFIÉ #<autre id> » dans un des`,
    `   deux intents : la paire se taira, et la trace restera lisible dans le réveil lui-même.`,
    ``,
  ];
  for (const p of paires) {
    lignes.push(`   #${p.a} ↔ #${p.b} — ${p.jour}, ${p.ecartMinutes} min d'écart, ${p.communs.length} mots rares communs`);
    lignes.push(`      ${p.communs.slice(0, 12).join(" · ")}`);
  }
  return lignes.join("\n");
}
