// The game folder from the server, in byte ranges, for the I/O worker (the game's reads) and the page (the preload).
//
// The address has no file extension (/game?f=NFSHP2/ZZDATA.BIN): a CDN in front of the server (Cloudflare) treats a name like
// ZZDATA.BIN as a static file to cache, fetches the whole of it, and can answer a range with all 3 GB. Without the extension it passes
// each request through as it is.
//
// Over the internet a request fails now and then (a dropped connection, a busy proxy): each range is asked for again, for about half a
// minute, before the read fails. The game treats a failed read as a broken disc and stops, so this is what keeps it running.

export const gameUrl = path => '/game?f=' + encodeURIComponent(path);
const DELAYS = [250, 500, 1000, 2000, 4000, 8000, 15000];       // ms between tries: 30.75 s in all
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

// bytes [a, b] of a game file (its path in the game folder: "NFSHP2/ZZDATA.BIN") -> Uint8Array.
// onBytes(n) is told as they come (the preload's progress); log(text) of each try that failed.
export async function fetchRange(path, a, b, { signal, onBytes, log } = {}) {
  const want = b - a + 1;
  for (let k = 0; ; k++) {
    let why, fatal = false;
    try {
      const r = await fetch(gameUrl(path), { headers: { Range: `bytes=${a}-${b}` }, cache: 'no-store', signal });
      const range = /^bytes (\d+)-(\d+)\//.exec(r.headers.get('Content-Range') || '');
      const whole = r.status === 200 && a === 0 && +(r.headers.get('Content-Length') || -1) === want;    // a small file, sent whole
      if ((r.status === 206 && range && +range[1] === a && +range[2] === b) || whole) {
        const out = new Uint8Array(want);
        const reader = r.body.getReader();
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (got + value.length > want) { reader.cancel(); throw new Error(`more than the ${want} bytes asked for`); }
          out.set(value, got);
          got += value.length;
          onBytes?.(value.length);
        }
        if (got === want) return out;
        onBytes?.(-got);
        why = `${got} of ${want} bytes came`;
      } else {
        r.body?.cancel().catch(() => {});
        why = r.status === 200 ? 'the server sent the whole file, not the range asked for'
          : r.status === 206 ? `the wrong range came (${r.headers.get('Content-Range')})` : `HTTP ${r.status}`;
        fatal = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      why = e.message;
    }
    if (fatal || k >= DELAYS.length) throw new Error(`${path} at ${a}: ${why}${fatal ? '' : ', given up'}`);
    log?.(`${path} at ${a}: ${why}; again in ${DELAYS[k] / 1000} s`);
    await sleep(DELAYS[k], signal);
  }
}
