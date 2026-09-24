// Run: node --test lib/signature.test.js
// The clipboard payload only; drawing a name needs Electron and is not tested here.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { clipboardPayload, usesHostedImage } = require("./signature");
const zw = require("./zw");
const { findCodes } = require("./codes");

const CODE = "INKK-7F3A-9K2D-XQ4M";
const SEAL = `https://www.inkk.site/v/${CODE}`;
const HOSTED = `https://www.inkk.site/s/${CODE}.png`;
const rendered = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 131, height: 27 };
const nativeImage = { createFromDataURL: (url) => ({ fromDataUrl: url }) };

// What an HTML parser would put in an attribute: character references resolved.
const unescape = (s) => s
  .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (html, name) => {
  const m = html.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
};

test("the plain text is the name, its code after it, and nothing visible", () => {
  const p = clipboardPayload({ nativeImage, rendered, name: "Ada Writer", code: CODE, seal: SEAL });
  assert.strictEqual(p.text, `Ada Writer${zw.encode(CODE)}`);
  assert.strictEqual(zw.strip(p.text), "Ada Writer");
  assert.ok(!/inkk/i.test(p.text));
  assert.deepStrictEqual(findCodes(p.text), [CODE]);
});

test("the HTML is the linked picture, described by the name and its hidden code", () => {
  const p = clipboardPayload({ nativeImage, rendered, name: "Ada Writer", code: CODE, seal: SEAL });
  assert.match(p.html, /^<a href="https:\/\/www\.inkk\.site\/v\/INKK-7F3A-9K2D-XQ4M" style="text-decoration:none;border:0"><img src="data:image\/png;base64,iVBORw0KGgo=" width="131" height="27" alt="[^"]+" style="border:0;display:inline-block;vertical-align:baseline"><\/a>$/);
  assert.strictEqual(attr(p.html, "alt"), `Ada Writer${zw.encode(CODE)}`);
  assert.strictEqual(p.alt, p.text);
  assert.ok(!/\stitle=/.test(p.html));
  // The markup itself is plain ASCII, so no character set can mangle it.
  assert.match(p.html, /^[\x20-\x7e]*$/);
});

test("a hosted picture is used when there is one, the data URL otherwise", () => {
  const hosted = clipboardPayload({ nativeImage, rendered, name: "Ada", code: CODE, seal: SEAL, imageUrl: HOSTED });
  assert.strictEqual(attr(hosted.html, "src"), HOSTED);
  const local = clipboardPayload({ nativeImage, rendered, name: "Ada", code: CODE, seal: SEAL, imageUrl: null });
  assert.strictEqual(attr(local.html, "src"), rendered.dataUrl);
  const insecure = clipboardPayload({ nativeImage, rendered, name: "Ada", code: CODE, seal: SEAL, imageUrl: "http://example.com/x.png" });
  assert.strictEqual(attr(insecure.html, "src"), rendered.dataUrl);
  // The picture on the clipboard is always the one drawn on this Mac.
  assert.deepStrictEqual(hosted.image, { fromDataUrl: rendered.dataUrl });
});

test("names are escaped, and non-ASCII letters survive", () => {
  const p = clipboardPayload({ nativeImage, rendered, name: "Zoë \"Z\" <Brontë> & co", code: CODE, seal: SEAL });
  assert.strictEqual(attr(p.html, "alt"), `Zoë "Z" <Brontë> & co${zw.encode(CODE)}`);
  assert.strictEqual(p.html.match(/<img/g).length, 1);
  assert.strictEqual(p.text, `Zoë "Z" <Brontë> & co${zw.encode(CODE)}`);
});

test("browsers and Outlook get the hosted picture; Apple Mail and the rest embed it", () => {
  for (const id of ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta",
    "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera", "org.mozilla.firefox", "com.microsoft.Outlook"]) {
    assert.strictEqual(usesHostedImage(id), true, id);
  }
  for (const id of ["com.apple.mail", "com.readdle.smartemail-Mac", "com.apple.TextEdit", "", null, undefined]) {
    assert.strictEqual(usesHostedImage(id), false, String(id));
  }
});
