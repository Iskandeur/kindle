/**
 * public-publish — ce qu'un JOB mettrait sur une URL publique, repéré dans une commande Bash AVANT
 * qu'elle parte. Logique PURE ; le hook (PreToolUse sur Bash) est à toi.
 *
 * Le spécimen : un job a activé une GitHub Pages sur un dépôt de projet, sans l'accord de l'humain,
 * alors que le brief l'interdisait. Le verrou « dépôt public » (`github-visibility.ts`) ne voyait pas
 * Pages : un dépôt privé reste privé, mais son SITE sort sur `*.github.io`. Le brief seul n'a pas suffi ;
 * il faut un geste mécanique.
 *
 * Reconnus : l'activation ou le rebuild de Pages par l'API (`gh api … /pages`, `curl api.github.com/…/pages`),
 * un push sur la branche `gh-pages` ou l'outil `gh-pages`, et les déploiements sur une URL publique (Vercel,
 * Netlify, Cloudflare Pages/Workers via wrangler, Surge, Firebase, Fly, Railway, Render, `npm run deploy`),
 * plus les tunnels qui exposent un serveur local (`cloudflared tunnel --url`, `ngrok`, `localtunnel`). Le
 * passage d'un dépôt en public reste à `github-visibility.ts`. L'autorisation est la même : une demande
 * d'approbation liée à l'acte exact, l'accord de l'humain, puis la même commande, une fois.
 *
 * Limites : la forme seulement (un script qui appelle l'API n'est pas vu), et seulement dans l'agent qui
 * passe par ce hook. Les outils MCP de déploiement ne passent pas par une commande Bash : ils demandent
 * leur propre entrée de hook. Faux positifs acceptés (une demande de plus) ; le silence, non.
 */
import { shellSegments, stripHeredocs } from "./github-visibility.ts";

export interface PublicationAct {
  /** `pages`, `gh-pages`, `deploiement`, `tunnel`. */
  kind: string;
  why: string;
}

const base = (w: string): string => w.replace(/^.*\//, "");

/** Ôte `npx`, `pnpm dlx`, `bunx`, `env`, `sudo`, `VAR=…` en tête. */
function commande(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || ["npx", "bunx", "env", "sudo", "exec", "time", "nohup"].includes(base(ws[i])) || (ws[i] === "dlx" && i > 0) || (["pnpm", "yarn"].includes(base(ws[i])) && ws[i + 1] === "dlx"))) {
    i++;
    if (ws[i - 1] && ["npx", "bunx"].includes(base(ws[i - 1]))) while (ws[i]?.startsWith("-")) i++;
  }
  return ws.slice(i);
}

const PAGES_PATH = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/pages(\/builds)?\/?(\?|$)/;
/** Sous-commandes de `vercel` qui ne déploient rien. */
const VERCEL_READONLY = new Set(["env", "ls", "list", "logs", "inspect", "login", "logout", "whoami", "link", "pull", "dev", "build", "help", "--help", "-h", "--version", "-v", "domains", "projects", "teams", "switch", "rm", "remove"]);

function act(ws0: string[]): PublicationAct | null {
  const ws = commande(ws0);
  if (!ws.length) return null;
  const [c, a, b] = [base(ws[0]), ws[1], ws[2]];
  const rest = ws.slice(1);
  if (c === "gh" && a === "api") {
    const path = rest.slice(1).find((w) => PAGES_PATH.test(w.replace(/^(https:\/\/api\.github\.com)?\/?/, "")));
    if (path) {
      const iM = rest.findIndex((w) => w === "-X" || w === "--method");
      const m = (iM >= 0 ? rest[iM + 1] : rest.find((w) => /^(-X|--method=)/.test(w))?.replace(/^(-X|--method=)/, "")) ?? "";
      const ecrit = /^(POST|PUT|PATCH)$/i.test(m) || (!m && rest.some((w) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(w)));
      if (ecrit) return { kind: "pages", why: `gh api ${m.toUpperCase() || "POST"} ${path} (active ou republie une GitHub Pages : URL publique)` };
    }
  }
  if (/^(curl|wget|xh|http|https)$/.test(c)) {
    const url = rest.find((w) => /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/pages/.test(w));
    if (url && (rest.some((w) => /^(-X|--request)$/.test(w)) ? /\b(POST|PUT|PATCH)\b/i.test(rest.join(" ")) : rest.some((w) => /^(-d|--data|--data-raw|--json)/.test(w))))
      return { kind: "pages", why: "appel HTTP qui active une GitHub Pages" };
  }
  if (c === "git" && rest.includes("push") && rest.some((w) => /(^|:|\/)gh-pages$/.test(w))) return { kind: "gh-pages", why: "git push sur la branche gh-pages (publiée par GitHub Pages)" };
  if (c === "gh-pages" || ((c === "npm" || c === "pnpm" || c === "yarn" || c === "bun") && (a === "run" ? b : a) && /^(deploy|publish:site|gh-pages|pages)$/.test(String(a === "run" ? b : a))))
    return { kind: "deploiement", why: `${ws.slice(0, 3).join(" ")} (script de déploiement)` };
  if (c === "vercel" && !(a && VERCEL_READONLY.has(a))) return { kind: "deploiement", why: "vercel (déploiement sur une URL publique, aperçu compris)" };
  if (c === "netlify" && a === "deploy") return { kind: "deploiement", why: "netlify deploy (URL publique, brouillon compris)" };
  if (c === "wrangler" && ((a === "pages" && (b === "deploy" || b === "publish")) || a === "deploy" || a === "publish")) return { kind: "deploiement", why: `wrangler ${a}${a === "pages" ? ` ${b}` : ""} (Cloudflare, URL publique)` };
  if (c === "surge" && !["login", "logout", "whoami", "list", "teardown", "--help"].includes(a ?? "")) return { kind: "deploiement", why: "surge (URL publique)" };
  if (c === "firebase" && a === "deploy") return { kind: "deploiement", why: "firebase deploy" };
  if ((c === "fly" || c === "flyctl") && a === "deploy") return { kind: "deploiement", why: "fly deploy" };
  if (c === "railway" && a === "up") return { kind: "deploiement", why: "railway up" };
  if (c === "render" && a === "deploys") return { kind: "deploiement", why: "render deploys" };
  if (c === "cloudflared" && a === "tunnel" && rest.some((w) => w === "--url" || w.startsWith("--url="))) return { kind: "tunnel", why: "cloudflared tunnel --url (expose un serveur local sur une URL publique)" };
  if (c === "ngrok" && /^(http|tcp|tls)$/.test(a ?? "")) return { kind: "tunnel", why: `ngrok ${a} (URL publique)` };
  if ((c === "lt" || c === "localtunnel") && rest.some((w) => w === "--port" || w === "-p")) return { kind: "tunnel", why: "localtunnel (URL publique)" };
  return null;
}

const QUICK = /\b(gh|git|curl|wget|xh|https?|vercel|netlify|wrangler|surge|firebase|fly|flyctl|railway|render|cloudflared|ngrok|lt|localtunnel|gh-pages|npm|pnpm|yarn|bun)\b/;

/** L'acte de publication que porte cette commande Bash, ou null. Les here-documents sont ôtés ici
 *  (un message de commit qui CITE une commande n'en est pas une). PUR. */
export function publicationActInBash(command: string): PublicationAct | null {
  if (!QUICK.test(command)) return null;
  for (const ws of shellSegments(stripHeredocs(command))) {
    const a = act(ws);
    if (a) return a;
  }
  return null;
}

/**
 * Le texte du refus : ce qui a été vu, et le geste exact pour obtenir l'accord. `howToAsk` = la phrase
 * propre à ton runtime qui dit comment ouvrir la demande d'approbation (la commande de ta CLI).
 */
export function publicationRefusal(why: string, act: string, howToAsk: string): string {
  return (
    `${why} : un job ne publie rien sur une URL publique (GitHub Pages, déploiement, tunnel) sans l'accord de ` +
    `l'humain sur CET acte. ${howToAsk} Après son accord, relance exactement la même commande (le verrou la ` +
    `laisse passer une fois).\n--- acte ---\n${act}\n--- fin ---`
  );
}
