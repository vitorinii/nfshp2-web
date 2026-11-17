// Zip files for the saves' backups: made stored (saves are small), read stored or deflated (a zip made by hand, by the system's own
// "Compress", restores too).

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{name, data: Uint8Array, date?: Date}] -> Blob
export function makeZip(entries) {
  const te = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = te.encode(e.name), crc = crc32(e.data), { time, date } = dosTime(e.date || new Date());
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
    head.setUint32(18, e.data.length, true); head.setUint32(22, e.data.length, true); head.setUint16(26, name.length, true);
    parts.push(head, name, e.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true); c.setUint32(24, e.data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + e.data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ArrayBuffer -> [{name, data: Uint8Array}], the files only; throws on what is no zip
export async function readZip(buf) {
  const v = new DataView(buf), td = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a zip.');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('This zip is damaged.');
    const method = v.getUint16(at + 10, true), csize = v.getUint32(at + 20, true), usize = v.getUint32(at + 24, true);
    const nlen = v.getUint16(at + 28, true), xlen = v.getUint16(at + 30, true), clen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = td.decode(new Uint8Array(buf, at + 46, nlen));
    at += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = new Uint8Array(buf, start, csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error(`${name}: this zip's compression is not supported.`);
    if (data.length !== usize) throw new Error(`${name}: this zip is damaged.`);
    out.push({ name, data });
  }
  return out;
}
