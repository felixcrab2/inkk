import { makeVerifyCode, parseVerifyCode, normalizePlainText, isVerifiedTier, __test__ } from "./code";

const { ALPHABET, PREFIX, BODY_LEN } = __test__;
const CODE_RE = new RegExp(`^${PREFIX}-[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

describe("makeVerifyCode", () => {
  test("matches the canonical INKK-XXXX-XXXX-XXXX shape", () => {
    for (let i = 0; i < 50; i++) expect(makeVerifyCode()).toMatch(CODE_RE);
  });

  test("uses only unambiguous Crockford symbols (no I/L/O/U)", () => {
    const body = makeVerifyCode().slice(PREFIX.length + 1).replace(/-/g, "");
    expect(body).toHaveLength(BODY_LEN);
    for (const ch of body) expect(ALPHABET).toContain(ch);
  });

  test("is effectively unique across many draws", () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(makeVerifyCode());
    expect(seen.size).toBe(2000);
  });
});

describe("parseVerifyCode", () => {
  test("round-trips a freshly generated code", () => {
    const code = makeVerifyCode();
    expect(parseVerifyCode(code)).toBe(code);
  });

  test("tolerates lowercase, spaces, missing prefix and ambiguous glyphs", () => {
    const code = makeVerifyCode();
    const body = code.slice(PREFIX.length + 1).replace(/-/g, "");
    // A clean lowercase, spaced, prefixless paste should canonicalise back.
    const messy = body.toLowerCase().split("").join(" ");
    expect(parseVerifyCode(messy)).toBe(code);
  });

  test("maps O→0 and I/L→1 on input", () => {
    // INKK-O0OO-IL11-2345 → the O/I/L should normalise to 0/1.
    expect(parseVerifyCode("INKK-OOOO-ILIL-2345")).toBe("INKK-0000-1111-2345");
  });

  test("rejects wrong-length or junk input", () => {
    expect(parseVerifyCode("")).toBeNull();
    expect(parseVerifyCode(null)).toBeNull();
    expect(parseVerifyCode("INKK-123")).toBeNull();
    expect(parseVerifyCode("not a code at all")).toBeNull();
  });
});

describe("normalizePlainText", () => {
  test("strips tags and collapses whitespace", () => {
    expect(normalizePlainText("<p>Hello   <b>world</b></p>\n<p>again</p>"))
      .toBe("Hello world again");
  });

  test("is stable between HTML and the plain text a reader would copy", () => {
    const html = "<div>The   quick<br>brown fox.</div>";
    const pasted = "The quick brown fox.";
    expect(normalizePlainText(html)).toBe(normalizePlainText(pasted));
  });

  test("normalises non-breaking spaces", () => {
    expect(normalizePlainText("a b")).toBe("a b");
  });

  test("empty in, empty out", () => {
    expect(normalizePlainText("")).toBe("");
    expect(normalizePlainText(null)).toBe("");
  });
});

describe("isVerifiedTier", () => {
  test("Strong and Distinct verify; weaker tiers do not", () => {
    expect(isVerifiedTier("Strong")).toBe(true);
    expect(isVerifiedTier("Distinct")).toBe(true);
    expect(isVerifiedTier("Developing")).toBe(false);
    expect(isVerifiedTier("Faint")).toBe(false);
    expect(isVerifiedTier(null)).toBe(false);
  });
});
