import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationActInBash, publicationRefusal } from "./public-publish.ts";

const kind = (c: string): string | null => publicationActInBash(c)?.kind ?? null;

test("GitHub Pages par l'API : écriture oui, lecture non", () => {
  assert.equal(kind("gh api repos/o/r/pages -X POST -f source[branch]=main"), "pages");
  assert.equal(kind("gh api -X PUT repos/o/r/pages -f cname=x"), "pages");
  assert.equal(kind("gh api repos/o/r/pages/builds -f a=b"), "pages");
  assert.equal(kind("gh api repos/o/r/pages"), null);
  assert.equal(kind("gh api repos/o/r/pages -X GET"), null);
  assert.equal(kind("curl -X POST https://api.github.com/repos/o/r/pages -d '{}'"), "pages");
  assert.equal(kind("curl https://api.github.com/repos/o/r/pages"), null);
});

test("git push gh-pages et outil gh-pages", () => {
  assert.equal(kind("git push origin gh-pages"), "gh-pages");
  assert.equal(kind("git push origin HEAD:gh-pages"), "gh-pages");
  assert.equal(kind("git push origin main"), null);
  assert.equal(kind("npx gh-pages -d dist"), "deploiement");
});

test("scripts de déploiement npm", () => {
  assert.equal(kind("npm run deploy"), "deploiement");
  assert.equal(kind("pnpm deploy"), "deploiement");
  assert.equal(kind("npm run build"), null);
  assert.equal(kind("npm test"), null);
});

test("plateformes : déploiement oui, lecture non", () => {
  assert.equal(kind("vercel --prod"), "deploiement");
  assert.equal(kind("vercel ls"), null);
  assert.equal(kind("npx vercel deploy"), "deploiement");
  assert.equal(kind("netlify deploy --dir=dist"), "deploiement");
  assert.equal(kind("netlify status"), null);
  assert.equal(kind("wrangler pages deploy dist"), "deploiement");
  assert.equal(kind("wrangler dev"), null);
  assert.equal(kind("firebase deploy"), "deploiement");
  assert.equal(kind("fly deploy"), "deploiement");
  assert.equal(kind("railway up"), "deploiement");
  assert.equal(kind("surge ./dist x.surge.sh"), "deploiement");
  assert.equal(kind("surge whoami"), null);
});

test("tunnels", () => {
  assert.equal(kind("cloudflared tunnel --url http://localhost:3000"), "tunnel");
  assert.equal(kind("cloudflared tunnel list"), null);
  assert.equal(kind("ngrok http 3000"), "tunnel");
  assert.equal(kind("lt --port 3000"), "tunnel");
});

test("préfixes et chaînes : env, sudo, VAR=, &&", () => {
  assert.equal(kind("CI=1 sudo vercel --prod"), "deploiement");
  assert.equal(kind("cd app && npm run build && netlify deploy"), "deploiement");
  assert.equal(kind("env FOO=1 /usr/bin/fly deploy"), "deploiement");
});

test("un texte cité ou un here-document n'est pas une publication", () => {
  assert.equal(kind("git commit -m 'doc : vercel --prod'"), null);
  assert.equal(kind("git commit -F - <<'EOF'\nvercel --prod\nEOF"), null);
  assert.equal(kind("ls -la"), null);
});

test("publicationRefusal : l'acte exact est cité", () => {
  const r = publicationRefusal("vercel", "vercel --prod", "Ouvre une demande d'approbation.");
  assert.match(r, /vercel/);
  assert.match(r, /--- acte ---\nvercel --prod\n--- fin ---/);
});
