import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GARDE_FINIS_MS,
  LIMITE_DEFAUT_MS,
  ajouterVeilleur,
  commandePermise,
  ecrireVeilleurs,
  elaguer,
  erreurSonde,
  evaluer,
  fusionnerRegistre,
  lireVeilleurs,
  nouvelId,
  quoiParDefaut,
  tour,
  type Levee,
  type SondeDeps,
  type Veilleur,
} from "./veilleurs.ts";

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);

function deps(over: Partial<SondeDeps> = {}): SondeDeps {
  return {
    now: () => NOW,
    fetchUrl: async () => ({ status: 200, body: "ok" }),
    run: async () => 0,
    prState: async () => "open",
    ...over,
  };
}

function veilleur(over: Partial<Veilleur> = {}): Veilleur {
  return {
    id: "V1",
    cle: "T-1",
    quoi: "attente",
    sonde: { type: "url", url: "https://exemple.test/sante" },
    depuis: NOW - 1000,
    limite: NOW + 3_600_000,
    creePar: "agent",
    ...over,
  };
}

function levee(over: Partial<Levee> = {}): Levee & { vus: string[]; pasVus: string[] } {
  const vus: string[] = [];
  const pasVus: string[] = [];
  return {
    vus,
    pasVus,
    vu: async (v, p) => (vus.push(`${v.cle}|${p}`), true),
    pasVu: async (v, d) => (pasVus.push(`${v.cle}|${d}`), true),
    ...over,
  };
}

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "veilleurs-"));
  return { dir, path: join(dir, "veilleurs.json") };
}

test("commandePermise : préfixe exact, aucune option après le verbe, pas de shell", () => {
  assert.equal(commandePermise(["systemctl", "is-active", "mon-service"]), true);
  assert.equal(commandePermise(["git", "ls-remote", "https://exemple.test/r.git"]), true);
  assert.equal(commandePermise(["systemctl", "is-active", "-H", "autre-hote"]), false);
  assert.equal(commandePermise(["git", "ls-remote", "--upload-pack=touch /x", "u"]), false);
  assert.equal(commandePermise(["systemctl", "restart", "x"]), false);
  assert.equal(commandePermise(["rm", "-rf", "/"]), false);
  assert.equal(commandePermise([]), false);
  assert.equal(commandePermise(["test", "-e", "/etc/hosts"]), true);
  assert.equal(commandePermise(["test", "--help"]), false);
  assert.equal(commandePermise(["test", "x".repeat(301)]), false);
});

test("erreurSonde et quoiParDefaut", () => {
  assert.equal(erreurSonde({ type: "url", url: "ftp://x" }) !== null, true);
  assert.equal(erreurSonde({ type: "url", url: "https://x.test" }), null);
  assert.equal(erreurSonde({ type: "pr", pr: "mauvais" }) !== null, true);
  assert.equal(erreurSonde({ type: "pr", pr: "o/r#12" }), null);
  assert.match(erreurSonde({ type: "commande", argv: ["rm", "x"] })!, /liste blanche/);
  assert.equal(erreurSonde({ type: "custom", nom: "a b" }) !== null, true);
  assert.match(quoiParDefaut({ type: "url", url: "https://x.test", contient: "ready" }), /contient « ready »/);
  assert.match(quoiParDefaut({ type: "url", url: "https://x.test" }), /répond 200/);
  assert.match(quoiParDefaut({ type: "pr", pr: "o/r#1" }), /fusionnée/);
});

test("evaluer : url par statut, par contenu ; pr ; commande ; custom", async () => {
  assert.equal((await evaluer(veilleur(), deps())).vu, true);
  assert.equal((await evaluer(veilleur(), deps({ fetchUrl: async () => ({ status: 503, body: "" }) }))).vu, false);
  const contient = veilleur({ sonde: { type: "url", url: "https://x.test", contient: "v2" } });
  assert.equal((await evaluer(contient, deps({ fetchUrl: async () => ({ status: 200, body: "version v2 en ligne" }) }))).vu, true);
  assert.equal((await evaluer(contient, deps({ fetchUrl: async () => ({ status: 200, body: "version v1" }) }))).vu, false);
  assert.equal((await evaluer(contient, deps({ fetchUrl: async () => ({ status: 500, body: "v2" }) }))).vu, false, "une page d'erreur qui cite le mot ne compte pas");

  const pr = veilleur({ sonde: { type: "pr", pr: "o/r#1" } });
  assert.equal((await evaluer(pr, deps({ prState: async () => "merged" }))).vu, true);
  assert.equal((await evaluer(pr, deps({ prState: async () => "closed" }))).vu, false);
  await assert.rejects(evaluer(pr, deps({ prState: async () => null })), /illisible/);

  const cmd = veilleur({ sonde: { type: "commande", argv: ["systemctl", "is-active", "svc"] } });
  assert.equal((await evaluer(cmd, deps({ run: async () => 0 }))).vu, true);
  assert.equal((await evaluer(cmd, deps({ run: async () => 3 }))).vu, false);

  const cu = veilleur({ sonde: { type: "custom", nom: "mienne", args: "a" } });
  const r = await evaluer(cu, deps({ custom: { mienne: async (a) => ({ vu: a === "a", preuve: "ok" }) } }));
  assert.equal(r.vu, true);
  await assert.rejects(evaluer(cu, deps()), /non inscrite/);
});

test("evaluer : une commande hors liste blanche glissée dans le registre LÈVE sans être lancée", async () => {
  let lancee = false;
  const v = veilleur({ sonde: { type: "commande", argv: ["rm", "-rf", "x"] } });
  await assert.rejects(evaluer(v, deps({ run: async () => ((lancee = true), 0) })), /liste blanche/);
  assert.equal(lancee, false);
});

test("tour : vu → levée avec la preuve, veilleur rangé", async () => {
  const l = levee();
  const vs = [veilleur()];
  const b = await tour(vs, deps(), l);
  assert.deepEqual(b.vus, ["V1 T-1"]);
  assert.equal(vs[0]!.fini?.vu, true);
  assert.match(l.vus[0]!, /^T-1\|https:\/\/exemple\.test\/sante → HTTP 200/);
});

test("tour : pas vu avant la limite → rien ne bouge, l'état est noté", async () => {
  const l = levee();
  const vs = [veilleur()];
  const b = await tour(vs, deps({ fetchUrl: async () => ({ status: 404, body: "" }) }), l);
  assert.equal(b.evalues, 1);
  assert.equal(vs[0]!.fini, undefined);
  assert.match(vs[0]!.dernierEtat!, /404/);
  assert.equal(vs[0]!.dernierTour, NOW);
  assert.equal(l.vus.length + l.pasVus.length, 0);
});

test("tour : une lecture en échec n'est PAS un « pas vu » avant la limite", async () => {
  const l = levee();
  const vs = [veilleur()];
  const b = await tour(vs, deps({ fetchUrl: async () => { throw new Error("réseau coupé"); } }), l);
  assert.equal(b.erreurs.length, 1);
  assert.match(vs[0]!.dernierEtat!, /lecture en échec : réseau coupé/);
  assert.equal(vs[0]!.fini, undefined);
  assert.equal(l.pasVus.length, 0);
});

test("tour : limite passée sans rien vu → pasVu avec le dernier relevé, sans re-sonder", async () => {
  const l = levee();
  let sondes = 0;
  const vs = [veilleur({ limite: NOW - 1, dernierEtat: "dernier relevé : 404" })];
  const b = await tour(vs, deps({ fetchUrl: async () => ((sondes++), { status: 200, body: "" }) }), l);
  assert.deepEqual(b.pasVus, ["V1 T-1"]);
  assert.equal(sondes, 0, "après la limite on ne sonde plus : un « vu » tardif ne ressuscite pas l'attente");
  assert.equal(l.pasVus[0], "T-1|dernier relevé : 404");
  assert.equal(vs[0]!.fini?.vu, false);
});

test("tour : une levée qui échoue ne range pas le veilleur (retenté au tour suivant)", async () => {
  const vs = [veilleur()];
  await tour(vs, deps(), levee({ vu: async () => { throw new Error("tableau injoignable"); } }));
  assert.equal(vs[0]!.fini, undefined);
  const l = levee();
  await tour(vs, deps(), l);
  assert.equal(vs[0]!.fini?.vu, true);
  assert.equal(l.vus.length, 1);
  await tour(vs, deps(), l);
  assert.equal(l.vus.length, 1, "un veilleur fini n'est plus évalué");
});

test("registre : ajout, doublon identique rendu tel quel, ids croissants, limite par défaut", () => {
  const { dir, path } = tmp();
  try {
    const a = ajouterVeilleur(path, { cle: "T-1", sonde: { type: "url", url: "https://x.test" } }, NOW);
    assert.equal(a.id, "V1");
    assert.equal(a.limite, NOW + LIMITE_DEFAUT_MS);
    assert.match(a.quoi, /répond 200/);
    const meme = ajouterVeilleur(path, { cle: "T-1", sonde: { type: "url", url: "https://x.test" } }, NOW + 5);
    assert.equal(meme.id, "V1");
    const autre = ajouterVeilleur(path, { cle: "T-2", sonde: { type: "url", url: "https://x.test" } }, NOW);
    assert.equal(autre.id, "V2");
    assert.equal(lireVeilleurs(path).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ajout : sonde invalide, cible vide, limite passée → refus, rien d'écrit", () => {
  const { dir, path } = tmp();
  try {
    assert.throws(() => ajouterVeilleur(path, { cle: "T-1", sonde: { type: "commande", argv: ["rm", "x"] } }, NOW), /liste blanche/);
    assert.throws(() => ajouterVeilleur(path, { cle: " ", sonde: { type: "url", url: "https://x.test" } }, NOW), /cible/);
    assert.throws(() => ajouterVeilleur(path, { cle: "T-1", sonde: { type: "url", url: "https://x.test" }, limite: NOW - 1 }, NOW), /déjà passée/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lireVeilleurs : fichier absent, corrompu ou d'une autre forme → liste vide", () => {
  const { dir, path } = tmp();
  try {
    assert.deepEqual(lireVeilleurs(path), []);
    writeFileSync(path, "{pas du json");
    assert.deepEqual(lireVeilleurs(path), []);
    writeFileSync(path, '{"a":1}');
    assert.deepEqual(lireVeilleurs(path), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fusionnerRegistre : un veilleur ajouté PENDANT le tour n'est pas écrasé", () => {
  const { dir, path } = tmp();
  try {
    const v1 = ajouterVeilleur(path, { cle: "T-1", sonde: { type: "url", url: "https://x.test" } }, NOW);
    const enVol = { ...v1 }; // copie lue au début du tour
    ajouterVeilleur(path, { cle: "T-2", sonde: { type: "url", url: "https://y.test" } }, NOW); // ajouté pendant le tour
    enVol.dernierEtat = "HTTP 200";
    fusionnerRegistre(path, [enVol], NOW);
    const apres = lireVeilleurs(path);
    assert.deepEqual(apres.map((v) => v.id), ["V1", "V2"]);
    assert.equal(apres[0]!.dernierEtat, "HTTP 200");
    assert.ok(!existsSync(`${path}.tmp`), "l'écriture atomique ne laisse pas de fichier temporaire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("élagage : les finis de plus de 30 jours partent, les actifs restent", () => {
  const vieux = veilleur({ id: "V1", fini: { at: NOW - GARDE_FINIS_MS - 1, vu: true, preuve: "p", leve: true } });
  const recent = veilleur({ id: "V2", fini: { at: NOW - 1000, vu: false, preuve: "p", leve: true } });
  const actif = veilleur({ id: "V3" });
  assert.deepEqual(elaguer([vieux, recent, actif], NOW).map((v) => v.id), ["V2", "V3"]);
  const { dir, path } = tmp();
  try {
    ecrireVeilleurs(path, [vieux, actif]);
    fusionnerRegistre(path, [], NOW);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).map((v: Veilleur) => v.id), ["V3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nouvelId : suit le plus grand, ignore les formes inattendues", () => {
  assert.equal(nouvelId([]), "V1");
  assert.equal(nouvelId([veilleur({ id: "V7" }), veilleur({ id: "x" }), veilleur({ id: "V2" })]), "V8");
});
