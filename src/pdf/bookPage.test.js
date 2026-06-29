import { parseHtmlToBlocks } from "./bookPage";

const textOf = (b) => b.segments.map(seg => seg.map(r => r.text).join("")).join("\n");
const paras  = (html) => parseHtmlToBlocks(html).filter(b => b.type === "text").map(textOf);

test("bare text followed by a div stays as two separate paragraphs", () => {
  // Regression: previously these merged into one paragraph (so only the first
  // justified), because a block element didn't start a new paragraph.
  expect(paras("First paragraph.<div>Second paragraph.</div>"))
    .toEqual(["First paragraph.", "Second paragraph."]);
});

test("consecutive divs each become their own paragraph", () => {
  expect(paras("<div>One</div><div>Two</div><div>Three</div>"))
    .toEqual(["One", "Two", "Three"]);
});

test("blank lines between paragraphs do not create empty paragraphs", () => {
  expect(paras("<div>One</div><div><br></div><div>Two</div>"))
    .toEqual(["One", "Two"]);
});
