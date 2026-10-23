import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectFriction, excerptAround, withinDailyCap, frictionIsAboutSpending, frictionCountKey, frictionRepairPrompt,
  openFrictionRepair, frictionOutcomeLog, isRepairJob, frictionReopenedNote, FRICTION_DAILY_CAP, DEFAULT_PATTERNS,
  type FrictionJobStore,
} from "./friction-detect.ts";
import { detectFollowUpPromise, shouldNudge, promiseNudgePrompt, promiseCountKey, PROMISE_DAILY_CAP } from "./promise-watchdog.ts";

test("détection : un exemple positif par famille", () => {
  assert.equal(detectFriction("tu ne réponds pas aux messages")?.kind, "silence");
  assert.equal(detectFriction("Tu dors ou quoi ?")?.kind, "silence");
  assert.equal(detectFriction("corrige ça stp")?.kind, "reproche");
  assert.equal(detectFriction("je te l'ai déjà dit, je t'ai déjà dit")?.kind, "reproche");
  assert.equal(detectFriction("c'est très frustrant")?.kind, "reproche");
  assert.equal(detectFriction("ce n'est pas du tout assez rapide")?.kind, "insatisfaction");
  assert.equal(detectFriction("you could do much better".replace("much ", "a lot "))?.kind, "insatisfaction");
  assert.equal(detectFriction("I told you already")?.kind, "reproche");
});

test("détection : les faux positifs connus ne mordent pas", () => {
  for (const ok of [
    "Tu dors où ce soir ?",
    "Tu dors chez nous ?",
    "Ça fait combien de fois Seigneur des Anneaux ?",
    "Ah ? Déçu ?",
    "génial !!! merci",
    "ça va pas mal du tout",
    "ça va pas être trop compliqué ?",
    "bonne journée",
    "",
  ]) {
    assert.equal(detectFriction(ok), null, ok);
  }
});

test("« ça ne marche pas » avec cédille mord (frontière Unicode), « tu dors ou quoi » aussi", () => {
  assert.equal(detectFriction("ça ne marche pas, je suis sur la page")?.kind, "reproche");
  assert.equal(detectFriction("Ça marche pas")?.kind, "reproche");
  assert.equal(detectFriction("combien de fois je dois te le dire")?.kind, "reproche");
});

test("ponctuation : seulement avec une deuxième personne", () => {
  assert.equal(detectFriction("t'es où ??")?.kind, "reproche");
  assert.equal(detectFriction("super !!!!"), null);
});

test("chaque motif par défaut se compile et a une forme valide", () => {
  for (const p of DEFAULT_PATTERNS) assert.ok(p.re instanceof RegExp && ["silence", "reproche", "insatisfaction"].includes(p.kind));
});

test("motifs personnalisés", () => {
  const s = detectFriction("zut alors", [{ kind: "reproche", re: /\bzut\b/i }]);
  assert.equal(s?.kind, "reproche");
  assert.equal(detectFriction("corrige ça", []), null);
});

test("excerptAround borne et marque les coupes", () => {
  const long = `${"a ".repeat(100)}CIBLE${" b".repeat(100)}`;
  const e = excerptAround(long, long.indexOf("CIBLE"), 5);
  assert.ok(e.startsWith("…") && e.endsWith("…") && e.includes("CIBLE"));
  assert.equal(excerptAround("court", 0, 5), "court");
});

test("plafond, clé, sujet du coût", () => {
  assert.ok(withinDailyCap(FRICTION_DAILY_CAP - 1));
  assert.ok(!withinDailyCap(FRICTION_DAILY_CAP));
  assert.equal(frictionCountKey("2026-10-10"), "friction_repairs_2026-10-10");
  assert.ok(frictionIsAboutSpending("arrête de cramer le quota"));
  assert.ok(frictionIsAboutSpending("stop burning the budget"));
  assert.ok(!frictionIsAboutSpending("corrige ça"));
});

function fakeStore(): FrictionJobStore & { jobs: string[]; settings: Map<string, string> } {
  const settings = new Map<string, string>();
  const jobs: string[] = [];
  return {
    jobs, settings,
    getSetting: (k) => settings.get(k),
    setSetting: (k, v) => void settings.set(k, v),
    addJobDeduped: (intent) => {
      const i = jobs.indexOf(intent);
      if (i >= 0) return { id: i + 1, created: false };
      jobs.push(intent);
      return { id: jobs.length, created: true };
    },
  };
}
const msg = (body: string) => ({ body, where: "chat 1:1", at: "2026-10-10 12:00", day: "2026-10-10" });

test("openFrictionRepair : none, spending, opened, duplicate, capped", () => {
  const s = fakeStore();
  assert.equal(openFrictionRepair(s, msg("bonjour")).action, "none");
  assert.equal(openFrictionRepair(s, msg("arrête de cramer le quota")).action, "spending");
  assert.equal(s.jobs.length, 0);
  const o = openFrictionRepair(s, msg("corrige ça"));
  assert.equal(o.action, "opened");
  assert.equal(s.settings.get("friction_repairs_2026-10-10"), "1");
  assert.equal(openFrictionRepair(s, msg("corrige ça")).action, "duplicate");
  assert.equal(s.settings.get("friction_repairs_2026-10-10"), "1");
  for (let i = 0; i < 5; i++) openFrictionRepair(s, msg(`corrige ça ${i}`));
  assert.equal(openFrictionRepair(s, msg("corrige ça encore une fois")).action, "capped");
  assert.equal(s.jobs.length, FRICTION_DAILY_CAP);
});

test("journal d'issue et prompt de réparation", () => {
  const s = fakeStore();
  const o = openFrictionRepair(s, msg("corrige ça"));
  assert.match(frictionOutcomeLog(o)!, /job #1/);
  assert.equal(frictionOutcomeLog({ action: "none" }), null);
  assert.match(frictionOutcomeLog(openFrictionRepair(s, msg("arrête de cramer le quota")))!, /COÛT/);
  const p = frictionRepairPrompt({ signal: { kind: "reproche", evidence: "corrige ça" }, body: "corrige ça", at: "t", where: "w", extraLines: ["CONSIGNE LOCALE"] });
  assert.match(p, /CONSIGNE LOCALE/);
  assert.match(p, /Ne fabrique pas un correctif/);
  assert.match(p, /non vérifiable/);
});

test("isRepairJob et note de friction rouverte", () => {
  assert.ok(isRepairJob("friction", "x"));
  assert.ok(isRepairJob("cli", "Une friction à corriger"));
  assert.ok(isRepairJob("cli", "c'est réparé ?"));
  assert.ok(!isRepairJob("cli", "écrire un poème"));
  assert.ok(!isRepairJob("burner", "friction réparée", "burner"));
  assert.match(frictionReopenedNote(12), /#12/);
});

test("promesse de suivi : positifs, négatifs, extrait", () => {
  for (const t of ["je te tiens au courant", "Je te donne le verdict dès qu'il répond", "je retente dans 3 min", "I'll get back to you", "je vérifie dans 10 minutes", "je laisse retomber le throttle"]) {
    assert.ok(detectFollowUpPromise(t), t);
  }
  for (const t of ["je vais manger", "je vérifie ça", "voilà c'est fait", ""]) assert.equal(detectFollowUpPromise(t), null, t);
  assert.match(detectFollowUpPromise("Salut. Je te tiens au courant ce soir.")!.evidence, /tiens au courant/);
});

test("shouldNudge : réveil armé, plafond, promesse", () => {
  const base = { outgoingText: "je te tiens au courant", wakesCreatedDuringTurn: 0, nudgesToday: 0 };
  assert.ok(shouldNudge(base));
  assert.equal(shouldNudge({ ...base, wakesCreatedDuringTurn: 1 }), null);
  assert.equal(shouldNudge({ ...base, nudgesToday: PROMISE_DAILY_CAP }), null);
  assert.equal(shouldNudge({ ...base, outgoingText: "ok" }), null);
  assert.equal(promiseCountKey("2026-10-10"), "promise_nudges_2026-10-10");
  assert.match(promiseNudgePrompt({ evidence: "e" }, "schedule-wake --in 10m"), /schedule-wake --in 10m/);
});
