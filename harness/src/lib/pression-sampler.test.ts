import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const mkTestTmpDir = (prefixe: string): string => mkdtempSync(join(tmpdir(), prefixe));
const rmTestTmpDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });
import {
  composerEchantillon,
  ecrireTournant,
  memDisponibleMo,
  parseMeminfo,
  parsePsi,
  passerEchantillon,
  plusGrosRss,
  type SourcesProc,
} from "./pression-sampler.ts";

const PSI_MEM = "some avg10=1.50 avg60=0.80 avg300=0.20 total=123456\nfull avg10=0.40 avg60=0.10 avg300=0.05 total=7890\n";
const PSI_CPU = "some avg10=12.00 avg60=9.00 avg300=3.00 total=999\n"; // pas de ligne `full` sur certains noyaux
const MEMINFO = "MemTotal:        4096000 kB\nMemFree:          100000 kB\nMemAvailable:     524288 kB\nSwapTotal:       1048576 kB\nSwapFree:         262144 kB\n";

const statut = (nom: string, rssKb: number | null) => `Name:\t${nom}\n${rssKb === null ? "" : `VmRSS:\t${rssKb} kB\n`}`;

test("parsePsi : some et full, full absent toléré, texte illisible → null", () => {
  const m = parsePsi(PSI_MEM)!;
  assert.equal(m.someAvg10, 1.5);
  assert.equal(m.someTotalUs, 123456);
  assert.equal(m.fullTotalUs, 7890);
  const c = parsePsi(PSI_CPU)!;
  assert.equal(c.someAvg60, 9);
  assert.equal(c.fullAvg10, null);
  assert.equal(parsePsi("n'importe quoi"), null);
  assert.equal(parsePsi(null), null);
});

test("parseMeminfo : Mo arrondis, MemAvailable manquant → null (pas de zéro menteur)", () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { totalMo: 4000, disponibleMo: 512, swapTotalMo: 1024, swapLibreMo: 256 });
  assert.equal(memDisponibleMo(MEMINFO), 512);
  assert.equal(parseMeminfo("MemTotal: 1 kB\n"), null);
  assert.equal(memDisponibleMo(null), null);
});

test("plusGrosRss : les N plus gros, les threads noyau (sans VmRSS) écartés", () => {
  const top = plusGrosRss(
    [
      { pid: 1, texte: statut("systemd", 10_240) },
      { pid: 2, texte: statut("kthreadd", null) },
      { pid: 3, texte: statut("dockerd", 204_800) },
      { pid: 4, texte: statut("node", 1_048_576) },
    ],
    2,
  );
  assert.deepEqual(top, [
    { pid: 4, nom: "node", rssMo: 1024 },
    { pid: 3, nom: "dockerd", rssMo: 200 },
  ]);
});

const SRC: SourcesProc = {
  psiCpu: PSI_CPU,
  psiMemoire: PSI_MEM,
  psiIo: null,
  meminfo: MEMINFO,
  loadavg: "21.50 12.00 6.25 3/400 1234\n",
  uptime: "86400.55 1000.00\n",
  statuts: [{ pid: 9, texte: statut("waha", 3_400_000) }],
};

test("composerEchantillon : tout est lu, un /proc muet donne null sans lever", () => {
  const e = composerEchantillon(SRC, 1000);
  assert.equal(e.ts, 1000);
  assert.deepEqual(e.charge, [21.5, 12, 6.25]);
  assert.equal(e.uptimeS, 86401);
  assert.equal(e.mem?.disponibleMo, 512);
  assert.equal(e.psi.io, null);
  assert.equal(e.top[0]?.nom, "waha");
  const vide = composerEchantillon({ ...SRC, loadavg: null, uptime: null, meminfo: null, psiMemoire: null, statuts: [] }, 1);
  assert.equal(vide.charge, null);
  assert.equal(vide.uptimeS, null);
  assert.equal(vide.mem, null);
  assert.deepEqual(vide.top, []);
});

test("ecrireTournant : le fichier est borné (passe en .1, l'ancien .1 est écrasé)", () => {
  const dir = mkTestTmpDir("pression-");
  try {
    const f = join(dir, "p.jsonl");
    for (let i = 0; i < 50; i++) ecrireTournant(f, `{"i":${i}}`, 100);
    const taille = (p: string) => readFileSync(p, "utf8").length;
    assert.ok(existsSync(`${f}.1`));
    assert.ok(taille(f) < 100 + 20 && taille(`${f}.1`) < 100 + 20, "chacun des deux fichiers reste sous la borne (à une ligne près)");
    assert.ok(readFileSync(f, "utf8").includes('"i":49'), "la dernière ligne est dans le fichier courant");
  } finally {
    rmTestTmpDir(dir);
  }
});

test("passerEchantillon : écrit une ligne ET le battement ; un battement qui lève n'empêche pas l'échantillon", () => {
  const dir = mkTestTmpDir("pression-");
  try {
    const f = join(dir, "p.jsonl");
    const bats: number[] = [];
    const e = passerEchantillon({ chemin: f, lire: () => SRC, now: () => 5000, battement: (n) => bats.push(n) });
    assert.equal(e?.ts, 5000);
    assert.deepEqual(bats, [5000]);
    assert.equal(JSON.parse(readFileSync(f, "utf8").trim()).mem.disponibleMo, 512);
    const e2 = passerEchantillon({ chemin: f, lire: () => SRC, now: () => 6000, battement: () => { throw new Error("base fermée"); } });
    assert.equal(e2?.ts, 6000);
    assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 2);
    // lecture qui lève → null, jamais d'exception
    writeFileSync(join(dir, "x"), "");
    assert.equal(passerEchantillon({ chemin: f, lire: () => { throw new Error("proc illisible"); }, now: () => 7000 }), null);
  } finally {
    rmTestTmpDir(dir);
  }
});
