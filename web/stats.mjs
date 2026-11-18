// Counts of how the site is used, for whoever runs it (web/server.mjs --stats <file>): visits, plays, minutes played, browsers that
// cannot run the game, the game's stops. Only numbers per day are kept, nothing about anyone:
//   - a visitor is told apart from another, within one day only, by a hash of their address and browser name with a random key that is
//     thrown away at the end of the day (so a visitor today cannot be matched to one tomorrow, nor the hash back to an address);
//   - nothing is stored in the browser for it (no cookie), and no address is written anywhere.
// The page sends what happens (POST /hi, web/src/main.js); the numbers are at /stats with the key in stats.key, made next to <file>.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const DAY = () => new Date().toISOString().slice(0, 10);       // days in UTC
const CAP = { view: 30, play: 30, stop: 10, preload: 5 };     // what one visitor can add in a day, at most
const WHY = new Set(['https', 'isolation', 'webgpu', 'gpu', 'old', 'storage']);
const KEEP_SEEN = 200000;                                      // visitors a day kept apart, at most

function browserOf(ua) {
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  return `${name} ${/Mobi|Android|iPhone|iPad/.test(ua) ? 'mobile' : 'desktop'}`;
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const emptyDay = () => ({ visits: 0, visitors: 0, plays: 0, players: 0, minutes: 0, preloads: 0, cant: 0,
  why: {}, stops: {}, countries: {}, browsers: {} });

export function createStats(file) {
  file = path.resolve(file);
  const keyFile = path.join(path.dirname(file), 'stats.key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim());

  let data = { v: 1, days: {}, today: null };
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let dirty = false;

  // today's key and visitors (by hash): what each has added, so one browser cannot fill the counts
  function today() {
    const day = DAY();
    if (data.today?.day !== day) { data.today = { day, salt: randomBytes(16).toString('hex'), seen: {} }; dirty = true; }
    return data.days[day] ||= emptyDay();
  }
  const who = (ip, ua) => createHash('sha256').update(`${data.today.salt}|${ip}|${ua}`).digest('base64url').slice(0, 16);

  // one thing the page tells: {e: 'view'|'cant'|'play'|'min'|'stop'|'preload', why: [...], s: '...'}
  function hit(m, { ip, ua, country }) {
    if (!m || typeof m.e !== 'string') return;
    const d = today();
    const h = who(ip, ua);
    let s = data.today.seen[h];
    if (!s) {
      if (Object.keys(data.today.seen).length >= KEEP_SEEN) return;
      s = data.today.seen[h] = {};
      d.visitors++;
      inc(d.countries, /^[A-Z]{2}$/.test(country || '') && country !== 'XX' ? country : '?');
      inc(d.browsers, browserOf(ua));
    }
    const e = m.e;
    if (CAP[e] && (s[e] || 0) >= CAP[e]) return;
    switch (e) {
    case 'view': d.visits++; break;
    case 'cant': {
      if (s.cant) return;
      d.cant++;
      for (const w of Array.isArray(m.why) ? m.why.slice(0, 6) : []) if (WHY.has(w)) inc(d.why, w);
      s.cant = 1;
      break;
    }
    case 'play': d.plays++; if (!s.played) { d.players++; s.played = 1; } break;
    case 'min': {
      const now = Date.now();
      if (now - (s.min || 0) < 50000) return;                    // one a minute, whatever the page sends
      s.min = now;
      d.minutes++;
      break;
    }
    case 'stop': {
      const text = String(m.s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || '?';
      if (!(text in d.stops) && Object.keys(d.stops).length >= 40) return;
      inc(d.stops, text);
      break;
    }
    case 'preload': d.preloads++; break;
    default: return;
    }
    if (CAP[e]) inc(s, e);
    dirty = true;
  }

  // what /stats shows: the days, and who played in the last two minutes
  function summary() {
    today();
    const now = Date.now();
    const playingNow = Object.values(data.today.seen).filter(s => s.min && now - s.min < 150000).length;
    return { days: data.days, today: data.today.day, playingNow };
  }

  function save() {
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  }
  const timer = setInterval(() => { try { save(); } catch (e) { console.error(`stats: ${e.message}`); } }, 30000);
  timer.unref();

  const allowed = header => {
    const m = /^Bearer (\S+)$/.exec(header || '');
    if (!m) return false;
    const got = Buffer.from(m[1]);
    return got.length === key.length && timingSafeEqual(got, key);
  };
  return { hit, summary, save, allowed, keyFile };
}
