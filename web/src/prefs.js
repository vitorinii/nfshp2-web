// The page's own preferences, kept in this browser (localStorage). The renderer reads them every frame; a browser that will not
// keep them (a private window) just starts from the defaults each time.
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

export const prefs = {
  // the bars beside a 4:3 menu in a wide window: a blurred, darkened copy of the picture (on) or black (off, the default: it is
  // experimental, a movie's own dark edge shows against it)
  blurSides: get('hp2.blursides') === '1',
};
export function setBlurSides(on) {
  prefs.blurSides = !!on;
  set('hp2.blursides', on ? '1' : null);         // off is the default: nothing stored
}
