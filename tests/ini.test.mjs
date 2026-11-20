// node --test tests/ini.test.mjs : the start page's reading and merging of hp2.ini (web/src/ini.js), on text in the game's own format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIni, mergeIni } from '../web/src/ini.js';

// what the game writes (pcconfig.cpp pc_config_save), cut to what matters
const GAME = [
  '; NFS Hot Pursuit 2 (recompiled): settings. The game\'s Options > PC Settings changes them.',
  '; Environment variables (HP2_NOSOUND ...) win over this file.',
  '',
  '[video]',
  'scale=2            ; the picture, times the PS2\'s: 1 to 8',
  'fullscreen=0       ; 1 = borderless fullscreen (Alt+Enter)',
  'window=960,720     ; the window\'s picture',
  'aspect=0           ; the race\'s picture: 0 = 4:3, 1 = 16:10, 2 = 16:9',
  'gamma=100           ; percent, 50 to 200: above 100 lighter',
  'profile=VIT',
  'language=ENGLISH     ; ENGLISH, FRENCH, GERMAN',
  '',
  'log=on             ; on = the game writes speed.log',
  '[audio]',
  'volume=100           ; percent',
  '',
  'key_accelerate=87,0',
  '',
].join('\n');

test('parseIni reads values without their comments and skips sections', () => {
  const v = parseIni(GAME);
  assert.equal(v.scale, '2');
  assert.equal(v.aspect, '0');
  assert.equal(v.window, '960,720');
  assert.equal(v.profile, 'VIT');
  assert.equal(v.log, 'on');
  assert.equal(v.key_accelerate, '87,0');
  assert.equal(v['[video]'], undefined);
});

test('parseIni of nothing is empty', () => {
  assert.deepEqual(parseIni(''), {});
  assert.deepEqual(parseIni(undefined), {});
});

test('mergeIni changes a key in place and keeps its comment and everything else', () => {
  const out = mergeIni(GAME, { aspect: 2, scale: 4 });
  assert.match(out, /^aspect=2 +; the race's picture: 0 = 4:3, 1 = 16:10, 2 = 16:9$/m);
  assert.match(out, /^scale=4 +; the picture, times the PS2's: 1 to 8$/m);
  const before = GAME.split('\n'), after = out.split('\n');
  assert.equal(after.length, before.length);
  const changed = after.filter((l, i) => l !== before[i]);
  assert.equal(changed.length, 2);
  assert.equal(parseIni(out).window, '960,720');
  assert.equal(parseIni(out).profile, 'VIT');
});

test('mergeIni adds a missing key at the end, with a newline after it', () => {
  const out = mergeIni(GAME, { show_fps: 1, brightness: -10 });
  assert.ok(out.endsWith('key_accelerate=87,0\nshow_fps=1\nbrightness=-10\n'));
  assert.equal(parseIni(out).show_fps, '1');
  assert.equal(parseIni(out).brightness, '-10');
  assert.equal(parseIni(out).scale, '2');
});

test('mergeIni makes a file from nothing, with the game\'s [video] heading', () => {
  const out = mergeIni('', { aspect: 2, scale: 3 });
  assert.equal(out, '[video]\naspect=2\nscale=3\n');
  assert.deepEqual(parseIni(out), { aspect: '2', scale: '3' });
});

test('mergeIni keeps a file that is only "aspect=2" (the page\'s own seed) and adds to it', () => {
  const out = mergeIni('aspect=2\n', { scale: 4 });
  assert.equal(out, 'aspect=2\nscale=4\n');
});

test('mergeIni keeps Windows line endings and an unchanged file as it is', () => {
  const crlf = 'scale=2 ; x\r\ngamma=100\r\n';
  assert.equal(mergeIni(crlf, { scale: 3 }), 'scale=3 ; x\r\ngamma=100\r\n');
  assert.equal(mergeIni(GAME, {}), GAME);
});

test('mergeIni does not touch a key that only looks like another (prefix, comment text)', () => {
  const text = 'gamma=100\n; scale=9 is a comment\nscale_x=1\n';
  const out = mergeIni(text, { scale: 2 });
  assert.equal(out, 'gamma=100\n; scale=9 is a comment\nscale_x=1\nscale=2\n');
});
