import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRACE_PID_MORT_MS,
  PEREMPTION_MS,
  VerrouAnnule,
  VerrouTropLong,
  avecVerrou,
  contenuVerrou,
  lancerSansBloquer,
  lireVerrou,
  pidVivantReel,
  prendreVerrou,
  verrouPerime,
} from "./file-lock.ts";

const tmp = (): string => join(mkdtempSync(join(tmpdir(), "flock-")), "locks", "tests.lock");

test("contenu / lecture d'un verrou", () => {
  assert.equal(contenuVerrou(12, 345), "12 345\n");
  assert.deepEqual(lireVerrou("12 345\n"), { pid: 12, at: 345 });
  assert.equal(lireVerrou(""), null);
  assert.equal(lireVerrou("abc"), null);
  assert.equal(lireVerrou("0 5"), null);
});

test("verrouPerime : silence long, pid mort après grâce, illisible après grâce", () => {
  const now = 10_000_000;
  const vivant = () => true;
  const mort = () => false;
  assert.equal(verrouPerime({ pid: 1, at: now - PEREMPTION_MS - 1 }, now, vivant), true);
  assert.equal(verrouPerime({ pid: 1, at: now - 60_000 }, now, vivant), false);
  assert.equal(verrouPerime({ pid: 1, at: now - 60_000 }, now, mort), false); // pid mort mais pas assez de silence
  assert.equal(verrouPerime({ pid: 1, at: now - GRACE_PID_MORT_MS - 1 }, now, mort), true);
  assert.equal(verrouPerime({ pid: 1, at: now - GRACE_PID_MORT_MS - 1 }, now, vivant), false);
  assert.equal(verrouPerime(null, now, vivant, 1000), false);
  assert.equal(verrouPerime(null, now, vivant, 120_000), true);
});

test("pidVivantReel : notre pid vit, un pid énorme non", () => {
  assert.equal(pidVivantReel(process.pid), true);
  assert.equal(pidVivantReel(2 ** 22 + 12345), false);
});

test("prendre / rendre : le fichier existe pendant la détention seulement", async () => {
  const f = tmp();
  const rendre = await prendreVerrou(f);
  assert.equal(existsSync(f), true);
  rendre();
  assert.equal(existsSync(f), false);
});

test("un verrou pris et vivant fait attendre, puis lève VerrouTropLong", async () => {
  const f = tmp();
  const t0 = 1_000_000;
  let now = t0;
  const premier = await prendreVerrou(f, { maintenant: () => t0, pid: 111 });
  let attentes = 0;
  let signale = 0;
  await assert.rejects(
    prendreVerrou(f, {
      maintenant: () => now,
      pidVivant: () => true,
      pid: 222,
      attenteMaxMs: 60_000,
      sondageMs: 20_000,
      dormir: async (ms) => {
        attentes++;
        now += ms;
      },
      surAttente: () => signale++,
    }),
    VerrouTropLong,
  );
  assert.equal(signale, 1);
  assert.ok(attentes >= 3);
  premier();
});

test("un verrou périmé (silence long) est volé", async () => {
  const f = tmp();
  await prendreVerrou(f, { maintenant: () => 1, pid: 111 }).then(() => undefined); // heure ancienne, jamais rendu
  const rendre = await prendreVerrou(f, { maintenant: () => 1 + PEREMPTION_MS + 5, pidVivant: () => true, pid: 222 });
  assert.match(readFileSync(f, "utf8"), /^222 /);
  rendre();
});

test("rendre ne retire pas un verrou volé entre-temps ; renouveler non plus", async () => {
  const f = tmp();
  const rendre = await prendreVerrou(f, { pid: 111 });
  writeFileSync(f, contenuVerrou(999, Date.now()));
  assert.equal(rendre.renouveler(), false);
  rendre();
  assert.equal(existsSync(f), true);
});

test("renouveler réécrit l'heure quand le verrou est à nous", async () => {
  const f = tmp();
  let now = 100;
  const rendre = await prendreVerrou(f, { maintenant: () => now, pid: 7 });
  now = 5000;
  assert.equal(rendre.renouveler(), true);
  assert.deepEqual(lireVerrou(readFileSync(f, "utf8")), { pid: 7, at: 5000 });
  rendre();
  assert.equal(existsSync(f), false);
});

test("avecVerrou rend le verrou même si fn lève", async () => {
  const f = tmp();
  await assert.rejects(avecVerrou(f, () => { throw new Error("boum"); }, { renouvellementMs: 0 }), /boum/);
  assert.equal(existsSync(f), false);
  assert.equal(await avecVerrou(f, () => 42, { renouvellementMs: 0 }), 42);
});

test("une attente annulée lève VerrouAnnule", async () => {
  const f = tmp();
  const premier = await prendreVerrou(f, { pid: 1 });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(prendreVerrou(f, { signal: ctl.signal, pidVivant: () => true }), VerrouAnnule);
  premier();
});

test("lancerSansBloquer : sortie, code, délai dépassé avec crochet", async () => {
  const ok = await lancerSansBloquer(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0,'utf8').toUpperCase())"], { input: "abc", timeoutMs: 10_000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "ABC");
  let appele = 0;
  const lent = await lancerSansBloquer(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { timeoutMs: 200, auDelai: () => { appele++; throw new Error("ignoré"); } });
  assert.equal(lent.delaiDepasse, true);
  assert.equal(lent.status, null);
  assert.equal(appele, 1);
  const ctl = new AbortController();
  ctl.abort();
  assert.equal((await lancerSansBloquer(process.execPath, ["-e", ""], { timeoutMs: 1000, signal: ctl.signal })).annule, true);
});
