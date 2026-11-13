// A tab left open (a phone keeps a background tab's page alive for days) keeps running the build it loaded.
// When the page comes back to the foreground, and every 10 minutes while it is shown, fetch the shell and
// compare its entry script with ours: a different one means a deploy, so reload, unless the user is typing.

/** The hashed entry script this page runs, e.g. /assets/index-B--XnDDM.js (null in the dev server). */
const entryOf = (html: string): string | null => html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)?.[1] ?? null;

export function watchForUpdates(): () => void {
  const own = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;
  if (!own) return () => {};
  let busy = false;
  const typing = () => !!document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
  async function check() {
    if (busy || document.visibilityState !== 'visible' || typing()) return;
    busy = true;
    try {
      const res = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
      const entry = res.ok ? entryOf(await res.text()) : null;
      if (entry && entry !== own) location.reload();
    } catch { /* offline: try again later */ } finally { busy = false; }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  const timer = setInterval(check, 10 * 60_000);
  return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onVisible); clearInterval(timer); };
}
