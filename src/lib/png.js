// Text chunks in a PNG. A downloaded page image carries its inkk code the way
// a PDF does: in metadata (Keywords, inkk-code, inkk-seal), invisible on the
// page, readable by the desktop companion and by the Certify page.

import { crc32 } from "./zip";

const enc = new TextEncoder();

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// entries: { keyword: text } (Latin-1 keywords and values)
export async function withTextChunks(blob, entries) {
  const png = new Uint8Array(await blob.arrayBuffer());
  const ihdrEnd = 8 + 12 + new DataView(png.buffer).getUint32(8);   // signature + IHDR chunk
  const extra = Object.entries(entries).filter(([, v]) => v).map(([k, v]) => chunk("tEXt", enc.encode(`${k}\0${v}`)));
  return new Blob([png.subarray(0, ihdrEnd), ...extra, png.subarray(ihdrEnd)], { type: "image/png" });
}

// → { keyword: text }
export function readTextChunks(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = {};
  const dec = new TextDecoder("latin1");
  let p = 8;
  while (p + 12 <= b.length) {
    const len = v.getUint32(p);
    const type = dec.decode(b.subarray(p + 4, p + 8));
    if (type === "tEXt") {
      const data = dec.decode(b.subarray(p + 8, p + 8 + len));
      const i = data.indexOf("\0");
      if (i > 0) out[data.slice(0, i)] = data.slice(i + 1);
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}
