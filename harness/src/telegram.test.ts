import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeTelegramSender,
  buildTelegramPrompt,
  chunkText,
  normalizeTelegramUpdate,
  extractDocRef,
  safeDocName,
  tgSendDocument,
  toTelegramHtml,
  tgSendPhoto,
  tgMediaPlan,
  TG_PHOTO_MAX_BYTES,
  isTgStopSignal,
  stopAckText,
  planTgBatch,
} from "./telegram.ts";

const dm = (over: Record<string, unknown> = {}): any => ({
  update_id: 10,
  message: {
    message_id: 1,
    text: "coucou",
    chat: { id: 42, type: "private" },
    from: { id: 42, username: "alex_demo", first_name: "Alex", is_bot: false },
    ...over,
  },
});

test("normalizeTelegramUpdate : DM privé valide", () => {
  const m = normalizeTelegramUpdate(dm());
  assert.ok(m);
  assert.equal(m.chatId, 42);
  assert.equal(m.fromId, 42);
  assert.equal(m.chatType, "private");
  assert.equal(m.fromUsername, "alex_demo");
  assert.equal(m.text, "coucou");
});

test("normalizeTelegramUpdate : ignore ce qui n'est pas un message texte", () => {
  assert.equal(normalizeTelegramUpdate({ update_id: 1 }), null); // pas de message
  assert.equal(normalizeTelegramUpdate({ update_id: 1, edited_message: { text: "x" } }), null);
  assert.equal(normalizeTelegramUpdate(dm({ text: "" })), null); // texte vide
  assert.equal(normalizeTelegramUpdate(dm({ text: "   " })), null); // blanc
  assert.equal(normalizeTelegramUpdate({}), null); // pas d'update_id
  assert.equal(normalizeTelegramUpdate(dm({ text: "", voice: undefined })), null); // ni texte ni vocal
});

test("normalizeTelegramUpdate : capte un vocal (voice) même sans texte", () => {
  const m = normalizeTelegramUpdate(dm({ text: "", voice: { file_id: "AAA", mime_type: "audio/ogg", duration: 3 } }));
  assert.ok(m);
  assert.equal(m!.text, "");
  assert.equal(m!.voice?.fileId, "AAA");
  assert.equal(m!.voice?.kind, "voice");
  assert.equal(m!.voice?.mimetype, "audio/ogg");
  assert.equal(m!.voice?.durationSec, 3);
});

test("normalizeTelegramUpdate : capte un fichier audio joint (audio) avec mimetype par défaut", () => {
  const m = normalizeTelegramUpdate(dm({ text: "", audio: { file_id: "BBB", duration: 9 } }));
  assert.equal(m!.voice?.fileId, "BBB");
  assert.equal(m!.voice?.kind, "audio");
  assert.equal(m!.voice?.mimetype, "audio/mpeg"); // défaut quand mime_type absent
});

test("normalizeTelegramUpdate : un message texte pur n'expose pas de voice", () => {
  assert.equal(normalizeTelegramUpdate(dm())!.voice, undefined);
});

test("normalizeTelegramUpdate : capte une photo (plus grande taille) + légende en texte", () => {
  const m = normalizeTelegramUpdate(
    dm({
      text: undefined,
      caption: "regarde ça",
      photo: [
        { file_id: "small", width: 90, height: 90 },
        { file_id: "big", width: 1280, height: 1280 },
      ],
    }),
  );
  assert.ok(m);
  assert.equal(m!.image?.fileId, "big"); // dernière = plus grande
  assert.equal(m!.image?.mimetype, "image/jpeg");
  assert.equal(m!.text, "regarde ça"); // caption devient le texte
});

test("normalizeTelegramUpdate : capte un document image (mimetype image/*) sans légende", () => {
  const m = normalizeTelegramUpdate(
    dm({ text: "", document: { file_id: "DOC", mime_type: "image/png" } }),
  );
  assert.ok(m);
  assert.equal(m!.image?.fileId, "DOC");
  assert.equal(m!.image?.mimetype, "image/png");
});

test("normalizeTelegramUpdate : un document NON-image est capté comme FICHIER (plus ignoré)", () => {
  // Avant le 2026-07-21 ce cas rendait null : un .json envoyé passait inaperçu.
  const m = normalizeTelegramUpdate(
    dm({ text: "", document: { file_id: "PDF", mime_type: "application/pdf", file_name: "skill.pdf", file_size: 1234 } }),
  );
  assert.ok(m);
  assert.equal(m!.image, undefined, "un PDF n'est pas une image");
  assert.equal(m!.document?.fileId, "PDF");
  assert.equal(m!.document?.mimetype, "application/pdf");
  assert.equal(m!.document?.fileName, "skill.pdf");
  assert.equal(m!.document?.sizeBytes, 1234);
});

test("normalizeTelegramUpdate : fichier avec légende → la légende devient le texte", () => {
  const m = normalizeTelegramUpdate(
    dm({ text: "", caption: "voici le json", document: { file_id: "J", mime_type: "application/json", file_name: "s.json" } }),
  );
  assert.equal(m!.text, "voici le json");
  assert.equal(m!.document?.fileId, "J");
});

test("normalizeTelegramUpdate : un document image reste une IMAGE, pas un fichier", () => {
  const m = normalizeTelegramUpdate(dm({ text: "", document: { file_id: "IMG", mime_type: "image/png" } }));
  assert.equal(m!.image?.fileId, "IMG");
  assert.equal(m!.document, undefined);
});

test("extractDocRef : mimetype absent → octet-stream, image/* → undefined", () => {
  assert.equal(extractDocRef({ document: { file_id: "X" } })?.mimetype, "application/octet-stream");
  assert.equal(extractDocRef({ document: { file_id: "X", mime_type: "image/jpeg" } }), undefined);
  assert.equal(extractDocRef({}), undefined);
  assert.equal(extractDocRef({ document: {} }), undefined);
});

test("safeDocName : neutralise les traversées de chemin, garde un nom lisible", () => {
  assert.equal(safeDocName("skill.json", "ABCD1234EFGH"), "tg-1234EFGH-skill.json");
  assert.equal(safeDocName("../../etc/passwd", "ABCD1234EFGH"), "tg-1234EFGH-passwd");
  assert.equal(safeDocName("a/b/c.md", "ABCD1234EFGH"), "tg-1234EFGH-c.md");
  assert.equal(safeDocName("...hidden", "ABCD1234EFGH"), "tg-1234EFGH-hidden");
  assert.equal(safeDocName("", "ABCD1234EFGH"), "tg-1234EFGH.bin");
  assert.ok(!safeDocName("é$@!.json", "ABCD1234EFGH").includes("$"));
});

test("normalizeTelegramUpdate : un message texte pur n'expose pas d'image", () => {
  assert.equal(normalizeTelegramUpdate(dm())!.image, undefined);
});

test("authorizeTelegramSender : scelle le 1er @alex_demo puis verrouille sur l'id", () => {
  const ctx = { sealedId: null, principalUsername: "alex_demo" };
  const first = authorizeTelegramSender(normalizeTelegramUpdate(dm())!, ctx);
  assert.deepEqual(first, { allowed: true, sealId: 42 });

  // Une fois scellé, seul l'id 42 passe (le username n'est plus déterminant).
  const sealed = { sealedId: 42, principalUsername: "alex_demo" };
  assert.deepEqual(
    authorizeTelegramSender(normalizeTelegramUpdate(dm({ from: { id: 42, username: "peu_importe", is_bot: false } }))!, sealed),
    { allowed: true },
  );
  const other = authorizeTelegramSender(
    normalizeTelegramUpdate(dm({ from: { id: 999, username: "alex_demo", is_bot: false } }))!,
    sealed,
  );
  assert.equal(other.allowed, false);
});

test("authorizeTelegramSender : refuse username inconnu, bot, non-DM", () => {
  const ctx = { sealedId: null, principalUsername: "alex_demo" };
  assert.equal(authorizeTelegramSender(normalizeTelegramUpdate(dm({ from: { id: 7, username: "intrus", is_bot: false } }))!, ctx).allowed, false);
  assert.equal(authorizeTelegramSender(normalizeTelegramUpdate(dm({ from: { id: 7, username: "alex_demo", is_bot: true } }))!, ctx).allowed, false);
  assert.equal(authorizeTelegramSender(normalizeTelegramUpdate(dm({ chat: { id: -100, type: "supergroup" } }))!, ctx).allowed, false);
});

test("authorizeTelegramSender : casse insensible sur le username", () => {
  const ctx = { sealedId: null, principalUsername: "alex_demo" };
  const d = authorizeTelegramSender(normalizeTelegramUpdate(dm({ from: { id: 5, username: "ALEX_DEMO", is_bot: false } }))!, ctx);
  assert.deepEqual(d, { allowed: true, sealId: 5 });
});

test("chunkText : sous la limite = 1 morceau ; au-dessus = découpé", () => {
  assert.deepEqual(chunkText("court"), ["court"]);
  const big = "a".repeat(9000);
  const parts = chunkText(big, 4000);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(""), big);
});

test("toTelegramHtml : gras/italique/barré/code façon WhatsApp → HTML", () => {
  assert.equal(toTelegramHtml("un *gras* ici"), "un <b>gras</b> ici");
  assert.equal(toTelegramHtml("un _ital_ là"), "un <i>ital</i> là");
  assert.equal(toTelegramHtml("fin ~barré~"), "fin <s>barré</s>");
  assert.equal(toTelegramHtml("un `code`"), "un <code>code</code>");
});

test("toTelegramHtml : échappe les entités HTML (injection impossible)", () => {
  assert.equal(toTelegramHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(toTelegramHtml("<script>"), "&lt;script&gt;");
});

test("toTelegramHtml : les _ d'un identifiant en `code` ne deviennent pas de l'italique", () => {
  assert.equal(toTelegramHtml("clé `TELEGRAM_BOT_TOKEN` ok"), "clé <code>TELEGRAM_BOT_TOKEN</code> ok");
});

test("toTelegramHtml : marqueur non apparié / entouré d'espaces reste littéral", () => {
  assert.equal(toTelegramHtml("juste un * seul"), "juste un * seul");
  assert.equal(toTelegramHtml("5 * 3 = 15"), "5 * 3 = 15");
});

test("toTelegramHtml : un nombre entre espaces n'est pas mangé (régression sentinelle)", () => {
  assert.equal(toTelegramHtml("les 5 briefs du 11 juillet"), "les 5 briefs du 11 juillet");
});

test("toTelegramHtml : le double-astérisque GitHub-style (**gras**) est absorbé, pas laissé littéral (régression 20/07)", () => {
  assert.equal(toTelegramHtml("**Sur la friction** : ça marche"), "<b>Sur la friction</b> : ça marche");
  assert.equal(toTelegramHtml("un __italique__ aussi"), "un <i>italique</i> aussi");
});

test("toTelegramHtml : ***gras-italique*** et ~~barré~~ markdown (régression 21/07 : <b>*x*</b>)", () => {
  assert.equal(toTelegramHtml("***important***"), "<b><i>important</i></b>");
  assert.equal(toTelegramHtml("c'est ~~mort~~ vivant"), "c'est <s>mort</s> vivant");
});

test("toTelegramHtml : titres markdown → ligne en gras, sans gras imbriqué", () => {
  assert.equal(toTelegramHtml("## Bilan du jour"), "<b>Bilan du jour</b>");
  assert.equal(toTelegramHtml("### Bilan **fort**\ntexte"), "<b>Bilan fort</b>\ntexte");
});

test("toTelegramHtml : lien markdown → <a>, URL nue protégée (les _ ne cassent pas le lien)", () => {
  assert.equal(toTelegramHtml("vois [la PR](https://github.com/x/y/pull/1)"), 'vois <a href="https://github.com/x/y/pull/1">la PR</a>');
  assert.equal(toTelegramHtml("brut https://ex.com/foo_bar_baz ok"), "brut https://ex.com/foo_bar_baz ok");
});

test("toTelegramHtml : puces markdown -/* → • (l'astérisque-puce n'est pas du gras)", () => {
  assert.equal(toTelegramHtml("- premier\n* second avec *gras*"), "• premier\n• second avec <b>gras</b>");
});

test("toTelegramHtml : identifiant de langage d'un bloc code jeté", () => {
  assert.equal(toTelegramHtml("```ts\nconst a = 1;\n```"), "<pre>const a = 1;\n</pre>");
});

test("buildTelegramPrompt : instruit le relais, nomme l'humain, ajoute l'état", () => {
  const p = buildTelegramPrompt("salut", "10h30", { principalName: "Alex", status: "WhatsApp HS." });
  assert.match(p, /\[🕒 10h30\]/);
  assert.match(p, /Alex t'écrit via la gateway Telegram/);
  assert.match(p, /WhatsApp HS\./);
  assert.match(p, /relayé TEL QUEL/);
  assert.match(p, /\nsalut\n/);
  assert.match(buildTelegramPrompt("x", "t"), /ton humain t'écrit/);
});

test("tgSendDocument : POST sendDocument multipart, renvoie message_id", async () => {
  const orig = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 });
  }) as any;
  try {
    const id = await tgSendDocument("TOK", 42, new Uint8Array([1, 2, 3]), "brief.pdf", {
      caption: "*Rocher* du Conseil",
      mimetype: "application/pdf",
    });
    assert.equal(id, 777);
    assert.match(captured.url, /\/botTOK\/sendDocument$/);
    assert.equal(captured.init.method, "POST");
    const fd = captured.init.body as FormData;
    assert.equal(fd.get("chat_id"), "42");
    assert.equal(fd.get("parse_mode"), "HTML");
    assert.equal(fd.get("caption"), "<b>Rocher</b> du Conseil");
    assert.ok(fd.get("document") instanceof Blob);
  } finally {
    globalThis.fetch = orig;
  }
});

test("tgSendDocument : légende HTML rejetée (400) -> retry en brut puis succès", async () => {
  const orig = globalThis.fetch;
  const captions: (string | null)[] = [];
  let n = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    captions.push((init.body as FormData).get("caption") as string | null);
    n += 1;
    return n === 1
      ? new Response("Bad Request: can't parse entities", { status: 400 })
      : new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as any;
  try {
    const id = await tgSendDocument("TOK", 1, new Uint8Array([0]), "f.pdf", { caption: "*x*" });
    assert.equal(id, 9);
    assert.equal(n, 2);
    assert.equal(captions[0], "<b>x</b>");
    assert.equal(captions[1], "*x*");
  } finally {
    globalThis.fetch = orig;
  }
});

test("tgSendDocument : échec API -> lève", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 403 })) as any;
  try {
    await assert.rejects(() => tgSendDocument("TOK", 1, new Uint8Array([0]), "f.pdf"), /sendDocument échec \(403\)/);
  } finally {
    globalThis.fetch = orig;
  }
});

// ── 01/10 : repli WhatsApp→Telegram solide (stop, photos, état WhatsApp réel, lots) ──

test("tgSendPhoto : POST sendPhoto, champ `photo`", async () => {
  const orig = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: init.body as FormData };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as any;
  try {
    assert.equal(await tgSendPhoto("TOK", 42, new Uint8Array([1]), "graphe.png", { mimetype: "image/png" }), 9);
    assert.match(captured.url, /\/botTOK\/sendPhoto$/);
    assert.ok(captured.body.get("photo"));
    assert.equal(captured.body.get("document"), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("tgMediaPlan : photo pour jpg/png/webp ≤ 10 Mo, document sinon (gif, pdf, trop gros)", () => {
  assert.deepEqual(tgMediaPlan("a.PNG", 100), { method: "photo", mimetype: "image/png" });
  assert.deepEqual(tgMediaPlan("a.jpeg", 100), { method: "photo", mimetype: "image/jpeg" });
  assert.equal(tgMediaPlan("a.gif", 100).method, "document");
  assert.deepEqual(tgMediaPlan("r.pdf", 100), { method: "document", mimetype: "application/pdf" });
  assert.equal(tgMediaPlan("big.jpg", TG_PHOTO_MAX_BYTES + 1).method, "document");
  assert.deepEqual(tgMediaPlan("sans-extension", 1), { method: "document", mimetype: "application/octet-stream" });
});

test("isTgStopSignal : 🛑 seul et /stop, pas un message qui contient le mot", () => {
  assert.equal(isTgStopSignal("🛑"), true);
  assert.equal(isTgStopSignal(" /stop "), true);
  assert.equal(isTgStopSignal("/STOP@DemoBot"), true);
  assert.equal(isTgStopSignal("stop"), false);
  assert.equal(isTgStopSignal("🛑 attends"), false);
  assert.equal(isTgStopSignal("/stopper"), false);
});

test("normalizeTelegramUpdate : une réaction 🛑 devient un message « 🛑 » de son auteur ; les autres sont ignorées", () => {
  const reaction = (emoji: string, userId = 42): any => ({
    update_id: 77,
    message_reaction: {
      chat: { id: 42, type: "private" },
      message_id: 5,
      user: { id: userId, username: "alex_demo", is_bot: false },
      date: 1,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji }],
    },
  });
  const m = normalizeTelegramUpdate(reaction("🛑"));
  assert.equal(m?.text, "🛑");
  assert.equal(m?.fromId, 42);
  assert.equal(m?.chatType, "private");
  assert.equal(normalizeTelegramUpdate(reaction("👍")), null);
  // la réaction passe la même whitelist : un tiers ne peut pas stopper
  const stranger = normalizeTelegramUpdate(reaction("🛑", 666))!;
  assert.equal(authorizeTelegramSender(stranger, { sealedId: 42, principalUsername: "alex_demo" }).allowed, false);
});

test("stopAckText : dit ce qui a été arrêté", () => {
  assert.equal(stopAckText(true, 0), "🛑 réveil en cours arrêté.");
  assert.equal(stopAckText(true, 2), "🛑 réveil en cours arrêté, 2 messages en attente jetés.");
  assert.equal(stopAckText(false, 1), "🛑 1 message en attente jeté.");
  assert.equal(stopAckText(false, 0), "🛑 Rien ne tournait.");
});

test("planTgBatch : fusionne les suites de texte simple, laisse seuls les autres, garde l'ordre", () => {
  const t = (text: string, updateId: number, extra: Record<string, unknown> = {}): any => ({
    updateId, chatId: 42, chatType: "private", fromId: 42, text, isBot: false, ...extra,
  });
  const coal = (m: any) => !m.voice && !m.text.startsWith("/");
  const out = planTgBatch([t("a", 1), t("b", 2), t("/status", 3), t("c", 4), t("", 5, { voice: { fileId: "v" } })], coal);
  assert.deepEqual(out.map((m) => m.text), ["a\nb", "/status", "c", ""]);
  assert.equal(out[0].updateId, 2); // métadonnées du dernier de la rafale
  assert.deepEqual(planTgBatch([], coal), []);
});

