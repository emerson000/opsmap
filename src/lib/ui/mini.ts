// Small list symbols: frame, icon and echelon only (no text amplifiers).
import type { Unit } from '../../core/model/types';
import { toSidc } from '../../core/model/sidc';
import { sidcSymbol, type MapSymbol, type Theme } from '../map/symbols';

export function miniSymbol(u: Unit, theme: Theme, size = 13): MapSymbol {
  const dark = theme === 'dark';
  return sidcSymbol(toSidc(u), { size, civilianColor: u.fn === 'person', ...(dark ? { outlineColor: 'rgba(205,216,200,0.62)', outlineWidth: 2 } : {}) });
}
