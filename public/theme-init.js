// Runs before the app's CSS and JS: set data-theme so the first paint uses the right theme.
// Mirrors src/lib/ui/theme.ts (parsePref + resolveTheme). External file, so the CSP needs no hash.
(function () {
  var pref = null;
  try { pref = localStorage.getItem('opsmap.ui.theme'); } catch (e) { /* storage blocked */ }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#111814' : '#f6f1e3');
})();
