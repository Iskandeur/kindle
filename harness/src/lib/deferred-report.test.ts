import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSendTime, formatSendTime, sendAtFor, textProblems, decideDeposit, decideTick, runSenderTick, readPending, readSends,
  writePending, recordSent, reportCarriedFor, appendLine, fallbackText, HEARTBEAT_KEY, PENDING_KEY, SENDS_KEY,
  PREFERRED_ATTEMPTS, MAX_ATTEMPTS, SENDS_KEPT, type DeferStore, type PendingReport,
} from "./deferred-report.ts";

const TZ = "Europe/Paris";
const NIGHT = Date.parse("2026-10-10T03:00:00Z"); // 05:00 à Paris
const SEND_AT = Date.parse("2026-10-10T05:30:00Z"); // 07:30 à Paris

function memStore(): DeferStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => void m.set(k, v), deleteSetting: (k) => void m.delete(k) };
}
const pending = (over: Partial<PendingReport> = {}): PendingReport => ({
  chainId: "dream-2026-10-10", text: "rapport", depositedMs: NIGHT, sendAtMs: SEND_AT, attempts: 0, ...over,
});

test("heure d'envoi : parse, format, futur du jour, passée = tout de suite, off", () => {
  assert.deepEqual(parseSendTime("7h30"), { hh: 7, mm: 30 });
  assert.deepEqual(parseSendTime("07:05"), { hh: 7, mm: 5 });
  assert.deepEqual(parseSendTime("n'importe quoi"), { hh: 7, mm: 30 });
  assert.deepEqual(parseSendTime("25:00"), { hh: 7, mm: 30 });
  assert.equal(parseSendTime(" OFF "), "off");
  assert.equal(formatSendTime({ hh: 7, mm: 5 }), "07:05");
  assert.equal(sendAtFor(NIGHT, { hh: 7, mm: 30 }, TZ), SEND_AT);
  const late = Date.parse("2026-10-10T18:00:00Z");
  assert.equal(sendAtFor(late, { hh: 7, mm: 30 }, TZ), late);
  assert.equal(sendAtFor(NIGHT, "off", TZ), NIGHT);
  // autre fuseau : 07:30 à Tokyo = 22:30 UTC la veille
  assert.equal(sendAtFor(Date.parse("2026-10-09T20:00:00Z"), { hh: 7, mm: 30 }, "Asia/Tokyo"), Date.parse("2026-10-09T22:30:00Z"));
});

test("textProblems", () => {
  assert.deepEqual(textProblems("ok"), []);
  assert.match(textProblems("  ").join(), /vide/);
  assert.match(textProblems("**gras**", { forbidDoubleAsterisk: true }).join(), /UNE astérisque/);
  assert.deepEqual(textProblems("**gras**"), []);
  assert.match(textProblems("x".repeat(30), { maxChars: 10 }).join(), /plafond 10/);
});

const base = {
  nowMs: NIGHT, chainId: "dream-2026-10-10", text: "rapport", heartbeatMs: NIGHT - 30_000, pending: null, sends: [], time: { hh: 7, mm: 30 } as const, tz: TZ,
};

test("decideDeposit : ok, texte, doublon, déjà en file, porteur absent ou périmé", () => {
  const ok = decideDeposit(base);
  assert.ok(ok.ok && ok.pending.sendAtMs === SEND_AT);
  assert.deepEqual(decideDeposit({ ...base, text: "" }).ok, false);
  const dup = decideDeposit({ ...base, sends: [{ chainId: base.chainId } as never] });
  assert.ok(!dup.ok && dup.code === 2 && /doublon/.test(dup.reason));
  const queued = decideDeposit({ ...base, pending: pending() });
  assert.ok(!queued.ok && queued.code === 2 && /--replace/.test(queued.reason));
  assert.ok(decideDeposit({ ...base, pending: pending(), replace: true }).ok);
  const none = decideDeposit({ ...base, heartbeatMs: null });
  assert.ok(!none.ok && none.code === 3);
  const stale = decideDeposit({ ...base, heartbeatMs: NIGHT - 10 * 60_000 });
  assert.ok(!stale.ok && stale.code === 3 && /dernier passage/.test(stale.reason));
});

test("decideTick : idle, wait, doublon, envoi préféré, repli, sonde, dernier recours", () => {
  const t = { sends: [], preferredChatId: "pref", fallbackChatId: "main" };
  assert.equal(decideTick({ ...t, nowMs: SEND_AT, pending: null }).kind, "idle");
  assert.deepEqual(decideTick({ ...t, nowMs: NIGHT, pending: pending() }), { kind: "wait", untilMs: SEND_AT });
  assert.equal(decideTick({ ...t, nowMs: SEND_AT, pending: pending(), sends: [{ chainId: "dream-2026-10-10" } as never] }).kind, "drop-duplicate");
  assert.deepEqual(decideTick({ ...t, nowMs: SEND_AT, pending: pending() }), { kind: "send", chatId: "pref", via: "prefere", text: "rapport" });
  const repli = decideTick({ ...t, nowMs: SEND_AT, pending: pending({ attempts: PREFERRED_ATTEMPTS, lastError: "boom" }) });
  assert.ok(repli.kind === "send" && repli.via === "repli" && repli.chatId === "main" && repli.text.startsWith("(canal habituel injoignable : boom)"));
  const noPref = decideTick({ ...t, preferredChatId: null, nowMs: SEND_AT, pending: pending() });
  assert.ok(noPref.kind === "send" && noPref.chatId === "main" && noPref.text === "rapport");
  assert.deepEqual(decideTick({ ...t, nowMs: SEND_AT, pending: pending({ inFlightMs: SEND_AT - 1 }) }), { kind: "probe", chatId: "pref" });
  assert.equal(decideTick({ ...t, nowMs: SEND_AT, pending: pending({ attempts: MAX_ATTEMPTS }) }).kind, "last-resort");
  assert.equal(decideTick({ ...t, fallbackChatId: null, preferredChatId: null, nowMs: SEND_AT, pending: pending() }).kind, "last-resort");
  assert.match(fallbackText("t", null), /^\(canal habituel injoignable\)/);
});

function deps(store: DeferStore, now: number, over: Record<string, unknown> = {}) {
  const calls = { sent: [] as Array<[string, string]>, probed: [] as string[], resort: [] as string[] };
  return {
    calls,
    d: {
      store, now: () => now, tz: TZ, preferredChatId: "pref", fallbackChatId: "main", log: () => {},
      send: async (c: string, t: string) => { calls.sent.push([c, t]); return "m1"; },
      probe: async (c: string) => { calls.probed.push(c); return null; },
      lastResort: async (t: string) => { calls.resort.push(t); return true; },
      ...over,
    },
  };
}

test("runSenderTick : signe le battement, attend, envoie, enregistre et retire de la file", async () => {
  const s = memStore();
  writePending(s, pending());
  const early = deps(s, NIGHT);
  assert.equal(await runSenderTick(early.d), "wait");
  assert.equal(s.m.get(HEARTBEAT_KEY), String(NIGHT));
  assert.equal(early.calls.sent.length, 0);
  const on = deps(s, SEND_AT);
  assert.equal(await runSenderTick(on.d), "send");
  assert.deepEqual(on.calls.sent, [["pref", "rapport"]]);
  assert.equal(readPending(s), null);
  assert.equal(readSends(s)[0].via, "prefere");
  assert.ok(reportCarriedFor(s, "dream-2026-10-10"));
  assert.ok(!reportCarriedFor(s, "dream-2026-10-11"));
  assert.ok(!reportCarriedFor(s, null));
});

test("runSenderTick : un échec compte la tentative et libère le marqueur de vol", async () => {
  const s = memStore();
  writePending(s, pending());
  const r = deps(s, SEND_AT, { send: async () => { throw new Error("réseau"); } });
  assert.equal(await runSenderTick(r.d), "send");
  const p = readPending(s)!;
  assert.equal(p.attempts, 1);
  assert.equal(p.inFlightMs, null);
  assert.equal(p.lastError, "réseau");
});

test("runSenderTick : tentative coupée en vol, la sonde évite le doublon ou autorise le renvoi", async () => {
  const s = memStore();
  writePending(s, pending({ inFlightMs: SEND_AT - 5 }));
  const found = deps(s, SEND_AT, { probe: async () => "deja-la" });
  assert.equal(await runSenderTick(found.d), "probe");
  assert.equal(readPending(s), null);
  assert.equal(readSends(s)[0].messageId, "deja-la");
  assert.equal(found.calls.sent.length, 0);
  const s2 = memStore();
  writePending(s2, pending({ inFlightMs: SEND_AT - 5 }));
  const absent = deps(s2, SEND_AT);
  await runSenderTick(absent.d);
  assert.equal(readPending(s2)!.inFlightMs, null);
  assert.equal(absent.calls.sent.length, 0);
  const s3 = memStore();
  writePending(s3, pending({ inFlightMs: SEND_AT - 5 }));
  const boom = deps(s3, SEND_AT, { probe: async () => { throw new Error("sonde HS"); } });
  await runSenderTick(boom.d);
  assert.equal(readPending(s3)!.inFlightMs, SEND_AT - 5);
});

test("runSenderTick : doublon retiré, dernier recours puis abandon", async () => {
  const s = memStore();
  writePending(s, pending());
  s.m.set(SENDS_KEY, JSON.stringify([{ chainId: "dream-2026-10-10" }]));
  assert.equal(await runSenderTick(deps(s, SEND_AT).d), "drop-duplicate");
  assert.equal(readPending(s), null);
  const s2 = memStore();
  writePending(s2, pending({ attempts: MAX_ATTEMPTS, lastError: "x" }));
  const r = deps(s2, SEND_AT);
  assert.equal(await runSenderTick(r.d), "last-resort");
  assert.equal(r.calls.resort.length, 1);
  assert.equal(readPending(s2), null);
  assert.equal(readSends(s2)[0].via, "secours");
  assert.equal(s2.m.has(PENDING_KEY), false);
});

test("recordSent borne l'historique ; état corrompu = vide", () => {
  const s = memStore();
  for (let i = 0; i < SENDS_KEPT + 5; i++) recordSent(s, { chainId: `c${i}` } as never);
  assert.equal(readSends(s).length, SENDS_KEPT);
  assert.equal(readSends(s).at(-1)!.chainId, `c${SENDS_KEPT + 4}`);
  s.m.set(PENDING_KEY, "{pas du json");
  s.m.set(SENDS_KEY, "42");
  assert.equal(readPending(s), null);
  assert.deepEqual(readSends(s), []);
});

test("appendLine : ajoute une fois, ignore l'absent ou l'illisible", () => {
  assert.equal(appendLine("texte", "Bureau : 3 ouverts\nautre", "Bureau :"), "texte\n\nBureau : 3 ouverts");
  assert.equal(appendLine("texte\n- Bureau : déjà là", "Bureau : 3", "Bureau :"), "texte\n- Bureau : déjà là");
  assert.equal(appendLine("texte", null, "Bureau :"), "texte");
  assert.equal(appendLine("texte", "✗ erreur", "Bureau :"), "texte");
});
