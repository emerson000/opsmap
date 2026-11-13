// Scroll the sidebar so a control is in view. The sidebar's body (`.scroll`) is the only scroll container: these
// scroll it directly, because scrollIntoView would also scroll the fixed app shell.

/**
 * Bring `el` into view in its sidebar body: at the top (`start`) or by the least scroll (`nearest`), clear of
 * the composer's pinned foot (`[data-pinned]`) unless `el` is inside it.
 */
export function reveal(el: Element | null | undefined, block: 'start' | 'nearest' = 'nearest', margin = 8): void {
  const box = el?.closest<HTMLElement>('.scroll');
  if (!el || !box) return;
  last = { el, block, margin, at: Date.now() };
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  const foot = box.querySelector<HTMLElement>('[data-pinned]');
  const covered = foot && !foot.contains(el) && getComputedStyle(foot).position === 'sticky' ? foot.offsetHeight : 0;
  const top = b.top + margin, bottom = b.bottom - covered - margin;
  if (block === 'start' || r.top < top) box.scrollTop += r.top - top;
  else if (r.bottom > bottom) box.scrollTop += Math.min(r.bottom - bottom, r.top - top);
}

let last: { el: Element; block: 'start' | 'nearest'; margin: number; at: number } | null = null;
/** The sheet changed shape (the keyboard went down): bring the last control revealed in the past 2 s back into view. */
export function revealAgain(): void {
  if (last && last.el.isConnected && Date.now() - last.at < 2000) reveal(last.el, last.block, last.margin);
}

/** Run `fn` on the next frame and again once the phone sheet has finished changing height (180 ms). */
export function settle(fn: () => void): void {
  requestAnimationFrame(fn);
  setTimeout(fn, 240);
}
