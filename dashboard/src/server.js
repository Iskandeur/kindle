import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { config } from "./config.js";
import { COOKIE_NAME, gateEnabled, isValidToken, issueToken, pinMatches } from "./access-gate.js";
import {
  dbStatus,
  deepseekBalance,
  getSessionById,
  getSetting,
  lastActivityAt,
  listApprovals,
  listDreamSessions,
  listJobs,
  modelSettings,
  listSessions,
  listWakes,
  usageSummary,
} from "./db.js";
import { headSha, recentLearningCommits } from "./git.js";
import { probeDaemon } from "./daemon-health.js";
import { listContextFiles } from "./context-files.js";
import { GITHUB_LINKS } from "./github-links.js";
import { readKnowledgeRepos } from "./knowledge-repos.js";
import { dreamPromptTemplate } from "./dream-prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function setSessionCookie(res, token) {
  const attrs = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${30 * 24 * 60 * 60}`];
  if (process.env.NODE_ENV !== "development") attrs.push("Secure");
  res.setHeader("set-cookie", attrs.join("; "));
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req, limit = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSettingsCommandBody(raw) {
  try {
    const body = JSON.parse(raw);
    if (typeof body.command !== "string") return null;
    const command = body.command.trim();
    if (!command.startsWith("/") || command.length > 500) return null;
    return command;
  } catch {
    return null;
  }
}

async function relaySettingsCommand(command) {
  if (!config.settingsUrl || !config.settingsToken) {
    return { status: 503, body: { error: "settings_disabled" } };
  }
  let upstream;
  try {
    upstream = await fetch(config.settingsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.settingsToken}`,
      },
      body: JSON.stringify({ command }),
    });
  } catch (e) {
    return { status: 502, body: { error: "settings_unreachable", detail: e.message } };
  }
  const text = await upstream.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "bad_upstream_response" };
  }
  return { status: upstream.status, body };
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safe);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const body = await readFile(filePath);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  res.end(body);
}

const LOGIN_PATHS = new Set(["/login", "/api/auth/login"]);

/** true si la requête a un cookie de session valide — ou si la gate est désactivée. */
function isAuthenticated(req) {
  if (!gateEnabled()) return true;
  return isValidToken(readCookie(req, COOKIE_NAME));
}

async function handleApi(req, res, pathname, query) {
  const limit = Math.min(Number(query.get("limit") ?? 20) || 20, 100);

  if (pathname === "/api/status" && req.method === "GET") {
    const [daemon, sha] = await Promise.all([probeDaemon(), headSha()]);
    sendJson(res, 200, {
      daemon,
      daemonGitSha: getSetting("daemon_git_sha"),
      dashboardGitSha: sha,
      lastActivityAt: lastActivityAt(),
      db: dbStatus(),
    });
    return true;
  }
  if (pathname === "/api/jobs" && req.method === "GET") {
    sendJson(res, 200, { jobs: listJobs(limit) });
    return true;
  }
  if (pathname === "/api/wakes" && req.method === "GET") {
    sendJson(res, 200, listWakes(limit));
    return true;
  }
  if (pathname === "/api/context" && req.method === "GET") {
    sendJson(res, 200, { files: listContextFiles() });
    return true;
  }
  if (pathname === "/api/github" && req.method === "GET") {
    // Liens statiques + knowledge repos lus EN DIRECT depuis knowledge/registry.json (métadonnées
    // seulement — cf. src/knowledge-repos.js). Le panneau suit donc le registre sans redéploiement.
    const { repos, error, source } = readKnowledgeRepos();
    sendJson(res, 200, { ...GITHUB_LINKS, knowledge: repos, knowledgeError: error, knowledgeSource: source });
    return true;
  }
  if (pathname === "/api/dream-prompt" && req.method === "GET") {
    sendJson(res, 200, { ...dreamPromptTemplate(), sessions: listDreamSessions(limit) });
    return true;
  }
  if (pathname === "/api/model-settings" && req.method === "GET") {
    sendJson(res, 200, { ...modelSettings(), settingsAvailable: Boolean(config.settingsUrl && config.settingsToken) });
    return true;
  }
  if (pathname === "/api/settings" && req.method === "POST") {
    const command = parseSettingsCommandBody(await readBody(req, 1024));
    if (!command) {
      sendJson(res, 400, { error: "bad_request" });
      return true;
    }
    const result = await relaySettingsCommand(command);
    sendJson(res, result.status, result.body);
    return true;
  }
  if (pathname === "/api/sessions" && req.method === "GET") {
    const id = query.get("id");
    if (id) {
      const session = getSessionById(id);
      if (!session) {
        sendJson(res, 404, { error: "not_found" });
        return true;
      }
      sendJson(res, 200, { session });
      return true;
    }
    sendJson(res, 200, { sessions: listSessions(limit) });
    return true;
  }
  if (pathname === "/api/usage" && req.method === "GET") {
    const days = Math.min(Number(query.get("days") ?? 30) || 30, 90);
    sendJson(res, 200, { ...usageSummary(days), deepseekBalance: deepseekBalance() });
    return true;
  }
  if (pathname === "/api/approvals" && req.method === "GET") {
    sendJson(res, 200, { approvals: listApprovals(limit) });
    return true;
  }
  if (pathname === "/api/commits" && req.method === "GET") {
    sendJson(res, 200, { commits: await recentLearningCommits(limit) });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (gateEnabled()) {
      if (pathname === "/login" && req.method === "GET") {
        await serveStatic(req, res, "/login.html");
        return;
      }
      if (pathname === "/api/auth/login" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        if (typeof body.pin !== "string" || !pinMatches(body.pin)) {
          sendJson(res, 401, { error: "invalid_pin" });
          return;
        }
        setSessionCookie(res, issueToken());
        sendJson(res, 200, { ok: true });
        return;
      }
      // Connexion par lien : `?pin=...` sur un chargement de page (GET, hors /api) vaut login —
      // pose le cookie de session exactement comme le ferait le formulaire (même
      // `pinMatches`/`issueToken`), pour qu'un lien du type <url>/?pin=123456 connecte en un clic.
      // Restreint aux pages (pas /api/*) : le PIN n'a rien à faire dans une query string d'appel
      // API généré par le front. Le client (public/app.js) nettoie ensuite la barre d'adresse
      // (history.replaceState) — le PIN ne doit pas traîner dans l'historique plus que nécessaire.
      let authed = isAuthenticated(req);
      if (!authed && req.method === "GET" && !pathname.startsWith("/api/")) {
        const pinParam = url.searchParams.get("pin");
        if (pinParam && pinMatches(pinParam)) {
          setSessionCookie(res, issueToken());
          authed = true;
        }
      }

      if (!LOGIN_PATHS.has(pathname) && !authed) {
        if (pathname.startsWith("/api/")) {
          sendJson(res, 401, { error: "unauthorized" });
        } else {
          res.writeHead(302, { location: "/login" });
          res.end();
        }
        return;
      }
    }

    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, pathname, url.searchParams);
      if (!handled) sendJson(res, 404, { error: "not_found" });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (e) {
    console.error("[server] erreur non gérée :", e);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[compagnon-dashboard] en écoute sur ${config.host}:${config.port} (gate PIN ${gateEnabled() ? "activée" : "DÉSACTIVÉE"})`);
});
