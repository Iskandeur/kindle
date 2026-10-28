import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { healthUrl, probeHealth } from "./health-probe.ts";

function serve(handler: (req: unknown, res: { writeHead(c: number): { end(b?: string): void } }) => void) {
  const server = createServer(handler as never);
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/health`, close: () => server.close() });
    });
  });
}

test("healthUrl : l'URL explicite prime, sinon loopback sur le port, sinon 8787", () => {
  assert.equal(healthUrl({ WATCHDOG_HEALTH_URL: " http://x/h " }), "http://x/h");
  assert.equal(healthUrl({ WEBHOOK_PORT: "9000" }), "http://127.0.0.1:9000/health");
  assert.equal(healthUrl({}), "http://127.0.0.1:8787/health");
});

test("probeHealth : 200 -> ok", async () => {
  const s = await serve((_q, res) => res.writeHead(200).end("ok"));
  try {
    assert.equal(await probeHealth({ url: s.url, env: {} }), "ok");
  } finally {
    s.close();
  }
});

test("probeHealth : 500 -> ko", async () => {
  const s = await serve((_q, res) => res.writeHead(500).end());
  try {
    assert.equal(await probeHealth({ url: s.url, env: {} }), "ko");
  } finally {
    s.close();
  }
});

test("probeHealth : un daemon sourd (connexion acceptée, jamais de réponse) -> ko au timeout", async () => {
  const s = await serve(() => {});
  try {
    assert.equal(await probeHealth({ url: s.url, timeoutMs: 200, env: {} }), "ko");
  } finally {
    s.close();
  }
});

test("probeHealth : connexion refusée -> ko", async () => {
  const s = await serve((_q, res) => res.writeHead(200).end());
  s.close();
  assert.equal(await probeHealth({ url: s.url, timeoutMs: 500, env: {} }), "ko");
});

test("probeHealth : WATCHDOG_NO_HEALTH -> skipped sans toucher le réseau", async () => {
  assert.equal(await probeHealth({ url: "http://127.0.0.1:1/health", env: { WATCHDOG_NO_HEALTH: "1" } }), "skipped");
});
