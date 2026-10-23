import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DRAIN, DRAIN_HARD_KEY, DRAIN_SINCE_KEY, burstOver, drainActive, drainHard, drainMode, drainStep, makeUrgency,
  mayClaim, pathReloadsDaemon, pathsReload, urgencyInForce, urgentFromCommitMessages, type ReloadPathRules,
} from "./reload-drain.ts";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const store = (o: Record<string, string>) => ({ getSetting: (k: string) => o[k] });
const RULES: ReloadPathRules = {
  root: "daemon/",
  ignoredPrefixes: ["daemon/scripts/"],
  binPrefix: "daemon/bin/",
  loadedBins: ["daemon/bin/pdf-text.ts"],
};

test("pathReloadsDaemon : sources oui ; tests, scripts, bins lancés en process neuf, hors racine non", () => {
  assert.equal(pathReloadsDaemon("daemon/src/main.ts", RULES), true);
  assert.equal(pathReloadsDaemon("daemon/package.json", RULES), true);
  assert.equal(pathReloadsDaemon("daemon/src/main.test.ts", RULES), false);
  assert.equal(pathReloadsDaemon("daemon/scripts/x.sh", RULES), false);
  assert.equal(pathReloadsDaemon("daemon/bin/outil.ts", RULES), false);
  assert.equal(pathReloadsDaemon("daemon/bin/pdf-text.ts", RULES), true);
  assert.equal(pathReloadsDaemon("docs/readme.md", RULES), false);
  assert.equal(pathsReload(["docs/a.md", "daemon/src/b.ts"], RULES), true);
  assert.equal(pathsReload([], RULES), false);
});

test("burstOver : calme acquis après quietMs, inconnu = oui", () => {
  assert.equal(burstOver(NOW - 5 * MIN, NOW), false);
  assert.equal(burstOver(NOW - 10 * MIN, NOW), true);
  assert.equal(burstOver(null, NOW), true);
  assert.equal(burstOver(NaN, NOW), true);
});

test("drainActive : vide, illisible, périmé : non ; en cours : oui ; horloge qui recule : oui", () => {
  assert.equal(drainActive(store({}), NOW), false);
  assert.equal(drainActive(store({ [DRAIN_SINCE_KEY]: "abc" }), NOW), false);
  assert.equal(drainActive(store({ [DRAIN_SINCE_KEY]: String(NOW - 5 * MIN) }), NOW), true);
  const limite = DEFAULT_DRAIN.maxMs + DEFAULT_DRAIN.slackMs;
  assert.equal(drainActive(store({ [DRAIN_SINCE_KEY]: String(NOW - limite) }), NOW), true);
  assert.equal(drainActive(store({ [DRAIN_SINCE_KEY]: String(NOW - limite - 1) }), NOW), false);
  assert.equal(drainActive(store({ [DRAIN_SINCE_KEY]: String(NOW + MIN) }), NOW), true);
});

test("drainHard : un battement frais seulement", () => {
  assert.equal(drainHard(store({ [DRAIN_HARD_KEY]: String(NOW - MIN) }), NOW), true);
  assert.equal(drainHard(store({ [DRAIN_HARD_KEY]: String(NOW - 11 * MIN) }), NOW), false);
  assert.equal(drainHard(store({}), NOW), false);
});

test("drainMode et mayClaim : off réclame tout, soft rien, hard les seuls [urgent]", () => {
  assert.equal(drainMode(store({}), NOW), "off");
  assert.equal(drainMode(store({ [DRAIN_SINCE_KEY]: String(NOW - MIN) }), NOW), "soft");
  assert.equal(drainMode(store({ [DRAIN_HARD_KEY]: String(NOW - MIN), [DRAIN_SINCE_KEY]: String(NOW - MIN) }), NOW), "hard");
  assert.equal(mayClaim("off", { intent: "x" }), true);
  assert.equal(mayClaim("soft", { intent: "[urgent] x" }), false);
  assert.equal(mayClaim("hard", { intent: "  [URGENT] réponse en direct" }), true);
  assert.equal(mayClaim("hard", { intent: "refactor" }), false);
});

test("drainStep : start, continue, limit, paused, hard (l'épisode prime)", () => {
  assert.equal(drainStep(null, null, NOW), "start");
  assert.equal(drainStep(NOW - 5 * MIN, null, NOW), "continue");
  assert.equal(drainStep(NOW - 20 * MIN, null, NOW), "limit");
  assert.equal(drainStep(NOW - 20 * MIN, NOW + MIN, NOW), "paused");
  assert.equal(drainStep(null, NOW + MIN, NOW), "paused");
  assert.equal(drainStep(NOW - 5 * MIN, NOW + MIN, NOW, NOW - 3 * 3_600_000), "hard");
  assert.equal(drainStep(null, null, NOW, NOW - 2 * 3_600_000), "start");
});

test("urgentFromCommitMessages : la marque doit être une ligne à part", () => {
  const sep = "\u001e";
  assert.equal(urgentFromCommitMessages(null), null);
  assert.equal(urgentFromCommitMessages("fix: x\n\nbody"), null);
  assert.equal(urgentFromCommitMessages("fix: faille\n\nUrgent-Reload: yes\n"), "fix: faille");
  assert.equal(urgentFromCommitMessages(`rien${sep}sec: patch\n\nurgent-reload: OUI`), "sec: patch");
  assert.equal(urgentFromCommitMessages("on cite Urgent-Reload: yes dans une phrase"), null);
});

test("urgencyInForce : posée après le boot, récente, bien formée", () => {
  const boot = NOW - 3_600_000;
  const u = makeUrgency("  faille  ", NOW - MIN);
  assert.equal(u.reason, "faille");
  assert.equal(urgencyInForce(JSON.stringify(u), NOW, boot), "faille");
  assert.equal(urgencyInForce(JSON.stringify({ ...u, setAt: boot - 1 }), NOW, boot), null);
  assert.equal(urgencyInForce(JSON.stringify({ ...u, setAt: NOW + 10 * MIN }), NOW, boot), null);
  assert.equal(urgencyInForce(JSON.stringify({ ...u, setAt: NOW - 25 * 3_600_000 }), NOW, NOW - 48 * 3_600_000), null);
  assert.equal(urgencyInForce("pas du json", NOW, boot), null);
  assert.equal(urgencyInForce(null, NOW, boot), null);
  assert.equal(makeUrgency("   ", NOW).reason, "urgence sans raison");
});
