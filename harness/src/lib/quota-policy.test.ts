import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StreamJsonCollector, formatQuotaLines, parseRateLimitEvent, readQuota, storeQuota, toEpochMs, type QuotaSnapshot,
} from "./claude-quota.ts";
import {
  ALERT_STATE_KEY, attributeByOrigin, decideQuotaPolicy, formatAttribution, jobBypassesDefer, projectAll, quotaAlerts,
  quotaContextLine, quotaPolicyConfig, recordQuotaMeasure, weeklyRate, type QuotaLogRow, type QuotaStore,
} from "./quota-policy.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-03-04T12:00:00Z");
const CFG = quotaPolicyConfig({});

function memStore(): QuotaStore & { rows: QuotaLogRow[] } {
  const m = new Map<string, string>();
  const rows: QuotaLogRow[] = [];
  return {
    rows,
    getSetting: (k) => m.get(k) ?? null,
    setSetting: (k, v) => void m.set(k, v),
    recordQuotaLog: (r) => (rows.push({ ...r, id: rows.length + 1 }), rows.length),
    quotaLogSince: (s) => rows.filter((r) => r.ts >= s),
  };
}

const snap = (five: number, seven: number, fiveReset = NOW + 2 * H, sevenReset = NOW + 3 * 24 * H): QuotaSnapshot => ({
  fiveHour: { utilization: five, resetsAtMs: fiveReset },
  sevenDay: { utilization: seven, resetsAtMs: sevenReset },
  status: "allowed", rateLimitType: null, isUsingOverage: false, overageStatus: null, resetsAtMs: null,
});

test("toEpochMs : secondes et millisecondes, rejet du bruit", () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs("1700000000"), 1_700_000_000_000);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs("x"), null);
});

test("parseRateLimitEvent : fenêtres lues, évènement vide ignoré, autre type ignoré", () => {
  const ev = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1_800_000_000 } } } };
  const s = parseRateLimitEvent(ev)!;
  assert.equal(s.fiveHour!.utilization, 0.4);
  assert.equal(s.fiveHour!.resetsAtMs, 1_800_000_000_000);
  assert.equal(s.sevenDay, null);
  assert.equal(parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }), null);
  assert.equal(parseRateLimitEvent({ type: "result" }), null);
});

test("StreamJsonCollector : result, quota (premier et dernier), modèle d'init, texte brut ; chunks coupés", () => {
  const c = new StreamJsonCollector();
  const ev = (u: number) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: u, resetsAt: 1_800_000_000 } } } });
  const text = [JSON.stringify({ type: "system", subtype: "init", model: "m1" }), ev(0.1), "bruit", ev(0.2), JSON.stringify({ type: "result", result: "ok" })].join("\n");
  c.push(text.slice(0, 40));
  c.push(Buffer.from(text.slice(40)));
  c.finish();
  assert.equal(c.initModel, "m1");
  assert.equal(c.quotaEvents, 2);
  assert.equal(c.firstQuota!.fiveHour!.utilization, 0.1);
  assert.equal(c.quota!.fiveHour!.utilization, 0.2);
  assert.equal(c.result!.result, "ok");
  assert.equal(c.nonJson, "bruit");
});

test("StreamJsonCollector : repli json multi-lignes", () => {
  const c = new StreamJsonCollector();
  c.push('{\n  "type": "result",\n  "result": "ok"\n}');
  c.finish();
  assert.equal(c.result!.result, "ok");
});

test("storeQuota / readQuota : aller-retour, formatQuotaLines", () => {
  const s = memStore();
  storeQuota(s, snap(0.3, 0.5), NOW, "job");
  const q = readQuota(s);
  assert.equal(q.fiveHour!.utilization, 0.3);
  assert.equal(q.seenAtMs, NOW);
  assert.equal(q.isUsingOverage, false);
  assert.match(formatQuotaLines(q, NOW).join("\n"), /quota 5 h : 30 %/);
  assert.match(formatQuotaLines(readQuota(memStore()), NOW)[0]!, /aucune mesure/);
});

test("politique : 5 h haute = différer ; basse en fin de fenêtre = consommer ; off et inconnu sans levier", () => {
  const s = memStore();
  storeQuota(s, snap(0.9, 0.2), NOW, "x");
  const q = readQuota(s);
  const p = decideQuotaPolicy(q, projectAll(q, [], NOW, CFG), NOW, CFG);
  assert.equal(p.mode, "différer");
  assert.equal(p.deferJobs, true);
  assert.equal(p.preemptFallback, false);
  const s2 = memStore();
  storeQuota(s2, snap(0.1, 0.2, NOW + 30 * 60_000, NOW + 5 * 24 * H), NOW, "x");
  const q2 = readQuota(s2);
  assert.equal(decideQuotaPolicy(q2, projectAll(q2, [], NOW, CFG), NOW, CFG).mode, "consommer");
  assert.equal(decideQuotaPolicy(q2, projectAll(q2, [], NOW, CFG), NOW, CFG, false).mode, "off");
  assert.equal(decideQuotaPolicy(readQuota(memStore()), { five: null, seven: null }, NOW, CFG).mode, "inconnu");
  assert.equal(decideQuotaPolicy(q, projectAll(q, [], NOW, CFG), NOW, CFG).deferUntilMs, NOW + 2 * H);
});

test("semaine projetée pleine : le fond passe au modèle léger, puis l'effort est plafonné", () => {
  const sevenReset = NOW + 2 * 24 * H; // 5 j écoulés
  const pts = (k: number, u: number) => ({ ts: NOW - k, util: u, resetMs: sevenReset });
  const q = { fiveHour: null, sevenDay: { utilization: 0.8, resetsAtMs: sevenReset }, status: null, isUsingOverage: false, seenAtMs: NOW, source: null };
  const rows = [pts(5 * 24 * H - H, 0.0), pts(0, 0.8)].map((p): QuotaLogRow => ({
    ts: p.ts, origin: "job", fiveUtil: null, fiveReset: null, sevenUtil: p.util, sevenReset: p.resetMs, status: null,
    overage: null, overageStatus: null, firstFiveUtil: null, firstSevenUtil: null, events: 1,
  }));
  const proj = projectAll(q, rows, NOW, CFG);
  const pol = decideQuotaPolicy(q, proj, NOW, CFG);
  assert.ok(pol.weekLevel >= 1, "projection pleine attendue");
  assert.equal(pol.lightJobs, true);
  assert.ok(pol.weekProjectedEnd! > 1);
});

test("weeklyRate : trop tôt = null ; un reset manuel fait repartir le rythme de la chute", () => {
  const reset = NOW + 3 * 24 * H;
  const p = (ago: number, u: number) => ({ ts: NOW - ago, util: u, resetMs: reset });
  assert.equal(weeklyRate([], NOW + 6.5 * 24 * H, 0.12, NOW, 168 * H, 36 * H), null);
  const pts = [p(60 * H, 0.9), p(20 * H, 0.05), p(0, 0.15)];
  const r = weeklyRate(pts, reset, 0.15, NOW, 168 * H, 36 * H, 10 * H)!;
  assert.ok(Math.abs(r - 0.15 / 20) < 1e-9, `rythme ${r}`);
});

test("alertes : une par franchissement, overage tout de suite", () => {
  const s = memStore();
  storeQuota(s, snap(0.9, 0.2), NOW, "x");
  const q = readQuota(s);
  const proj = projectAll(q, [], NOW, CFG);
  const a1 = quotaAlerts({}, q, proj, NOW, CFG);
  assert.equal(a1.texts.length, 1);
  assert.equal(quotaAlerts(a1.next, q, proj, NOW, CFG).texts.length, 0);
  const over = { ...q, isUsingOverage: true, overageStatus: "allowed" };
  assert.match(quotaAlerts({}, over, proj, NOW, CFG).texts.join(" "), /dépassement payant/);
});

test("recordQuotaMeasure : journal, vue, état d'alerte ; ligne de contexte", () => {
  const s = memStore();
  const r = recordQuotaMeasure(s, snap(0.9, 0.2), NOW, "conv:principal", null, 1, CFG);
  assert.equal(s.rows.length, 1);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.previousMode, null);
  assert.ok(s.getSetting(ALERT_STATE_KEY));
  assert.match(quotaContextLine(s, NOW, CFG), /^\[Quota Claude\] 5 h : 90 %/);
  assert.equal(quotaContextLine(memStore(), NOW, CFG), "");
  assert.equal(quotaContextLine({ getSetting: () => { throw new Error("x"); }, quotaLogSince: () => [] }, NOW, CFG), "");
});

test("attribution : la hausse va à l'origine de la mesure, le trou à part", () => {
  const row = (ts: number, origin: string, five: number, first: number | null = null): QuotaLogRow => ({
    ts, origin, fiveUtil: five, fiveReset: NOW + 3 * H, sevenUtil: five, sevenReset: NOW + 3 * 24 * H, status: null,
    overage: null, overageStatus: null, firstFiveUtil: first, firstSevenUtil: first, events: 1,
  });
  const lines = attributeByOrigin([row(1, "job", 0.1), row(2, "conv:principal", 0.2), row(3, "job", 0.5, 0.4)], 0);
  const by = Object.fromEntries(lines.map((l) => [l.key, l.five]));
  assert.ok(Math.abs(by["conv"]! - 0.1) < 1e-9);
  assert.ok(Math.abs(by["job"]! - 0.1) < 1e-9);
  assert.ok(Math.abs(Object.entries(by).find(([k]) => k.startsWith("entre"))![1] - 0.2) < 1e-9);
  assert.match(formatAttribution(lines).at(-1)!, /^TOTAL/);
  assert.deepEqual(formatAttribution([]), ["aucune consommation mesurée sur la période"]);
});

test("jobBypassesDefer : chaîne ou [urgent]", () => {
  assert.equal(jobBypassesDefer({ intent: "x", chainKind: "nuit" }), true);
  assert.equal(jobBypassesDefer({ intent: " [Urgent] x" }), true);
  assert.equal(jobBypassesDefer({ intent: "x" }), false);
});
