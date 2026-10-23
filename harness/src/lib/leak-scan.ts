/**
 * leak-scan — garde-fou de CONTENU avant une sortie publique (dépôt, PR, page, message à un tiers).
 *
 * Déterministe : il ne remplace pas une relecture humaine ou éditoriale, mais attrape les fuites à bas
 * bruit que le jugement d'un modèle laisse passer (adresse, téléphone, identifiant de messagerie,
 * secret, chemin privé, terme connu comme sensible). Les valeurs détectées ne sont JAMAIS renvoyées dans
 * le rapport : un rapport de fuite qui recopie la fuite en est une seconde.
 *
 * Trois étages :
 *  1. des règles génériques (clé privée, jetons de fournisseurs, Bearer, email, id WhatsApp, IPv4,
 *     téléphones, chemins d'utilisateur) ;
 *  2. un INVENTAIRE PRIVÉ de littéraux exacts (tes numéros, emails, chemins, noms de lieux…), chargé
 *     depuis un fichier NON VERSIONNÉ que ce module ne lit pas lui-même (`parsePrivateInventory`) ;
 *  3. un contrôle « mosaïque » : une seule ancre faible (un prénom, une ville) ne suffit pas à bloquer, mais
 *     deux ancres de CATÉGORIES différentes qui se recoupent, dans la sortie et la surface déjà publique,
 *     identifient quelqu'un (`parseMosaicInventory`).
 *
 * Ce module est PUR : on lui passe du texte (arbre de travail, diff, page servie) ; c'est ta CLI qui va
 * le chercher (`git diff --staged`, `git diff <base>`, `curl` d'une page) et qui fait échouer la sortie
 * si `ok` est faux. Pour un merge sur un dépôt public : récupère le VRAI diff public à l'instant du merge
 * (`.../pull/N.diff`), `addedDiffSources`, `scanSources` ; un diff irrécupérable = refus (fail-closed).
 * Voir `docs/public-anti-leak.md` pour le dispositif complet.
 */

export type ScanSource = {
  name: string;
  text: string;
  /** Décalage de ligne utile quand `text` est un extrait de diff. */
  lineOffset?: number;
};

export type Finding = {
  rule: string;
  severity: "block";
  source: string;
  line: number;
  /** Intentionnellement générique : ne jamais recopier la valeur qui a déclenché la règle. */
  detail: string;
};

export type ScanReport = {
  ok: boolean;
  findings: Finding[];
};

/** Ancre peu sensible seule, mais potentiellement identifiante en combinaison. */
export type MosaicPattern = {
  category: string;
  term: string;
};

export type ScanOptions = {
  /** Termes privés exacts, chargés depuis la configuration privée. */
  privateLiterals?: readonly string[];
  /** Ancres faibles, regroupées par catégorie, pour le contrôle du mosaic effect. */
  mosaicPatterns?: readonly MosaicPattern[];
  /** Surface publique déjà existante, utilisée uniquement pour le contrôle mosaïque. */
  contextSources?: readonly ScanSource[];
  /** Valeurs explicitement autorisées pour cette publication (jamais les clés génériques). */
  allow?: readonly string[];
};

type Rule = {
  id: string;
  pattern: RegExp;
  safe?: (candidate: string, allow: readonly string[]) => boolean;
};

const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])/gu;
const WHATSAPP_ID = /(?<![\w])\d{6,20}@(c\.us|g\.us|lid)(?![\w])/giu;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const INTERNATIONAL_PHONE = /(?<![\d])(?:\+|00)[\d .()/-]{8,20}\d(?![\d])/g;
const FRENCH_PHONE = /(?<![\d])0[1-9](?:[ .-]?\d{2}){4}(?![\d])/g;

const RULES: Rule[] = [
  {
    id: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: "provider-token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+(?!YOUR_|<|\$\{|example\b|changeme\b)[A-Za-z0-9._~+\/-]{20,}=*(?![A-Za-z0-9._~+\/-])/giu,
    safe: (candidate, allow) => isEnvVarName(candidate) || isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "email-address",
    pattern: EMAIL,
    safe: (candidate, allow) =>
      isExampleEmail(candidate) || isAttributionNoReply(candidate) || isWhatsAppAddress(candidate) || isGitRemoteAddress(candidate) || isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "whatsapp-identifier",
    pattern: WHATSAPP_ID,
    safe: (candidate, allow) => isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "ip-address",
    pattern: IPV4,
    safe: (candidate, allow) =>
      isDocumentationIp(candidate) || WELL_KNOWN_PUBLIC_IPS.has(candidate) || isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "international-phone",
    pattern: INTERNATIONAL_PHONE,
    safe: (candidate, allow) => isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "french-phone",
    pattern: FRENCH_PHONE,
    safe: (candidate, allow) => isExplicitlyAllowed(candidate, allow),
  },
  {
    id: "private-filesystem-path",
    pattern: /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s`"']+/g,
    safe: (candidate, allow) => /(?:<user>|<name>|YOUR_|example|user)\b/i.test(candidate) || isExplicitlyAllowed(candidate, allow),
  },
];

const EXAMPLE_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost", "test.invalid"]);

function isExampleEmail(value: string): boolean {
  const domain = value.slice(value.lastIndexOf("@")).slice(1).toLowerCase();
  return EXAMPLE_EMAIL_DOMAINS.has(domain);
}

/**
 * Adresse no-reply d'attribution, publique par construction et n'identifiant personne : le trailer
 * `Co-Authored-By` que l'agent de code ajoute à chaque commit. Correspondance EXACTE, pas une
 * sous-chaîne (`x-noreply@anthropic.com` ou `noreply@anthropic.com.evil.io` restent des adresses). Le
 * no-reply GitHub (`<id>+<login>@users.noreply.github.com`) n'y est PAS : il nomme un compte, donc une
 * personne.
 */
const ATTRIBUTION_NOREPLY = /^noreply@anthropic\.com$/i;

function isAttributionNoReply(value: string): boolean {
  return ATTRIBUTION_NOREPLY.test(value);
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function isExplicitlyAllowed(candidate: string, allow: readonly string[]): boolean {
  const c = candidate.trim().toLocaleLowerCase();
  return allow.some((value) => {
    const v = value.trim().toLocaleLowerCase();
    if (!v) return false;
    if (c === v || c.includes(v)) return true;
    const cd = normalizeDigits(c);
    const vd = normalizeDigits(v);
    return vd.length >= 9 && cd.length >= vd.length && cd.includes(vd);
  });
}

/**
 * IP publiques NOTOIRES de services tiers, sûres à publier : les résolveurs DNS publics. Jamais l'IP
 * d'une de TES machines (serveur, box, VPN) : celles-là doivent rester bloquées. Pour une IP publique
 * que ta publication cite légitimement, passe-la dans `allow`.
 */
const WELL_KNOWN_PUBLIC_IPS: ReadonlySet<string> = new Set([
  "1.1.1.1", "1.0.0.1",
  "8.8.8.8", "8.8.4.4",
  "9.9.9.9", "149.112.112.112",
]);

function isDocumentationIp(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113)
  );
}

function isWhatsAppAddress(value: string): boolean {
  return /@(?:c\.us|g\.us|lid)$/i.test(value);
}

/** `git@host.tld` est le préfixe SSH standard d'un remote git (`git@github.com:org/repo.git`),
 *  pas une adresse email : le nom d'utilisateur littéral "git" ne s'attribue à personne. */
function isGitRemoteAddress(value: string): boolean {
  return /^git@/i.test(value);
}

/** `Bearer SETTINGS_TOKEN` (doc citant le NOM d'une variable d'env par convention SCREAMING_SNAKE_CASE)
 *  n'est pas un vrai jeton : un jeton réel n'est jamais tout en majuscules/underscores, c'est une chaîne
 *  d'allure aléatoire (base64/hex/JWT...). */
function isEnvVarName(value: string): boolean {
  return /^Bearer\s+[A-Z][A-Z0-9_]{19,}$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalMatches(line: string, literal: string): boolean {
  const trimmed = literal.trim();
  if (trimmed.length < 4) return false;
  const digits = normalizeDigits(trimmed);
  if (digits.length >= 9 && digits === trimmed.replace(/\D/g, "")) {
    return normalizeDigits(line).includes(digits);
  }
  if (/^[\p{L}\p{N}_-]+$/u.test(trimmed)) {
    return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_-])`, "iu").test(line);
  }
  return line.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
}

function lineNumber(text: string, index: number, offset: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line + offset;
}

function addFinding(out: Finding[], seen: Set<string>, finding: Finding): void {
  const key = `${finding.source}\u0000${finding.line}\u0000${finding.rule}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(finding);
}

/**
 * Scanne un texte. Le rapport ne contient ni valeur capturée ni extrait du texte source.
 */
export function scanText(source: ScanSource, options: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const allow = options.allow ?? [];
  const offset = source.lineOffset ?? 0;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.text.matchAll(rule.pattern)) {
      const candidate = match[0];
      if (rule.safe?.(candidate, allow)) continue;
      addFinding(findings, seen, {
        rule: rule.id,
        severity: "block",
        source: source.name,
        line: lineNumber(source.text, match.index ?? 0, offset),
        detail: "valeur masquée : corriger ou autoriser explicitement cette occurrence après relecture",
      });
    }
  }

  for (const literal of options.privateLiterals ?? []) {
    const trimmed = literal.trim();
    if (trimmed.length < 4) continue;
    let cursor = 0;
    for (const line of source.text.split(/\r?\n/)) {
      if (literalMatches(line, trimmed) && !isExplicitlyAllowed(line, allow)) {
        addFinding(findings, seen, {
          rule: "private-inventory",
          severity: "block",
          source: source.name,
          line: lineNumber(source.text, cursor, offset),
          detail: "terme de l'inventaire privé masqué : corriger ou autoriser explicitement cette occurrence après relecture",
        });
      }
      cursor += line.length + 1;
    }
  }

  return findings;
}

type MosaicMatch = {
  patternIndex: number;
  category: string;
  source: string;
  line: number;
};

function findMosaicMatches(
  sources: readonly ScanSource[],
  patterns: readonly MosaicPattern[],
  allow: readonly string[],
): MosaicMatch[] {
  const matches: MosaicMatch[] = [];
  const seen = new Set<string>();
  for (const [patternIndex, pattern] of patterns.entries()) {
    const term = pattern.term.trim();
    const category = pattern.category.trim();
    if (term.length < 4 || !category) continue;
    for (const source of sources) {
      let cursor = 0;
      for (const line of source.text.split(/\r?\n/)) {
        if (literalMatches(line, term) && !isExplicitlyAllowed(line, allow)) {
          const lineNumberValue = lineNumber(source.text, cursor, source.lineOffset ?? 0);
          const key = `${patternIndex}\u0000${source.name}\u0000${lineNumberValue}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({ patternIndex, category, source: source.name, line: lineNumberValue });
          }
        }
        cursor += line.length + 1;
      }
    }
  }
  return matches;
}

/**
 * Détecte une combinaison d'ancres faibles sur une sortie et sa surface publique.
 *
 * Une seule ancre ne suffit pas à bloquer : le but est précisément de capter le recoupement d'au moins
 * deux faits distincts provenant de catégories différentes. Les catégories et les valeurs ne sortent
 * jamais du rapport.
 */
function mosaicFindings(
  sources: readonly ScanSource[],
  contextSources: readonly ScanSource[],
  patterns: readonly MosaicPattern[],
  allow: readonly string[],
): Finding[] {
  if (patterns.length === 0 || sources.length === 0) return [];
  const outputMatches = findMosaicMatches(sources, patterns, allow);
  if (outputMatches.length === 0) return [];
  const contextMatches = findMosaicMatches(contextSources, patterns, allow);
  const all = new Map<number, MosaicMatch>();
  for (const match of [...contextMatches, ...outputMatches]) {
    if (!all.has(match.patternIndex)) all.set(match.patternIndex, match);
  }
  const categories = new Set([...all.values()].map((match) => match.category));
  if (all.size < 2 || categories.size < 2) return [];
  const first = outputMatches[0];
  return [
    {
      rule: "mosaic-effect",
      severity: "block",
      source: first.source,
      line: first.line,
      detail: "plusieurs ancres privées de catégories différentes se recoupent : relecture éditoriale ou retrait nécessaire",
    },
  ];
}

export function scanSources(sources: readonly ScanSource[], options: ScanOptions = {}): ScanReport {
  const findings = sources.flatMap((source) => scanText(source, options));
  findings.push(
    ...mosaicFindings(
      sources,
      options.contextSources ?? [],
      options.mosaicPatterns ?? [],
      options.allow ?? [],
    ),
  );
  return { ok: findings.length === 0, findings };
}

/** Parse un fichier d'inventaire privé : un terme littéral par ligne, `#` pour commenter. */
export function parsePrivateInventory(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && !line.startsWith("#"));
}

/** Parse un inventaire mosaïque : `catégorie<TAB>terme` (ou `catégorie|terme`), `#` pour commenter. */
export function parseMosaicInventory(content: string): MosaicPattern[] {
  const patterns: MosaicPattern[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.includes("\t") ? "\t" : "|";
    const split = line.indexOf(separator);
    if (split < 0) continue;
    const category = line.slice(0, split).trim();
    const term = line.slice(split + 1).trim();
    if (category.length >= 2 && term.length >= 4) patterns.push({ category, term });
  }
  return patterns;
}

export type DiffSource = ScanSource;

/**
 * Extrait uniquement les lignes ajoutées d'un diff unifié. Les suppressions ne vont pas devenir publiques
 * et les lignes de contexte sont déjà présentes sur la base ; ne les rescanner évite le bruit et rend la
 * sortie exploitable avant une PR.
 */
export function addedDiffSources(diff: string): DiffSource[] {
  const sources: DiffSource[] = [];
  let path = "diff";
  let newLine = 1;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ b/")) {
      path = raw.slice(6);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      sources.push({ name: path, text: raw.slice(1), lineOffset: newLine - 1 });
      newLine++;
      continue;
    }
    if (!raw.startsWith("-")) newLine++;
  }
  return sources;
}
