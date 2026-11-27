import { randomBytes } from "node:crypto";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Interface d'écoute. Loopback par défaut : lancé hors conteneur (`npm start`), le dashboard ne
  // doit pas s'ouvrir à tout le réseau. L'image Docker pose HOST=0.0.0.0 (le port n'est publié que
  // sur 127.0.0.1 côté hôte, cf. docker-compose.yml).
  host: process.env.HOST || "127.0.0.1",
  // Chemins montés en LECTURE SEULE (bind mounts ro) dans le conteneur — jamais écrits.
  dbPath: process.env.DASHBOARD_DB_PATH ?? "/data/companion.sqlite",
  repoPath: process.env.DASHBOARD_REPO_PATH ?? "/repo",
  // Sonde de vie du daemon (route GET /health) — pas fournie par défaut par ce starter ; à exposer
  // toi-même côté harnais si tu veux ce panneau actif. Injoignable = badge "down", pas une erreur.
  daemonHealthUrl: process.env.DASHBOARD_DAEMON_HEALTH_URL ?? "http://host.docker.internal:8787/health",
  // Route de réglage du daemon (POST /settings, Bearer) — également à exposer toi-même. Vide =
  // panneau réglages en lecture seule.
  settingsUrl: process.env.DASHBOARD_SETTINGS_URL ?? "http://host.docker.internal:8787/settings",
  settingsToken: process.env.DASHBOARD_SETTINGS_TOKEN ?? "",
  // Gate PIN devant tout le dashboard : cookie signé HMAC, sans état serveur (pas de session store
  // à invalider — un logout jette juste le cookie côté client). Vide = gate désactivée : à réserver
  // à un usage strictement local, jamais à un déploiement exposé au-delà de localhost.
  accessPin: process.env.ACCESS_PIN ?? "",
  accessSessionSecret: process.env.ACCESS_SESSION_SECRET ?? randomBytes(32).toString("hex"),
  // Identifiant interne (ex. chat_id WhatsApp) d'un groupe optionnel — sert uniquement à lire les
  // clés settings scopées à ce groupe pour le panneau Réglages modèle. Jamais renvoyé par l'API.
  // Vide = ce panneau affiche "hérite du global" pour cette portée (aucune clé ne matchera), pas
  // une erreur.
  groupScopeId: process.env.GROUP_SCOPE_CHAT_ID ?? "",
};
