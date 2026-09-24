// A note as a Word document. Word, Pages and Google Docs open it; its inkk code
// rides in the document's custom properties (inkk-code, inkk-seal) and its
// keywords, which those apps keep when the file is saved again. The desktop
// companion reads the same fields, so a reader with inkk sees the seal.

import { makeZip } from "./zip";

const FACE_FONTS = { fell: "IM FELL English", garamond: "EB Garamond", sans: "Helvetica Neue" };

const x = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The editor's HTML as paragraphs of runs: [[{ text, b, i }]].
function paragraphsOf(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html || "";
  const paras = [[]];
  const walk = (node, fmt) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue) paras[paras.length - 1].push({ text: n.nodeValue, ...fmt }); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === "BR") { paras.push([]); continue; }
      if (tag === "IMG") continue;
      const next = { b: fmt.b || tag === "B" || tag === "STRONG", i: fmt.i || tag === "I" || tag === "EM" };
      const block = /^(DIV|P|H[1-6]|LI|BLOCKQUOTE)$/.test(tag);
      if (block && paras[paras.length - 1].length) paras.push([]);
      walk(n, next);
      if (block) paras.push([]);
    }
  };
  walk(tpl.content, { b: false, i: false });
  while (paras.length && !paras[paras.length - 1].length) paras.pop();
  return paras;
}

const run = (r) => `<w:r>${r.b || r.i ? `<w:rPr>${r.b ? "<w:b/>" : ""}${r.i ? "<w:i/>" : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;

export function docxOf({ title, html, author, face = "fell", code, seal }) {
  const font = FACE_FONTS[face] || FACE_FONTS.fell;
  const body = paragraphsOf(html).map((p) => `<w:p>${p.map(run).join("")}</w:p>`).join("");
  const heading = title ? `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${x(title)}</w:t></w:r></w:p>` : "";
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const keywords = code ? `inkk:${code} ${seal}` : "";

  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${code ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' : ""}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>${code ? '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>' : ""}</Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${heading}${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    { name: "word/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${x(font)}" w:hAnsi="${x(font)}" w:cs="${x(font)}"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr><w:rPr><w:sz w:val="36"/></w:rPr></w:style></w:styles>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title || "")}</dc:title><dc:creator>${x(author || "")}</dc:creator><cp:keywords>${x(keywords)}</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>inkk</Application></Properties>` },
  ];
  if (code) {
    files.push({ name: "docProps/custom.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="inkk-code"><vt:lpwstr>${x(code)}</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="inkk-seal"><vt:lpwstr>${x(seal)}</vt:lpwstr></property></Properties>` });
  }
  return new Blob([makeZip(files)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
