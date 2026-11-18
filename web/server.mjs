// The server for NFS Hot Pursuit 2 in the browser. Node.js 20 or newer, no dependencies:
//   node web/server.mjs [--port 8080] [--host 127.0.0.1] [--data game] [--log logs/browser.log] [--no-log] [--stats stats.json]
//
//   /              the page (web/src), with the headers SharedArrayBuffer needs (cross-origin isolated)
//   /hp2.wasm      the module (build/web/hp2.wasm), gzipped once in memory for browsers that take it
//   /version       the version of the page and the module, as they were when the server started: an open page asks for it to know
//                  a newer one is out (a deploy: the files copied, then the server restarted)
//   /game.json     the game folder's list: every file's path, size and time, and a version made from them
//   /game?f=<path> a file of the game folder (NFSHP2/ from the disc, data/SLUS_203.62), read-only, in byte ranges, for the page only.
//                  No file extension in the address: a CDN (Cloudflare) caches names like ZZDATA.BIN and then answers ranges whole
//   /log           POST: the page's console appended to --log (on by default only when serving this computer alone), and only
//                  from a browser on this computer: a tunnel or proxy (Cloudflare's) also connects from here, for everyone
//   /hi            POST: what the page tells for the counts (a visit, a play, a minute played, a stop), kept with --stats only
//   /stats         the counts (web/src/stats.html), for whoever has the key in stats.key next to the --stats file (web/stats.mjs)
//
// The players' saves never reach the server: they stay in each browser (web/src/saves.js).
// Other computers need https (a secure page): put it behind a proxy with a certificate.
import { createServer } from 'node:http';
import { createReadStream, promises as fsp, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const PORT = +arg('--port', process.env.PORT || 8080);
const HOST = arg('--host', '127.0.0.1');
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const DATA = path.resolve(arg('--data', path.join(repo, 'game')));
const LOG = process.argv.includes('--no-log') ? null : arg('--log', LOCAL ? path.join(repo, 'logs/browser.log') : null);
const LOG_MAX = 64 << 20;
const STATIC = path.join(here, 'src');
const WASM = path.join(repo, 'build/web/hp2.wasm');
const STATS = arg('--stats', null) ? (await import('./stats.mjs')).createStats(arg('--stats')) : null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.wgsl': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

// on every answer: the isolation SharedArrayBuffer needs, and what a browser may do with the page (only its own scripts, workers and
// connections, compiled WebAssembly, never inside another site's frame)
const CSP = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self'", "connect-src 'self'",
  "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join('; ');
function headers(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');     // browsers keep it from https answers only
}
const etagOf = st => `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;

// the version of what the page is made of: the module and web/src (not the counts' page), made at the start. Not again as files change:
// a deploy copies them one by one, and a page that reloaded halfway would have some of each; the restart after the copy says it is done
async function pageVersion() {
  const names = (await fsp.readdir(STATIC)).filter(n => !n.startsWith('.') && !n.startsWith('stats.')).sort();
  const tags = await Promise.all([WASM, ...names.map(n => path.join(STATIC, n))].map(f => fsp.stat(f).then(etagOf, () => '-')));
  return createHash('sha1').update(JSON.stringify([names, tags])).digest('hex').slice(0, 12);
}
const VERSION = Buffer.from(JSON.stringify({ v: await pageVersion() }));

// ---- the game folder's list, made once (and again when the folder's top changes) -------------------------------------------------
let listing = null;
async function gameList() {
  const top = await fsp.stat(DATA);
  if (listing && listing.top === top.mtimeMs) return listing;
  const files = [];
  async function walk(dir, rel) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name, full = path.join(dir, e.name);
      if (e.isDirectory()) { files.push({ p: r, d: 1 }); await walk(full, r); }
      else if (e.isFile()) { const st = await fsp.stat(full); files.push({ p: r, s: st.size, m: Math.floor(st.mtimeMs) }); }
    }
  }
  await walk(DATA, '');
  const version = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const size = files.reduce((n, f) => n + (f.s || 0), 0);
  const body = Buffer.from(JSON.stringify({ version, size, files }));
  listing = { top: top.mtimeMs, body, etag: `"${version}"`, count: files.length, size };
  return listing;
}

// a path under the game folder, or null: no "..", no hidden names
function gamePath(rel) {
  let parts;
  try { parts = decodeURIComponent(rel).split('/').filter(Boolean); } catch { return null; }
  if (!parts.length || parts.some(s => s === '..' || s === '.' || s.startsWith('.') || s.includes('\\') || s.includes('\0'))) return null;
  return path.join(DATA, ...parts);
}

async function sendFile(req, res, file, type, cache = 'no-cache') {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end(); }
  if (!st.isFile()) { res.writeHead(404); return res.end(); }
  const etag = etagOf(st);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304); return res.end(); }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const a = +range[1], b = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (a >= st.size || b < a) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// the module: 25 MB, about a quarter gzipped; made once per build
let wasmGz = null;
async function sendWasm(req, res) {
  let st;
  try { st = await fsp.stat(WASM); } catch { res.writeHead(404); return res.end(); }
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '') || req.headers.range) return sendFile(req, res, WASM, 'application/wasm');
  const etag = etagOf(st).replace(/"$/, '-gz"');
  if (!wasmGz || wasmGz.etag !== etag) wasmGz = { etag, body: gzipSync(await fsp.readFile(WASM), { level: 6 }), size: st.size };
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip', 'Content-Length': wasmGz.body.length,
    'X-Size': wasmGz.size });
  res.end(req.method === 'HEAD' ? undefined : wasmGz.body);
}

// a browser on this computer, not someone through a proxy that runs here
function fromHere(req) {
  const a = req.socket.remoteAddress || '';
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')
    && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && !req.headers['forwarded']
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
}

// who is asking: the visitor's address as the tunnel or proxy on this computer passes it on, else the connection's
function clientOf(req) {
  const a = req.socket.remoteAddress || '';
  const local = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return { ip: (local && req.headers['cf-connecting-ip']) || a, ua: String(req.headers['user-agent'] || '').slice(0, 300),
    country: local ? req.headers['cf-ipcountry'] : undefined };
}
let wrongKeys = { at: 0, n: 0 };            // keys that did not match in the last minute, from anyone

async function readBody(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  headers(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  try {
    if (p === '/log') {
      if (!LOG || !fromHere(req)) { res.writeHead(404); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const text = (await readBody(req, 1 << 20)).toString('utf8');
      const now = await fsp.stat(LOG).then(s => s.size, () => 0);
      if (now < LOG_MAX) await fsp.appendFile(LOG, text);
      res.writeHead(204); return res.end();
    }
    if (p === '/hi') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const site = req.headers['sec-fetch-site'];
      const body = await readBody(req, 512);
      if (STATS && (!site || site === 'same-origin')) {
        try { STATS.hit(JSON.parse(body.toString('utf8')), clientOf(req)); } catch {}
      }
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p === '/stats.json') {
      res.setHeader('Cache-Control', 'no-store');
      const now = Date.now();
      if (now - wrongKeys.at > 60000) wrongKeys = { at: now, n: 0 };
      if (!STATS) { res.writeHead(404); return res.end(); }
      if (wrongKeys.n >= 20) { res.writeHead(429); return res.end(); }
      if (!STATS.allowed(req.headers.authorization)) { wrongKeys.n++; res.writeHead(401); return res.end(); }
      const body = Buffer.from(JSON.stringify(STATS.summary()));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (p === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': VERSION.length, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : VERSION);
    }
    if (p === '/game.json') {
      const l = await gameList();
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', l.etag);
      if (req.headers['if-none-match'] === l.etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': l.body.length });
      return res.end(req.method === 'HEAD' ? undefined : l.body);
    }
    if (p === '/game' || p.startsWith('/game/')) {
      // the page's own requests only: an address typed or linked from elsewhere is refused (a browser says where a request comes from)
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') { res.writeHead(403); return res.end(); }
      const file = gamePath(p === '/game' ? encodeURIComponent(url.searchParams.get('f') || '').replace(/%2F/gi, '/') : p.slice(6));
      if (!file) { res.writeHead(400); return res.end(); }
      return await sendFile(req, res, file, undefined, 'no-store');
    }
    if (p === '/hp2.wasm') return await sendWasm(req, res);
    let rel = decodeURIComponent(p);
    if (rel === '/') rel = '/index.html';
    else if (rel === '/stats') rel = '/stats.html';
    const file = path.join(STATIC, path.normalize(rel));
    if (!file.startsWith(STATIC + path.sep)) { res.writeHead(403); return res.end(); }
    return await sendFile(req, res, file, TYPES[path.extname(file)]);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) res.writeHead(e.status || 500);
    res.end();
  }
});

statSync(path.join(DATA, 'NFSHP2'));
statSync(path.join(DATA, 'data', 'SLUS_203.62'));
if (LOG) await fsp.mkdir(path.dirname(LOG), { recursive: true });
const l = await gameList();
// the counts on disk before a stop (systemctl stop, Ctrl+C)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  try { STATS?.save(); } catch (e) { console.error(`stats: ${e.message}`); }
  process.exit(0);
});
server.listen(PORT, HOST, () => {
  const where = LOCAL ? `http://localhost:${PORT}/` : `port ${PORT} on ${HOST} (open it through your https address)`;
  console.log(`hp2: ${where}`);
  console.log(`     game ${DATA}: ${l.count} entries, ${(l.size / 1e9).toFixed(2)} GB${LOG ? `; the page's log: ${LOG}` : ''}`);
  if (STATS) console.log(`     counts in ${path.resolve(arg('--stats'))}; to see them, /stats with the key in ${STATS.keyFile}`);
});
