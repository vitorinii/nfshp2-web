// /stats: the counts from /stats.json (web/stats.mjs), for whoever has the key. The key comes in the link (/stats#key), is kept in this
// browser and taken out of the address bar. The page also leaves this browser out of the counts, unless that is unticked.
const $ = id => document.getElementById(id);
const KEY = 'hp2.stats.key', ME = 'hp2.nocount';
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let key = decodeURIComponent(location.hash.slice(1).replace(/^k=/, ''));
if (key) { store.set(KEY, key); history.replaceState(null, '', location.pathname); }
else key = store.get(KEY) || '';

const WHY = { https: 'Not over https', isolation: 'Server headers missing', webgpu: 'No WebGPU (browser)',
  gpu: 'WebGPU off or GPU not supported', old: 'Browser too old', storage: 'No storage (private window)' };
const region = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = c => (c === '?' ? 'Unknown' : (region?.of(c) || c));
const num = n => n.toLocaleString('en');
const time = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);

function locked(text) {
  $('open').hidden = true;
  $('me-row').hidden = true;
  $('locked').hidden = false;
  if (text) $('locked-text').textContent = text;
}

// a table from a head row and body rows; a cell is text or {v, zero}
function table(el, head, rows) {
  el.replaceChildren();
  if (head) {
    const tr = el.createTHead().insertRow();
    for (const h of head) { const th = document.createElement('th'); th.textContent = h; tr.append(th); }
  }
  const body = el.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r) {
      const td = tr.insertCell();
      if (c && typeof c === 'object') { td.textContent = c.v; if (c.zero) td.className = 'zero'; if (c.cls) td.className = c.cls; if (c.span) td.colSpan = c.span; }
      else td.textContent = c;
    }
  }
}
const cell = (n, fmt = num) => ({ v: fmt(n), zero: !n });

function sum(days) {
  const t = { visits: 0, visitors: 0, plays: 0, players: 0, minutes: 0, preloads: 0, cant: 0 };
  const maps = { why: {}, stops: {}, countries: {}, browsers: {} };
  for (const d of days) {
    for (const k in t) t[k] += d[k] || 0;
    for (const k in maps) for (const [n, v] of Object.entries(d[k] || {})) maps[k][n] = (maps[k][n] || 0) + v;
  }
  return { ...t, ...maps };
}
const dayBefore = (day, n) => new Date(Date.parse(day) - n * 86400000).toISOString().slice(0, 10);

function list(el, map, name = x => x, max = 15) {
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, v]) => [name(k), num(v)]);
  table(el, null, rows.length ? rows : [[{ v: 'Nothing yet', cls: 'empty', span: 2 }]]);
}

function show(s) {
  const all = Object.keys(s.days).sort();
  const at = (from) => all.filter(d => d >= from).map(d => s.days[d]);
  const today = s.days[s.today] || {};
  $('now').textContent = num(s.playingNow);
  $('t-players').textContent = num(today.players || 0);
  $('t-visitors').textContent = num(today.visitors || 0);
  $('t-time').textContent = time(today.minutes || 0);
  if (all.length) $('since').textContent = `Counted on the server since ${all[0]}. Days are in UTC. Updates every 30 seconds.`;

  const ranges = [['Today', at(s.today)], ['Last 7 days', at(dayBefore(s.today, 6))], ['Last 30 days', at(dayBefore(s.today, 29))],
    ['All time', all.map(d => s.days[d])]];
  table($('totals'), ['', 'Visitors', 'Players', 'Plays', 'Time played', 'Could not run', 'Preloads'],
    ranges.map(([name, days]) => { const t = sum(days); return [name, cell(t.visitors), cell(t.players), cell(t.plays), cell(t.minutes, time), cell(t.cant), cell(t.preloads)]; }));

  const recent = all.slice().reverse().slice(0, 60);
  table($('days'), ['Day', 'Visitors', 'Players', 'Plays', 'Time played', 'Could not run', 'Stops'],
    recent.length ? recent.map(day => {
      const d = s.days[day];
      const stops = Object.values(d.stops || {}).reduce((a, b) => a + b, 0);
      return [day, cell(d.visitors), cell(d.players), cell(d.plays), cell(d.minutes, time), cell(d.cant), cell(stops)];
    }) : [[{ v: 'Nothing counted yet', cls: 'empty', span: 7 }]]);

  const month = sum(at(dayBefore(s.today, 29)));
  list($('countries'), month.countries, countryName);
  list($('browsers'), month.browsers);
  list($('why'), month.why, w => WHY[w] || w);
  list($('stops'), month.stops, x => x, 20);
}

async function load() {
  if (!key) return locked();
  let r;
  try { r = await fetch('/stats.json', { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' }); }
  catch { return; }                               // offline for a moment: the next try
  if (r.status === 401) { store.set(KEY, null); key = ''; return locked('That key did not match. Open the page again with your link.'); }
  if (r.status === 404) return locked('This server keeps no counts: start it with --stats <file>.');
  if (!r.ok) return;
  $('locked').hidden = true;
  $('open').hidden = false;
  $('me-row').hidden = false;
  if (store.get(ME) == null) store.set(ME, '1');    // the owner's own visits stay out, from the first time the key works here
  $('me').checked = store.get(ME) === '1';
  show(await r.json());
}

$('me').addEventListener('change', () => store.set(ME, $('me').checked ? '1' : '0'));

load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
