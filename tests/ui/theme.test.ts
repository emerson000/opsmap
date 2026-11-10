import { describe, expect, it } from 'vitest';
import { nextPref, parsePref, resolveTheme, themeLabel } from '../../src/lib/ui/theme';
import { readFileSync } from 'node:fs';

describe('theme preference', () => {
  it('defaults to System and treats a stored v1/v2 choice as an override', () => {
    expect(parsePref(null)).toBe('system');
    expect(parsePref(undefined)).toBe('system');
    expect(parsePref('garbage')).toBe('system');
    expect(parsePref('light')).toBe('light');
    expect(parsePref('dark')).toBe('dark');
  });
  it('System follows the OS; an override ignores it', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('labels the current state and cycles System → Day → Night', () => {
    expect(themeLabel('system', true)).toBe('Theme: System (night)');
    expect(themeLabel('system', false)).toBe('Theme: System (day)');
    expect(themeLabel('dark', false)).toBe('Theme: Night');
    expect([nextPref('system'), nextPref('light'), nextPref('dark')]).toEqual(['light', 'dark', 'system']);
  });
  it('the first-paint script reads the same key and values', () => {
    const js = readFileSync('public/theme-init.js', 'utf8');
    expect(js).toContain("'opsmap.ui.theme'");
    expect(js).toContain('#111814');
    expect(js).toContain('#f6f1e3');
    expect(readFileSync('index.html', 'utf8')).toMatch(/<script src="\/theme-init\.js"><\/script>[\s\S]*<script type="module"/);
  });
});
