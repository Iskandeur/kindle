# Zéro dépendance npm (Node natifs uniquement : http, node:sqlite, node:child_process) — un
# seul besoin externe : le binaire `git` pour lire l'historique du dépôt monté en lecture seule.
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY src ./src
COPY public ./public

# Dans le conteneur, écouter sur toutes ses interfaces ; l'exposition réelle est décidée par
# docker-compose.yml (127.0.0.1 côté hôte). Hors conteneur, le défaut reste 127.0.0.1.
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "src/server.js"]
