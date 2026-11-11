// Command text in the sidebar (verb codes, empty composer slots, the echo line) is set in --ink-3 on --panel or
// --panel-2. It must stay readable: WCAG contrast of at least 4.5:1, in Day and in Night.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');
function tokens(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`No ${selector} block in app.css`);
  const block = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
}
const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe.each([['Day', ':root'], ['Night', ":root[data-theme='dark']"]])('%s theme', (_name, selector) => {
  const t = tokens(selector);
  it.each(['panel', 'panel-2'])('--ink-3 and --ink-2 on --%s are at least 4.5:1', bg => {
    expect(contrast(t['ink-3'], t[bg])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['ink-2'], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it('the accent that marks the active slot is at least 3:1 on --panel (non-text)', () => {
    expect(contrast(t.accent, t.panel)).toBeGreaterThanOrEqual(3);
  });
});
