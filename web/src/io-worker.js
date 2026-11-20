// The I/O worker: the process's file system. Game threads post WASI file calls into their RPC slot and block; this worker serves them
// (asynchronously: a slow read for one never holds up another) and writes the results straight into the shared wasm memory.
//
// One preopened directory, fd 3, "/":
//   /data/...   the game folder, read-only: NFSHP2/ from the disc and data/SLUS_203.62. Read in 1 MB blocks, kept in memory (an LRU of
//               BLOCK_KEEP bytes): from this browser's copy where the file was preloaded (store.js, game/), from the server otherwise
//               (HTTP range requests, retried through a dropped connection: net.js)
//   /...        everything else: the save folder, in this browser (store.js, save/): hp2.ini, saves/. A file opened for writing is held
//               whole here and written back when it is closed (or synced, or every two seconds while it changes)
import { E, Op, opName, RPC_BYTES, RPC_DONE, RPC_I32, RPC_I64_BYTE, RPC_POSTED, CTL_IO_BELL } from './proto.js';
import { PART, dirAt, gameRoot, lookup, partName, readGameIndex, saveRoot, writeFile } from './store.js';
import { fetchRange } from './net.js';

let memory, ctl, rpcI32, rpcI64, slots = 0;
const u8 = () => new Uint8Array(memory.buffer);
const dv = () => new DataView(memory.buffer);
const td = new TextDecoder(), te = new TextEncoder();
const log = s => postMessage({ t: 'log', fd: 2, s: `[io] ${s}` });

// ---- the game folder, from the server's manifest ----------------------------------------------------------------------------
const tree = new Map();             // "data/NFSHP2/ZZDATA.BIN" -> {d, s}; directories have kids
function addNode(p, node) {
  tree.set(p, node);
  const cut = p.lastIndexOf('/'), parent = cut < 0 ? '' : p.slice(0, cut);
  const dir = tree.get(parent);
  if (dir && dir.kids) dir.kids.set(p.slice(cut + 1), node);
}
let saveDir, gameDir;
async function loadManifest() {
  const r = await fetch('/game.json');
  if (!r.ok) throw new Error(`the game folder's list: HTTP ${r.status}`);
  const { files } = await r.json();
  const kept = (await readGameIndex()).files || {};
  tree.set('', { d: 1, kids: new Map() });
  addNode('data', { d: 1, kids: new Map() });
  let local = 0;
  for (const f of files) {
    if (f.d) { addNode('data/' + f.p, { d: 1, kids: new Map() }); continue; }
    const k = kept[f.p], here = !!k && k[0] === f.s && k[1] === f.m;
    local += here;
    addNode('data/' + f.p, { d: 0, s: f.s, here });
  }
  [saveDir, gameDir] = await Promise.all([saveRoot(), gameRoot()]);
  log(`game folder: ${files.length} entries, ${local} files in this browser`);
}

// paths: relative to the root, no leading slash, "." and ".." resolved, case kept (the server's files are as on the disc)
function norm(base, rel) {
  const out = base ? base.split('/') : [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}
const inData = p => p === 'data' || p.startsWith('data/');
// the game folder's own entry, case-insensitively as a disc's
function dataNode(p) {
  const n = tree.get(p);
  if (n) return n;
  const parts = p.split('/');
  let cur = tree.get(''), at = '';
  for (const part of parts) {
    if (!cur || !cur.kids) return null;
    let next = cur.kids.get(part), name = part;
    if (!next) for (const [k, v] of cur.kids) if (k.toLowerCase() === part.toLowerCase()) { next = v; name = k; break; }
    if (!next) return null;
    at = at ? at + '/' + name : name;
    cur = next;
  }
  cur.realPath = at;
  return cur;
}
const realData = p => { const n = dataNode(p); return n && n.realPath ? n.realPath : p; };

// ---- the save folder, in this browser --------------------------------------------------------------------------------------------
const parts = p => p.split('/').filter(Boolean);
async function sStat(p) {
  const h = await lookup(saveDir, parts(p));
  if (!h) return null;
  if (h.kind === 'dir') return { d: 1, s: 0 };
  const f = await h.handle.getFile();
  return { d: 0, s: f.size, m: f.lastModified };
}
async function sRead(p) {
  const h = await lookup(saveDir, parts(p));
  return h && h.kind === 'file' ? new Uint8Array(await (await h.handle.getFile()).arrayBuffer()) : null;
}
// one write at a time per file: the two-second flush and a close can meet
const writing = new Map();
function sWrite(p, data) {
  const key = p.toLowerCase();
  const next = (writing.get(key) || Promise.resolve()).then(() => writeFile(saveDir, parts(p), data));
  writing.set(key, next.catch(() => {}));
  return next.then(() => E.SUCCESS, e => { log(`write ${p}: ${e.message}`); return E.IO; });
}
async function sOp(op, p, to) {
  const ps = parts(p);
  const h = await lookup(saveDir, ps);
  switch (op) {
  case 'mkdir': {
    if (h) return E.EXIST;
    const parent = await dirAt(saveDir, ps.slice(0, -1));
    if (!parent) return E.NOENT;
    await parent.getDirectoryHandle(ps[ps.length - 1], { create: true });
    return E.SUCCESS;
  }
  case 'unlink':
    if (!h) return E.NOENT;
    if (h.kind !== 'file') return E.ISDIR;
    await h.parent.removeEntry(h.name);
    return E.SUCCESS;
  case 'rmdir':
    if (!h) return E.NOENT;
    if (h.kind !== 'dir') return E.NOTDIR;
    if (!h.parent) return E.ACCES;
    try { await h.parent.removeEntry(h.name); } catch (e) { return e.name === 'InvalidModificationError' ? E.NOTEMPTY : E.IO; }
    return E.SUCCESS;
  case 'rename': {
    if (!h) return E.NOENT;
    if (h.kind !== 'file') return E.NOTSUP;          // the game renames files only (an old profile's save.dat)
    const data = new Uint8Array(await (await h.handle.getFile()).arrayBuffer());
    const r = await sWrite(to, data);
    if (r !== E.SUCCESS) return r;
    await h.parent.removeEntry(h.name);
    return E.SUCCESS;
  }
  }
  return E.NOSYS;
}
async function sList(p) {
  const h = await lookup(saveDir, parts(p));
  if (!h || h.kind !== 'dir') return null;
  const out = [];
  for await (const [n, c] of h.handle.entries()) out.push({ n, d: c.kind === 'directory' ? 1 : 0 });
  return out;
}
async function stat(p) {
  if (p === '') return { d: 1, s: 0 };
  if (inData(p)) { const n = dataNode(p); return n ? { d: n.d, s: n.s || 0 } : null; }
  return sStat(p);
}

// ---- the block cache -----------------------------------------------------------------------------------------------------------
const BLOCK = 1 << 20, BLOCK_KEEP = 384 << 20;
async function fetchBlock(p, i) {
  const n = tree.get(p);
  if (n && n.here) {
    try {
      const at = i * BLOCK, ps = parts(p).slice(1);
      if (n.s > PART) {       // a big file is kept in pieces (store.js)
        const k = Math.floor(at / PART), name = ps[ps.length - 1];
        n.pieces ||= [];
        n.pieces[k] ||= await (await lookup(gameDir, [...ps.slice(0, -1), partName(name, k)])).handle.getFile();
        return new Uint8Array(await n.pieces[k].slice(at - k * PART, at - k * PART + BLOCK).arrayBuffer());
      }
      n.file ||= await (await lookup(gameDir, ps)).handle.getFile();
      return new Uint8Array(await n.file.slice(at, at + BLOCK).arrayBuffer());
    } catch (e) {
      log(`${p}: this browser's copy could not be read (${e.message}), from the server instead`);
      n.here = false;
    }
  }
  const size = n ? n.s : (i + 1) * BLOCK;
  return fetchRange(parts(p).slice(1).join('/'), i * BLOCK, Math.min((i + 1) * BLOCK, size) - 1, { log });     // "data/X" -> "X"
}
const blocks = new Map();           // key -> Uint8Array, in use order (Map keeps insertion order: re-inserted on use)
const inflight = new Map();
let kept = 0;
function block(p, i) {
  const key = p + '#' + i;
  const b = blocks.get(key);
  if (b) { blocks.delete(key); blocks.set(key, b); return b; }
  let f = inflight.get(key);
  if (!f) {
    f = (async () => {
      try {
        const data = await fetchBlock(p, i);
        blocks.set(key, data);
        kept += data.length;
        while (kept > BLOCK_KEEP) { const [k, v] = blocks.entries().next().value; blocks.delete(k); kept -= v.length; }
        return data;
      } finally {
        inflight.delete(key);         // a failed read is not kept: the next one asks again
      }
    })();
    inflight.set(key, f);
  }
  return f;
}
// bytes [pos, pos + n) of a game-folder file into the wasm memory at dst; the next block is asked for ahead
async function readData(p, size, pos, n, dst) {
  n = Math.max(0, Math.min(n, size - pos));
  let done = 0;
  while (done < n) {
    const at = pos + done, i = Math.floor(at / BLOCK), off = at - i * BLOCK;
    let b = block(p, i);
    if (b instanceof Promise) b = await b;
    const take = Math.min(n - done, b.length - off);
    if (take <= 0) break;
    u8().set(b.subarray(off, off + take), dst + done);
    done += take;
  }
  const next = Math.floor((pos + n) / BLOCK) + 1;
  if (next * BLOCK < size && !blocks.has(p + '#' + next)) block(p, next).catch(() => {});
  return done;
}

// ---- descriptors ---------------------------------------------------------------------------------------------------------------
// kind: 'dir' | 'data' (read-only game file) | 'rw' (a save-folder file, held whole while open)
const fds = new Map();
fds.set(3, { kind: 'dir', path: '' });
let nextFd = 4;
function newFd(obj) { while (fds.has(nextFd)) nextFd++; fds.set(nextFd, obj); return nextFd++; }

const RIGHT_FD_WRITE = 1n << 6n;
const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
const FDFLAG_APPEND = 1;
const FT_CHAR = 2, FT_DIR = 3, FT_FILE = 4;

function str(ptr, len) { return td.decode(u8().slice(ptr, ptr + len)); }
function basePath(fd) { const f = fds.get(fd); return f && f.kind === 'dir' ? f.path : null; }

async function pathOpen(a, b) {
  const [dirfd, , pathPtr, pathLen, oflags, , fdflags, fdOut] = a;
  const [rightsBase] = b;
  const base = basePath(dirfd);
  if (base === null) return E.BADF;
  const p = norm(base, str(pathPtr, pathLen));
  const wantWrite = (rightsBase & RIGHT_FD_WRITE) !== 0n || (oflags & (O_CREAT | O_TRUNC)) !== 0;
  if (inData(p)) {
    const n = dataNode(p);
    if (!n) return (oflags & O_CREAT) ? E.ROFS : E.NOENT;
    if (n.d) { dv().setUint32(fdOut, newFd({ kind: 'dir', path: realData(p) }), true); return E.SUCCESS; }
    if (oflags & O_DIRECTORY) return E.NOTDIR;
    if (wantWrite) return E.ROFS;
    dv().setUint32(fdOut, newFd({ kind: 'data', path: realData(p), size: n.s, pos: 0 }), true);
    return E.SUCCESS;
  }
  const st = p === '' ? { d: 1 } : await sStat(p);
  if (st && st.d) {
    if (wantWrite && !(oflags & O_DIRECTORY)) return E.ISDIR;
    dv().setUint32(fdOut, newFd({ kind: 'dir', path: p }), true);
    return E.SUCCESS;
  }
  if (oflags & O_DIRECTORY) return st ? E.NOTDIR : E.NOENT;
  if (!st && !(oflags & O_CREAT)) return E.NOENT;
  if (st && (oflags & O_CREAT) && (oflags & O_EXCL)) return E.EXIST;
  let data = new Uint8Array(0), dirty = false;
  if (st && !(oflags & O_TRUNC)) {
    data = await sRead(p);
    if (!data) return E.IO;
  }
  if (!st || (oflags & O_TRUNC)) dirty = true;          // made, or emptied: written back even if nothing else is
  const f = { kind: 'rw', path: p, data, size: data.length, pos: 0, dirty, write: wantWrite, append: (fdflags & FDFLAG_APPEND) !== 0 };
  dv().setUint32(fdOut, newFd(f), true);
  return E.SUCCESS;
}

async function flush(f) {
  if (f.kind !== 'rw' || !f.dirty || !f.write) return E.SUCCESS;
  f.dirty = false;
  return sWrite(f.path, f.data.slice(0, f.size));
}

function iovs(ptr, n) {
  const d = dv(), out = [];
  for (let i = 0; i < n; i++) out.push([d.getUint32(ptr + i * 8, true), d.getUint32(ptr + i * 8 + 4, true)]);
  return out;
}

async function fdRead(a) {
  const [fd, iovPtr, iovCnt, nreadPtr] = a;
  const f = fds.get(fd);
  if (!f) return E.BADF;
  if (f.kind === 'dir') return E.ISDIR;
  let total = 0;
  for (const [buf, len] of iovs(iovPtr, iovCnt)) {
    let got;
    if (f.kind === 'data') got = await readData(f.path, f.size, f.pos, len, buf);
    else { got = Math.max(0, Math.min(len, f.size - f.pos)); u8().set(f.data.subarray(f.pos, f.pos + got), buf); }
    f.pos += got;
    total += got;
    if (got < len) break;
  }
  dv().setUint32(nreadPtr, total, true);
  return E.SUCCESS;
}

function fdWrite(a) {
  const [fd, iovPtr, iovCnt, nwrittenPtr] = a;
  const f = fds.get(fd);
  if (!f) return E.BADF;
  if (f.kind !== 'rw' || !f.write) return f.kind === 'data' ? E.ROFS : E.BADF;
  let total = 0;
  for (const [buf, len] of iovs(iovPtr, iovCnt)) {
    if (f.append) f.pos = f.size;
    const end = f.pos + len;
    if (end > f.data.length) { const grown = new Uint8Array(Math.max(end, f.data.length * 2, 4096)); grown.set(f.data.subarray(0, f.size)); f.data = grown; }
    f.data.set(u8().subarray(buf, buf + len), f.pos);
    f.pos = end;
    if (end > f.size) f.size = end;
    total += len;
  }
  f.dirty = true;
  dv().setUint32(nwrittenPtr, total, true);
  return E.SUCCESS;
}

function fdSeek(a, b) {
  const [fd, whence, newOffPtr] = a;
  const [offset] = b;
  const f = fds.get(fd);
  if (!f) return E.BADF;
  if (f.kind === 'dir') return E.ISDIR;
  const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.size;
  const pos = base + Number(offset);
  if (pos < 0) return E.INVAL;
  f.pos = pos;
  dv().setBigUint64(newOffPtr, BigInt(pos), true);
  return E.SUCCESS;
}

function writeFilestat(ptr, type, size, mtimeMs = 0) {
  const d = dv();
  for (let i = 0; i < 64; i += 4) d.setUint32(ptr + i, 0, true);
  d.setBigUint64(ptr + 8, BigInt(size + 1), true);        // an inode of sorts
  d.setUint8(ptr + 16, type);
  d.setBigUint64(ptr + 24, 1n, true);
  d.setBigUint64(ptr + 32, BigInt(size), true);
  const ns = BigInt(Math.floor(mtimeMs)) * 1000000n;
  d.setBigUint64(ptr + 40, ns, true), d.setBigUint64(ptr + 48, ns, true), d.setBigUint64(ptr + 56, ns, true);
}

async function pathFilestat(a) {
  const [fd, , pathPtr, pathLen, out] = a;
  const base = basePath(fd);
  if (base === null) return E.BADF;
  const p = norm(base, str(pathPtr, pathLen));
  const st = await stat(p);
  if (!st) return E.NOENT;
  writeFilestat(out, st.d ? FT_DIR : FT_FILE, st.s || 0, st.m || 0);
  return E.SUCCESS;
}

function fdFilestat(a) {
  const [fd, out] = a;
  const f = fds.get(fd);
  if (fd <= 2) { writeFilestat(out, FT_CHAR, 0); return E.SUCCESS; }
  if (!f) return E.BADF;
  writeFilestat(out, f.kind === 'dir' ? FT_DIR : FT_FILE, f.size || 0);
  return E.SUCCESS;
}

function fdFdstat(a) {
  const [fd, out] = a;
  const d = dv();
  const f = fds.get(fd);
  if (fd > 2 && !f) return E.BADF;
  const type = fd <= 2 ? FT_CHAR : f.kind === 'dir' ? FT_DIR : FT_FILE;
  for (let i = 0; i < 24; i += 4) d.setUint32(out + i, 0, true);
  d.setUint8(out, type);
  d.setUint16(out + 2, f && f.append ? FDFLAG_APPEND : 0, true);
  d.setBigUint64(out + 8, 0xffffffffffffffffn, true);
  d.setBigUint64(out + 16, 0xffffffffffffffffn, true);
  return E.SUCCESS;
}

async function fdReaddir(a, b) {
  const [fd, buf, bufLen, usedPtr] = a;
  const [cookie] = b;
  const f = fds.get(fd);
  if (!f) return E.BADF;
  if (f.kind !== 'dir') return E.NOTDIR;
  if (!f.list || cookie === 0n) {
    let names;
    if (inData(f.path) || f.path === '') {
      const n = f.path === '' ? tree.get('') : dataNode(f.path);
      names = n && n.kids ? [...n.kids].map(([k, v]) => ({ n: k, d: v.d })) : [];
      if (f.path === '') for (const e of await sList('') || []) if (e.n.toLowerCase() !== 'data') names.push(e);
    } else {
      names = await sList(f.path);
      if (!names) return E.NOENT;
    }
    f.list = [{ n: '.', d: 1 }, { n: '..', d: 1 }, ...names];
  }
  const d = dv(), mem = u8();
  let used = 0;
  for (let i = Number(cookie); i < f.list.length; i++) {
    const name = te.encode(f.list[i].n);
    const head = new Uint8Array(24), hv = new DataView(head.buffer);
    hv.setBigUint64(0, BigInt(i + 1), true);
    hv.setBigUint64(8, BigInt(i + 100), true);
    hv.setUint32(16, name.length, true);
    hv.setUint8(20, f.list[i].d ? FT_DIR : FT_FILE);
    const entry = new Uint8Array(24 + name.length);
    entry.set(head), entry.set(name, 24);
    const take = Math.min(entry.length, bufLen - used);
    mem.set(entry.subarray(0, take), buf + used);
    used += take;
    if (used >= bufLen) break;
  }
  d.setUint32(usedPtr, used, true);
  return E.SUCCESS;
}

async function serve(op, a, b) {
  switch (op) {
  case Op.path_open: return pathOpen(a, b);
  case Op.fd_close: {
    const f = fds.get(a[0]);
    if (!f || a[0] === 3) return E.BADF;
    fds.delete(a[0]);
    if (a[0] < nextFd) nextFd = a[0];
    return flush(f);
  }
  case Op.fd_sync: { const f = fds.get(a[0]); return f ? flush(f) : E.BADF; }
  case Op.fd_read: return fdRead(a);
  case Op.fd_write: return fdWrite(a);
  case Op.fd_seek: return fdSeek(a, b);
  case Op.fd_fdstat_get: return fdFdstat(a);
  case Op.fd_fdstat_set_flags: { const f = fds.get(a[0]); if (!f) return E.BADF; f.append = (a[1] & FDFLAG_APPEND) !== 0; return E.SUCCESS; }
  case Op.fd_prestat_get: {
    if (a[0] !== 3) return E.BADF;
    dv().setUint32(a[1], 0, true), dv().setUint32(a[1] + 4, 1, true);
    return E.SUCCESS;
  }
  case Op.fd_prestat_dir_name: {
    if (a[0] !== 3) return E.BADF;
    if (a[2] >= 1) u8()[a[1]] = 0x2f;           // "/"
    return E.SUCCESS;
  }
  case Op.fd_readdir: return fdReaddir(a, b);
  case Op.path_filestat_get: return pathFilestat(a);
  case Op.fd_filestat_get: return fdFilestat(a);
  case Op.path_create_directory: case Op.path_remove_directory: case Op.path_unlink_file: {
    const base = basePath(a[0]);
    if (base === null) return E.BADF;
    const p = norm(base, str(a[1], a[2]));
    if (inData(p) || p === '') return op === Op.path_create_directory && (p === '' || dataNode(p)) ? E.EXIST : E.ROFS;
    return sOp(op === Op.path_create_directory ? 'mkdir' : op === Op.path_remove_directory ? 'rmdir' : 'unlink', p);
  }
  case Op.path_rename: {
    const b1 = basePath(a[0]), b2 = basePath(a[3]);
    if (b1 === null || b2 === null) return E.BADF;
    const from = norm(b1, str(a[1], a[2])), to = norm(b2, str(a[4], a[5]));
    if (inData(from) || inData(to)) return E.ROFS;
    return sOp('rename', from, to);
  }
  case Op.path_readlink: return E.INVAL;
  }
  return E.NOSYS;
}

// ---- the RPC loop ------------------------------------------------------------------------------------------------------------
// A posting thread bumps CTL_IO_BELL and notifies it; this worker waits on it with Atomics.waitAsync (or a message on its port where
// there is none), then takes every slot that is posted. Each call runs on its own: a read waiting for the server holds up nobody else.
const busy = new Set();
function take() {
  for (let s = 0; s < slots; s++) {
    const base = s * (RPC_BYTES / 4);
    if (busy.has(s) || Atomics.load(rpcI32, base) !== RPC_POSTED) continue;
    busy.add(s);
    const op = rpcI32[base + 1], n = rpcI32[base + 3];
    const a = [], b = [];
    for (let i = 0; i < n; i++) a.push(rpcI32[base + RPC_I32 + i] >>> 0);
    for (let i = 0; i < 4; i++) b.push(rpcI64[(s * RPC_BYTES + RPC_I64_BYTE) / 8 + i]);
    (async () => {
      let r;
      try { r = await serve(op, a, b); }
      catch (e) { log(`${opName(op)}: ${e && e.message || e}`); r = E.IO; }
      rpcI32[base + 2] = r;
      busy.delete(s);
      Atomics.store(rpcI32, base, RPC_DONE);
      Atomics.notify(rpcI32, base);
    })();
  }
}
async function loop() {
  for (;;) {
    const seen = Atomics.load(ctl, CTL_IO_BELL);
    take();
    if (Atomics.waitAsync) {
      const w = Atomics.waitAsync(ctl, CTL_IO_BELL, seen, 1000);
      if (w.async) await w.value;
    } else {
      await new Promise(r => setTimeout(r, 1));
    }
  }
}

onmessage = async e => {
  const m = e.data;
  if (m.t !== 'init') return;
  ({ memory } = m);
  ctl = new Int32Array(m.ctl);
  rpcI32 = new Int32Array(m.rpc);
  rpcI64 = new BigInt64Array(m.rpc);
  slots = m.slots;
  try {
    await loadManifest();
    postMessage({ t: 'ready' });
    loop();
    // what is written and not yet closed is stored every two seconds: a tab closed mid-game keeps it
    setInterval(() => { for (const f of fds.values()) if (f.kind === 'rw' && f.dirty && f.write) flush(f).catch(() => {}); }, 2000);
  } catch (err) {
    postMessage({ t: 'fatal', s: `I/O worker: ${err.message}` });
  }
};
