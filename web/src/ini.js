// hp2.ini, the game's settings file (upstream recomp/runtime/pcconfig.cpp): "key=value ; comment" lines; [sections] have no "=" and are
// skipped, a ";" starts a comment. The start page's Graphics panel reads it and merges its changes into it, so everything it does not know
// (the controls, the language, a comment) stays exactly as the game wrote it, and the game rewrites the file in its own format whenever its
// menus save. Pure (no DOM, no OPFS): it runs under node (tests/ini.test.mjs).

// the file's keys and their values as text: { scale: '2', aspect: '2', window: '960,720', ... }
export function parseIni(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.split(';')[0];
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

// the file with `changes` ({ key: value }) in it: a key that is there keeps its place, its spacing and its comment, one that is not is added
// at the end. Nothing else is touched. An empty text gets the game's own [video] heading.
const LINE = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)([^;\r\n]*?)(\s*)(;[^\r\n]*)?(\r?)$/;
export function mergeIni(text, changes) {
  const keys = Object.keys(changes);
  const seen = new Set();
  const lines = String(text || '').split('\n').map(line => {
    const m = LINE.exec(line);
    if (!m || !keys.includes(m[2])) return line;
    seen.add(m[2]);
    return `${m[1]}${m[2]}${m[3]}${changes[m[2]]}${m[5]}${m[6] || ''}${m[7]}`;
  });
  const added = keys.filter(k => !seen.has(k)).map(k => `${k}=${changes[k]}`);
  if (!added.length) return lines.join('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) lines.push('[video]');
  return [...lines, ...added, ''].join('\n');
}
