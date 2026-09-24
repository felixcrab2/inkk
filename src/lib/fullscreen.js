// ─── Browser fullscreen ──────────────────────────────────────────────────────
// Genuine fullscreen (hides the browser's tab strip / address bar). Must be
// called from a user gesture; silently no-ops where unsupported (e.g. iOS Safari).
export function enterBrowserFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { try { Promise.resolve(req.call(el)).catch(() => {}); } catch {} }
}

export function exitBrowserFullscreen() {
  if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit) { try { Promise.resolve(exit.call(document)).catch(() => {}); } catch {} }
}
