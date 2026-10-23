import { test } from "node:test";
import assert from "node:assert/strict";
import { SAFE_FORM, dockerEnvLeakInBash, dockerEnvRefusal, formatLeaksEnv, splitPipelines } from "./docker-env-guard.ts";

const REFUSED: string[] = [
  "docker inspect web",
  "docker container inspect web",
  "docker image inspect alpine",
  "docker inspect --format '{{.Config.Env}}' web",
  "docker inspect -f '{{json .Config}}' web",
  "docker inspect -f '{{json .}}' web",
  "docker inspect --format json web",
  "docker exec web env",
  "docker exec -it web printenv",
  "docker exec web printenv SECRET",
  "docker compose exec app env",
  "docker exec web cat /proc/1/environ",
  "docker exec web env -u FOO",
  // Prudent par construction : seule une coupe au `=` rend un env inoffensif, un `grep` peut en montrer les valeurs.
  "docker exec web env | grep -c .",
  "docker compose config",
  "sudo docker inspect web",
  "echo ok && docker inspect web",
  "ls | xargs docker inspect",
  "bash -c 'docker inspect web'",
  "echo $(docker inspect web)",
  "docker inspect web | tee /tmp/out",
  "docker inspect web | cut -d= -f1",
  "docker inspect -f '{{.Config.Env}}' web > /tmp/env.txt",
  "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' web | tee /tmp/e | cut -d= -f1",
  "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' web > /tmp/e; cut -d= -f1 /tmp/e",
];

const ALLOWED: string[] = [
  "ls -la",
  "git commit -m 'docker inspect est interdit sans format'",
  "grep 'docker inspect' notes.md",
  "docker ps",
  "docker logs web --tail 20",
  "docker inspect --format '{{.State.Status}}' web",
  "docker inspect -f '{{.Config.Image}}' web",
  "docker exec web ls /app",
  "docker exec web env FOO=1 node app.js",
  "docker compose config --services",
  "docker compose -f stack.yml config --quiet",
  `${SAFE_FORM.replace("<conteneur>", "web")}`,
  "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' web | cut -d= -f1",
  "docker exec web env | cut -d= -f1",
  "docker exec web env | awk -F= '{print $1}'",
  "docker exec web env | sort | cut -d= -f1",
];

test("refusé : chaque forme qui imprime un env en valeurs", () => {
  for (const c of REFUSED) assert.notEqual(dockerEnvLeakInBash(c), null, `devait être refusé : ${c}`);
});

test("accepté : commandes sans fuite, ou réduites aux noms", () => {
  for (const c of ALLOWED) assert.equal(dockerEnvLeakInBash(c), null, `devait passer : ${c}`);
});

test("splitPipelines respecte les guillemets et les redirections 2>&1", () => {
  assert.deepEqual(splitPipelines("a | b && c ; d"), [["a", "b"], ["c"], ["d"]]);
  assert.deepEqual(splitPipelines("echo 'a | b ; c'"), [["echo 'a | b ; c'"]]);
  assert.deepEqual(splitPipelines("cmd 2>&1 | grep x"), [["cmd 2>&1", "grep x"]]);
});

test("formatLeaksEnv", () => {
  assert.equal(formatLeaksEnv("json"), true);
  assert.equal(formatLeaksEnv("{{.Config.Env}}"), true);
  assert.equal(formatLeaksEnv("{{.Config}}"), true);
  assert.equal(formatLeaksEnv("{{json .}}"), true);
  assert.equal(formatLeaksEnv("{{.Config.Image}}"), false);
  assert.equal(formatLeaksEnv("{{.State.Status}}"), false);
  assert.equal(formatLeaksEnv("{{range .Mounts}}{{.}}{{end}}"), false);
});

test("pas d'emballement de la regex sur une chaîne d'xargs", () => {
  const t0 = Date.now();
  dockerEnvLeakInBash(`${"xargs ".repeat(60)}docker inspect x`);
  assert.ok(Date.now() - t0 < 1000);
});

test("le refus donne la raison et la forme sûre", () => {
  const why = dockerEnvLeakInBash("docker inspect web")!;
  const msg = dockerEnvRefusal(why);
  assert.match(msg, /sans `--format`/);
  assert.ok(msg.includes(SAFE_FORM));
});
