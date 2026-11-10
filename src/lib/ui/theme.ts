// Theme preference: System (follows prefers-color-scheme) unless this browser overrides it.
// The override lives in localStorage under THEME_KEY, never in the shared document.
export type Theme = 'light' | 'dark';
export type ThemePref = 'system' | Theme;
export const THEME_KEY = 'opsmap.ui.theme';
/** <meta name="theme-color"> per resolved theme: the top-bar panel color. */
export const THEME_COLOR: Record<Theme, string> = { light: '#f6f1e3', dark: '#111814' };

/** A stored 'light' or 'dark' (v1/v2 wrote these only when the user chose one) is an override. */
export function parsePref(stored: string | null | undefined): ThemePref {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}
export const PREF_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Day', dark: 'Night' };
/** "Theme: System (night)", "Theme: Day". */
export function themeLabel(pref: ThemePref, systemDark: boolean): string {
  return pref === 'system' ? `Theme: System (${systemDark ? 'night' : 'day'})` : `Theme: ${PREF_LABEL[pref]}`;
}
export const nextPref = (p: ThemePref): ThemePref => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system');
