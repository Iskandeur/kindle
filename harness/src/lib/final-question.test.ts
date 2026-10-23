import { test } from "node:test";
import assert from "node:assert/strict";
import { finalQuestion } from "./final-question.ts";

test("une question dans le dernier paragraphe est rendue", () => {
  assert.equal(finalQuestion("Fait. Tout est poussé.\n\nTu veux que je fusionne ?"), "Tu veux que je fusionne ?");
});

test("seule la phrase qui porte le dernier « ? » est gardée", () => {
  assert.equal(finalQuestion("Rapport terminé. Je lance la suite ? Réponds-moi vite."), "Je lance la suite ?");
});

test("un compte rendu sans question rend vide", () => {
  assert.equal(finalQuestion("Tout est fait.\n\nRésultat : 12 tests verts."), "");
});

test("une question au milieu, suivie d'un paragraphe sans « ? », ne compte pas", () => {
  assert.equal(finalQuestion("Faut-il pousser ?\n\nJ'ai poussé, c'est fait."), "");
});

test("un « ? » dans un bloc de code ou une URL est ignoré", () => {
  assert.equal(finalQuestion("Voici :\n\n```js\nconst x = a ? b : c;\n```"), "");
  assert.equal(finalQuestion("Voir https://exemple.test/page?id=3"), "");
});

test("les marqueurs de liste ou de gras en tête de phrase sont retirés", () => {
  assert.equal(finalQuestion("Bilan.\n\n- **Je continue ?**"), "Je continue ?");
});

test("entrée non texte, et troncature", () => {
  assert.equal(finalQuestion(null), "");
  assert.equal(finalQuestion(undefined), "");
  const long = `${"mot ".repeat(100)}?`;
  const q = finalQuestion(long, 50);
  assert.equal(q.length, 50);
  assert.ok(q.endsWith("…"));
});
