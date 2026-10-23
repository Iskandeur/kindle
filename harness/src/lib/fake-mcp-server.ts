#!/usr/bin/env node
/**
 * fake-mcp-server — un serveur MCP minimal en stdio (JSON-RPC, une ligne par message), pour les tests.
 * Un seul outil, `ping`, qui répond `mcp-ok`. Sert à prouver qu'un moteur branche bien les serveurs MCP
 * déclarés dans `.mcp.json`. Lancé par : `node fake-mcp-server.ts`.
 */
import { createInterface } from "node:readline";

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "kindle-fake-mcp", version: "0.0.1" },
        },
      });
    case "tools/list":
      return send({
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "ping", description: "Répond mcp-ok.", inputSchema: { type: "object", properties: {} } }] },
      });
    case "tools/call":
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "mcp-ok" }] } });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `méthode inconnue : ${m.method}` } });
  }
});
