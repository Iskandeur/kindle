import test from "node:test";
import assert from "node:assert/strict";
import { readProtocolEntry } from "./waha-protocol.ts";

/** Deux entrées réelles (champs utiles seulement), telles que l'API HTTP de WAHA les
 *  rend : l'original modifié, puis l'entrée de modification qui porte le même corps. */
const ORIGINAL = {
  id: "true_100000000000001@lid_3EB0AAAAAAAAAAAAAAAA01",
  timestamp: 1790218495,
  fromMe: true,
  body: "Bonjour ☀️ …",
  _data: {
    type: "chat",
    latestEditMsgKey: { id: "3EB0BBBBBBBBBBBBBB02", $1: "true_100000000000001@lid_3EB0BBBBBBBBBBBBBB02" },
  },
};
const EDITION = {
  id: "true_100000000000001@lid_3EB0BBBBBBBBBBBBBB02",
  timestamp: 1790218548,
  fromMe: true,
  body: "Bonjour ☀️ …",
  _data: {
    type: "protocol",
    subtype: "message_edit",
    protocolMessageKey: { id: "3EB0AAAAAAAAAAAAAAAA01", $1: "true_100000000000001@lid_3EB0AAAAAAAAAAAAAAAA01" },
  },
};

test("l'entrée de modification est reconnue et pointe l'original", () => {
  assert.deepEqual(readProtocolEntry(EDITION), {
    subtype: "message_edit",
    targetId: "true_100000000000001@lid_3EB0AAAAAAAAAAAAAAAA01",
  });
});

/** Le témoin : l'original porte `latestEditMsgKey` (il A ÉTÉ modifié) mais reste un message, celui
 *  qu'il lit. Le prendre pour une entrée protocole ferait disparaître le rapport lui-même. */
test("l'original modifié reste un message", () => {
  assert.equal(readProtocolEntry(ORIGINAL), null);
});

test("sans `_data` (lecture via le MCP par défaut), rien n'est reconnu", () => {
  const { _data, ...nu } = EDITION;
  void _data;
  assert.equal(readProtocolEntry(nu), null);
});

test("une entrée protocole sans sous-type ni cible reste reconnue", () => {
  assert.deepEqual(readProtocolEntry({ _data: { type: "protocol" } }), { subtype: "?" });
  assert.deepEqual(
    readProtocolEntry({ _data: { type: "protocol", subtype: "revoke", protocolMessageKey: { _serialized: "false_x@c.us_ABC" } } }),
    { subtype: "revoke", targetId: "false_x@c.us_ABC" },
  );
});

test("valeurs absurdes : null, pas d'exception", () => {
  for (const v of [null, undefined, 42, "x", {}, { _data: null }, { _data: { type: 7 } }]) {
    assert.equal(readProtocolEntry(v), null);
  }
});
