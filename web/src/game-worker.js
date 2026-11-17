// A game thread. The page starts a pool of these; each instantiates the game module on the shared memory and parks until it is handed
// either the process's entry (_start) or a thread started by wasi thread-spawn. Everything that blocks (sleeps, waits, file I/O) blocks this
// worker only, never the page.
import {
  CTL_EXIT, CTL_EXIT_CODE, CTL_IO_BELL, CTL_NEXT_TID, CTL_POOL, CTL_SLEEP, E, Op, POOL_CLAIMED, POOL_IDLE, POOL_RUN, POOL_RUN_MAIN,
  RPC_BYTES, RPC_DONE, RPC_I32, RPC_I64_BYTE, RPC_IDLE, RPC_POSTED,
} from './proto.js';

let memory, ctl, rpcI32, rpcI64, slot, pool, env, instance;
let tid = 0;
const td = new TextDecoder(), te = new TextEncoder();
let u8v = null, dvv = null;
const u8 = () => (u8v && u8v.buffer === memory.buffer ? u8v : (u8v = new Uint8Array(memory.buffer)));
const dv = () => (dvv && dvv.buffer === memory.buffer ? dvv : (dvv = new DataView(memory.buffer)));
const post = m => postMessage(m);

class ProcExit { constructor(code) { this.code = code; } }

// ---- stdout / stderr: lines to the page ----
const pending = { 1: '', 2: '' };
function writeOut(fd, bytes) {
  pending[fd] += td.decode(bytes, { stream: true });
  let k;
  while ((k = pending[fd].indexOf('\n')) >= 0) { post({ t: 'log', fd, tid, s: pending[fd].slice(0, k) }); pending[fd] = pending[fd].slice(k + 1); }
}

// ---- a call into the I/O worker, synchronous for this thread ----
function io(op, a, b = []) {
  const base = slot * (RPC_BYTES / 4), b64 = (slot * RPC_BYTES + RPC_I64_BYTE) / 8;
  rpcI32[base + 1] = op;
  rpcI32[base + 3] = a.length;
  for (let i = 0; i < a.length; i++) rpcI32[base + RPC_I32 + i] = a[i];
  for (let i = 0; i < b.length; i++) rpcI64[b64 + i] = BigInt.asIntN(64, BigInt(b[i]));
  Atomics.store(rpcI32, base, RPC_POSTED);
  Atomics.add(ctl, CTL_IO_BELL, 1);
  Atomics.notify(ctl, CTL_IO_BELL);
  let waited = 0;
  while (Atomics.load(rpcI32, base) !== RPC_DONE) {
    Atomics.wait(rpcI32, base, RPC_POSTED, 1000);
    if (++waited === 15) post({ t: 'log', fd: 2, tid, s: `[io] thread ${tid}: op ${op} unanswered for 15 s` });
  }
  const r = rpcI32[base + 2];
  Atomics.store(rpcI32, base, RPC_IDLE);
  return r;
}

const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
function sleepMs(ms) { if (ms > 0) Atomics.wait(ctl, CTL_SLEEP, 0, ms); }

const wasi = {
  environ_sizes_get(countPtr, sizePtr) {
    const d = dv();
    d.setUint32(countPtr, env.length, true);
    d.setUint32(sizePtr, env.reduce((n, s) => n + te.encode(s).length + 1, 0), true);
    return E.SUCCESS;
  },
  environ_get(ptrs, buf) {
    const d = dv(), m = u8();
    let at = buf >>> 0;
    env.forEach((s, i) => {
      const b = te.encode(s + '\0');
      d.setUint32((ptrs >>> 0) + i * 4, at, true);
      m.set(b, at);
      at += b.length;
    });
    return E.SUCCESS;
  },
  clock_time_get(id, precision, out) { dv().setBigUint64(out >>> 0, nowNs(), true); return E.SUCCESS; },
  clock_res_get(id, out) { dv().setBigUint64(out >>> 0, 1000n, true); return E.SUCCESS; },
  fd_write(fd, iovs, n, nwritten) {
    if (fd === 1 || fd === 2) {
      const d = dv();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = d.getUint32((iovs >>> 0) + i * 8, true), len = d.getUint32((iovs >>> 0) + i * 8 + 4, true);
        writeOut(fd, u8().slice(p, p + len));
        total += len;
      }
      d.setUint32(nwritten >>> 0, total, true);
      return E.SUCCESS;
    }
    return io(Op.fd_write, [fd, iovs, n, nwritten]);
  },
  fd_read: (fd, iovs, n, nread) => io(Op.fd_read, [fd, iovs, n, nread]),
  fd_close: fd => io(Op.fd_close, [fd]),
  fd_sync: fd => io(Op.fd_sync, [fd]),
  fd_seek: (fd, off, whence, out) => io(Op.fd_seek, [fd, whence, out], [off]),
  fd_tell: (fd, out) => io(Op.fd_seek, [fd, 1, out], [0n]),
  fd_fdstat_get: (fd, out) => io(Op.fd_fdstat_get, [fd, out]),
  fd_fdstat_set_flags: (fd, flags) => io(Op.fd_fdstat_set_flags, [fd, flags]),
  fd_filestat_get: (fd, out) => io(Op.fd_filestat_get, [fd, out]),
  fd_prestat_get: (fd, out) => io(Op.fd_prestat_get, [fd, out]),
  fd_prestat_dir_name: (fd, p, len) => io(Op.fd_prestat_dir_name, [fd, p, len]),
  fd_readdir: (fd, buf, len, cookie, used) => io(Op.fd_readdir, [fd, buf, len, used], [cookie]),
  path_open: (fd, dirflags, p, len, oflags, rightsBase, rightsInh, fdflags, out) =>
    io(Op.path_open, [fd, dirflags, p, len, oflags, 0, fdflags, out], [rightsBase, rightsInh]),
  path_filestat_get: (fd, flags, p, len, out) => io(Op.path_filestat_get, [fd, flags, p, len, out]),
  path_create_directory: (fd, p, len) => io(Op.path_create_directory, [fd, p, len]),
  path_remove_directory: (fd, p, len) => io(Op.path_remove_directory, [fd, p, len]),
  path_unlink_file: (fd, p, len) => io(Op.path_unlink_file, [fd, p, len]),
  path_rename: (fd, p, len, fd2, p2, len2) => io(Op.path_rename, [fd, p, len, fd2, p2, len2]),
  path_readlink: (fd, p, len, buf, blen, used) => io(Op.path_readlink, [fd, p, len, buf, blen, used]),
  // sleeps: the clock subscriptions alone (the runtime polls no descriptors)
  poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
    const d = dv();
    let wait = Infinity;
    const now = Number(nowNs()) / 1e6;
    for (let i = 0; i < nsubs; i++) {
      const s = (inPtr >>> 0) + i * 48;
      if (d.getUint8(s + 8) !== 0) continue;
      const timeout = Number(d.getBigUint64(s + 24, true)) / 1e6, abs = d.getUint16(s + 40, true) & 1;
      wait = Math.min(wait, abs ? timeout - now : timeout);
    }
    if (wait !== Infinity) sleepMs(wait);
    let n = 0;
    for (let i = 0; i < nsubs; i++) {
      const s = (inPtr >>> 0) + i * 48, o = (outPtr >>> 0) + n * 32;
      d.setBigUint64(o, d.getBigUint64(s, true), true);
      d.setUint16(o + 8, 0, true);
      d.setUint8(o + 10, d.getUint8(s + 8));
      n++;
    }
    d.setUint32(neventsPtr >>> 0, n, true);
    return E.SUCCESS;
  },
  sched_yield: () => E.SUCCESS,
  random_get(buf, len) { const b = new Uint8Array(len); crypto.getRandomValues(b); u8().set(b, buf >>> 0); return E.SUCCESS; },
  proc_exit(code) {
    Atomics.store(ctl, CTL_EXIT_CODE, code);
    Atomics.store(ctl, CTL_EXIT, 1);
    throw new ProcExit(code);
  },
  args_sizes_get(c, s) { dv().setUint32(c >>> 0, 0, true); dv().setUint32(s >>> 0, 0, true); return E.SUCCESS; },
  args_get: () => E.SUCCESS,
};

// wasi thread-spawn: an idle worker of the pool takes the thread; its id comes back at once
function threadSpawn(startArg) {
  for (let tries = 0; tries < 2000; tries++) {
    for (let s = 1; s < pool; s++) {
      const at = CTL_POOL + s * 4;
      if (Atomics.compareExchange(ctl, at, POOL_IDLE, POOL_CLAIMED) !== POOL_IDLE) continue;
      const id = Atomics.add(ctl, CTL_NEXT_TID, 1);
      Atomics.store(ctl, at + 1, id);
      Atomics.store(ctl, at + 2, startArg);
      Atomics.store(ctl, at, POOL_RUN);
      Atomics.notify(ctl, at);
      return id;
    }
    sleepMs(1);                         // the pool is busy or still starting: a worker may come free
  }
  post({ t: 'log', fd: 2, tid, s: `[thread] no free worker for a new thread (pool ${pool})` });
  return -E.AGAIN;
}

function run(fn, what) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProcExit) { post({ t: 'exit', code: e.code }); return; }
    Atomics.store(ctl, CTL_EXIT, 1);
    post({ t: 'fatal', tid, s: `${what} (thread ${tid}): ${e && e.stack || e}` });
  } finally {
    for (const fd of [1, 2]) if (pending[fd]) { post({ t: 'log', fd, tid, s: pending[fd] }); pending[fd] = ''; }
  }
}

onmessage = async e => {
  const m = e.data;
  if (m.t !== 'init') return;
  ({ memory, slot, pool, env } = m);
  ctl = new Int32Array(m.ctl);
  rpcI32 = new Int32Array(m.rpc);
  rpcI64 = new BigInt64Array(m.rpc);
  const imports = {
    env: { memory },
    wasi_snapshot_preview1: wasi,
    wasi: { 'thread-spawn': threadSpawn },
    hp2: { register: (kind, ptr, size) => { post({ t: 'register', kind, ptr: ptr >>> 0, size: size >>> 0 }); return 0; } },
  };
  try {
    instance = await WebAssembly.instantiate(m.module, imports);
  } catch (err) {
    post({ t: 'fatal', s: `worker ${slot}: instantiate: ${err.message}` });
    return;
  }
  const at = CTL_POOL + slot * 4;
  Atomics.store(ctl, at, POOL_IDLE);
  post({ t: 'ready', slot });
  // parked: the page's RUN_MAIN (slot 0) or a thread-spawn's RUN
  for (;;) {
    const st = Atomics.load(ctl, at);
    if (st === POOL_RUN_MAIN) {
      tid = 1;
      run(() => instance.exports._start(), 'main');
      return;
    }
    if (st === POOL_RUN) {
      tid = Atomics.load(ctl, at + 1);
      const arg = Atomics.load(ctl, at + 2);
      run(() => instance.exports.wasi_thread_start(tid, arg), 'thread');
      if (Atomics.load(ctl, CTL_EXIT)) return;
      Atomics.store(ctl, at, POOL_IDLE);
      continue;
    }
    Atomics.wait(ctl, at, st);
  }
};
