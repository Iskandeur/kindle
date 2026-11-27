import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

test("hors conteneur, le dashboard écoute sur le loopback par défaut", () => {
  if (process.env.HOST) return; // un HOST explicite dans l'environnement du test décide
  assert.equal(config.host, "127.0.0.1");
});

test("server.js écoute sur config.host, jamais sur une adresse codée en dur", () => {
  const src = readFileSync(join(import.meta.dirname, "server.js"), "utf8");
  assert.match(src, /\.listen\(config\.port, config\.host/);
  assert.doesNotMatch(src, /\.listen\([^)]*"0\.0\.0\.0"/);
});

test("l'image Docker ouvre ses interfaces internes (HOST=0.0.0.0), le compose publie sur 127.0.0.1", () => {
  const dockerfile = readFileSync(join(import.meta.dirname, "..", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ENV HOST=0\.0\.0\.0$/m);
  const compose = readFileSync(join(import.meta.dirname, "..", "docker-compose.yml"), "utf8");
  assert.match(compose, /"127\.0\.0\.1:\$\{HOST_PORT:-8790\}:8080"/);
});
