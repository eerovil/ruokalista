import assert from "node:assert/strict";
import test from "node:test";

import { boxKind, linksIn, withoutLinks } from "../src/intake-box.ts";
import { givenMaterial, requestFor } from "../src/intake.ts";

/**
 * How the add screen's one box is read (#350), and what a combined import asks
 * the model. The browser and the server both read the box with `intake-box.ts`,
 * so these rules are what decides the button's wording *and* which sites the
 * queue consumer fetches.
 */

test("a link is found anywhere in the text, without the punctuation round it", () => {
  assert.deepEqual(
    linksIn("Tämä, mutta puolet sokeria (https://kotikokki.net/a). Ja www.b.fi/c, kiitos!"),
    ["https://kotikokki.net/a", "www.b.fi/c"],
  );
  assert.deepEqual(linksIn("katso kotikokki.net/reseptit/1 ja kotikokki.net/reseptit/1"), [
    "kotikokki.net/reseptit/1",
  ]);
});

test("a bare host counts only when it is the whole box", () => {
  assert.deepEqual(linksIn("kotikokki.net"), ["kotikokki.net"]);
  assert.deepEqual(linksIn("kotikokki.net on hyvä"), []);
});

test("recipe text with dots is not mistaken for links", () => {
  assert.deepEqual(linksIn("Uunikaali\n1. Kuullota kaali.\n2,5 dl vettä esim. kraanasta\nn.2 tuntia"), []);
  assert.deepEqual(linksIn("Paista 200 asteessa. 1/2 tl suolaa."), []);
});

test("the box is a name, a link or a recipe", () => {
  assert.equal(boxKind(""), "empty");
  assert.equal(boxKind("   \n "), "empty");
  assert.equal(boxKind("Mummin lihapullat"), "name");
  assert.equal(boxKind("https://kotikokki.net/a"), "link");
  assert.equal(boxKind("puolet sokeria kotikokki.net/a"), "link");
  assert.equal(boxKind("Uunikaali\n½ dl öljyä"), "text");
  assert.equal(boxKind("x".repeat(81)), "text");
});

test("what the member wrote is the text with its links taken out", () => {
  assert.equal(withoutLinks("https://kotikokki.net/a"), "");
  assert.equal(
    withoutLinks("Puolet sokeria https://kotikokki.net/a\n\n\n\nja (www.b.fi/c)."),
    "Puolet sokeria\n\nja",
  );
});

test("one piece is passed through unheaded, several are headed", () => {
  assert.equal(givenMaterial("Uunikaali", [], false), "Uunikaali");
  assert.equal(givenMaterial(null, [{ url: "https://a.fi/x", text: "Sivu" }], false), "Sivu");
  assert.equal(
    givenMaterial("Puolet sokeria", [{ url: "https://a.fi/x", text: "Sivu" }], false),
    "Käyttäjän kirjoittama teksti:\nPuolet sokeria\n\nSivu osoitteesta https://a.fi/x:\nSivu",
  );
  assert.equal(
    givenMaterial("Puolet sokeria", [], true),
    "Käyttäjän kirjoittama teksti:\nPuolet sokeria",
  );
});

test("a combined import gets the combined rules, a single source does not", () => {
  const single = requestFor({ route: "linked", url: "https://a.fi/x", text: "Sivu" }, []);
  assert.ok(!single.system.includes("Useasta lähteestä"));

  const mixed = requestFor(
    { route: "linked", url: "https://a.fi/x", text: "kaksi", mixed: true },
    [],
  );
  assert.ok(mixed.system.includes("Useasta lähteestä"));
  assert.ok(mixed.system.includes("Nettisivulta luetun tekstin"));

  const photos = requestFor({
    route: "photographed",
    images: [{ base64: "sivu", mediaType: "image/jpeg" }],
    text: "Käyttäjän kirjoittama teksti:\nPuolet sokeria",
    fromPages: false,
  }, []);
  assert.ok(photos.system.includes("Kuvatun sivun lisäsäännöt"));
  assert.ok(photos.system.includes("Useasta lähteestä"));
  assert.ok(!photos.system.includes("Nettisivulta luetun tekstin"));
  const content = photos.messages[0].content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.text ?? "", /Puolet sokeria/);
  assert.match(content[content.length - 1]?.text ?? "", /yllä annettua tekstiä/);
});
