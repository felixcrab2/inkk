// inkk companion — just enough ZIP to put a code inside a Word document.
//
// A .docx is a ZIP of XML parts. Stamping one means changing two or three small
// parts and leaving every other byte of the file alone, so an entry that isn't
// being changed is copied through exactly as it was: its local header, its
// compressed data and its data descriptor. Only replaced and added entries are
// written anew (deflated). ZIP64 archives are refused rather than guessed at.

"use strict";

const zlib = require("node:zlib");

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50, SIG_DESC = 0x08074b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEnd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_END) return i;
  throw new Error("not a zip");
}

// → { entries: [{ name, method, crc, compSize, size, flags, raw, central }], comment }
function readZip(buf) {
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("zip64 not supported");
  const comment = buf.subarray(end + 22, end + 22 + buf.readUInt16LE(end + 20));
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("bad central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 not supported");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    const central = buf.subarray(p, p + 46 + nameLen + extraLen + commentLen);
    p += central.length;

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("bad local header");
    const lNameLen = buf.readUInt16LE(localOffset + 26), lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    let rawEnd = dataStart + compSize;
    if (flags & 0x08) {
      // A data descriptor follows the data: 12 bytes, or 16 with its signature.
      rawEnd += rawEnd + 4 <= buf.length && buf.readUInt32LE(rawEnd) === SIG_DESC ? 16 : 12;
    }
    entries.push({ name, method, crc, compSize, size, flags, dataStart, raw: buf.subarray(localOffset, rawEnd), central, buf });
  }
  return { entries, comment };
}

function entryData(e) {
  const data = e.buf.subarray(e.dataStart, e.dataStart + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported compression ${e.method}`);
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function freshEntry(name, data, when) {
  const nameBuf = Buffer.from(name, "utf8");
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const { time, date } = dosTime(when);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  return { raw: Buffer.concat([local, nameBuf, comp]), central: Buffer.concat([central, nameBuf]) };
}

// Rebuild the archive: `replace` maps entry names to new contents, `add` is a
// list of { name, data } appended at the end. Everything else passes through.
function writeZip(zip, { replace = new Map(), add = [] } = {}, when = new Date()) {
  const parts = [], centrals = [];
  let offset = 0;
  const put = (raw, central) => {
    const c = Buffer.from(central);
    c.writeUInt32LE(offset, 42);
    parts.push(raw);
    centrals.push(c);
    offset += raw.length;
  };
  for (const e of zip.entries) {
    if (replace.has(e.name)) {
      const f = freshEntry(e.name, replace.get(e.name), when);
      put(f.raw, f.central);
    } else {
      put(e.raw, e.central);
    }
  }
  for (const a of add) {
    const f = freshEntry(a.name, a.data, when);
    put(f.raw, f.central);
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(zip.comment.length, 20);
  return Buffer.concat([...parts, cd, end, zip.comment]);
}

// A minimal archive from scratch (the tests, and the website's Word export).
function createZip(files, when = new Date()) {
  return writeZip({ entries: [], comment: Buffer.alloc(0) }, { add: files }, when);
}

module.exports = { readZip, entryData, writeZip, createZip, crc32 };
