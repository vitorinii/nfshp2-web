// What this browser keeps for the game, in its private file storage (OPFS, navigator.storage.getDirectory()):
//   save/    the game's own writable folder: hp2.ini (the settings) and saves/<profile>/. Never on the server.
//   game/    the game folder, as far as it was preloaded, and game/.files.json: which of its files are complete, with the size and
//            time the server gave them (a file that changed on the server is fetched again)
// Used by the page (the Saves and Game data panels) and by the I/O worker (the game's file system).

export const SAVE_DIR = 'save', GAME_DIR = 'game', GAME_INDEX = '.files.json';

// A browser's private storage will not hold one file of 2000 MiB or more (Chrome and Brave: writes past it fail or are cut off), and
// ZZDATA.BIN is 2.9 GB. So a game file bigger than PART is kept in pieces of PART bytes, "ZZDATA.BIN.part0", ".part1", ...
// (PART is a multiple of the I/O worker's 1 MiB blocks: a block never crosses two pieces).
export const PART = 1 << 30;
export const partName = (name, k) => `${name}.part${k}`;

let rootP = null;
export const root = () => (rootP ||= navigator.storage.getDirectory());

// a handle's child, case-insensitively when the exact name is missing (the game's names were made on a disc, case-blind)
async function child(dir, name, kind) {
  try { return kind === 'dir' ? await dir.getDirectoryHandle(name) : await dir.getFileHandle(name); }
  catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
  const low = name.toLowerCase();
  for await (const [n, h] of dir.entries()) if (n.toLowerCase() === low && h.kind === (kind === 'dir' ? 'directory' : 'file')) return h;
  return null;
}

// the directory at parts (from base), made on the way when create
export async function dirAt(base, parts, create = false) {
  let d = base;
  for (const part of parts) {
    const next = await child(d, part, 'dir');
    if (next) { d = next; continue; }
    if (!create) return null;
    d = await d.getDirectoryHandle(part, { create: true });
  }
  return d;
}

// {kind: 'dir'|'file', handle, parent, name} for a path under base, or null
export async function lookup(base, parts) {
  if (!parts.length) return { kind: 'dir', handle: base, parent: null, name: '' };
  const parent = await dirAt(base, parts.slice(0, -1));
  if (!parent) return null;
  const name = parts[parts.length - 1];
  const f = await child(parent, name, 'file');
  if (f) return { kind: 'file', handle: f, parent, name: f.name };
  const d = await child(parent, name, 'dir');
  if (d) return { kind: 'dir', handle: d, parent, name: d.name };
  return null;
}

export async function writeFile(base, parts, data) {
  const dir = await dirAt(base, parts.slice(0, -1), true);
  const name = parts[parts.length - 1];
  const fh = (await child(dir, name, 'file')) || await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

// every file under dir: [path, File]
export async function walkFiles(dir, prefix = '') {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') out.push(...await walkFiles(h, p));
    else out.push([p, await h.getFile()]);
  }
  return out;
}

export async function saveRoot() { return (await root()).getDirectoryHandle(SAVE_DIR, { create: true }); }

// A browser with no settings file yet starts at the widest picture its window allows (hp2.ini: aspect=2, 16:9). The game's own default is 4:3,
// which leaves every wide window with bars. The game never draws wider than the window (pc_aspect: the setting, no wider than the canvas), so
// a 4:3 window still shows 4:3. Only when there is no hp2.ini: once the game has written one, the player's own choice (Options > Graphics >
// Resolution > Aspect Ratio) stays. Returns whether it wrote it.
export async function seedSettings() {
  const dir = await saveRoot();
  if (await lookup(dir, ['hp2.ini'])) return false;
  await writeFile(dir, ['hp2.ini'], 'aspect=2\n');
  return true;
}
export async function gameRoot() { return (await root()).getDirectoryHandle(GAME_DIR, { create: true }); }

// the preloaded files: {version, files: {path: [size, time]}}
export async function readGameIndex() {
  try {
    const fh = await (await gameRoot()).getFileHandle(GAME_INDEX);
    return JSON.parse(await (await fh.getFile()).text());
  } catch { return { files: {} }; }
}
export async function writeGameIndex(index) {
  const fh = await (await gameRoot()).getFileHandle(GAME_INDEX, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(index));
  await w.close();
}
