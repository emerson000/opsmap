// milsymbol rendering for the map: the model's SIDC projection and per-view amplifiers,
// plus the map-only extras (engagement bar, theme text color and halo), as <image> data URLs.
import ms, { type SymbolOptions } from 'milsymbol';
import type { Unit, View } from '../../core/model/types';
import { symbolOptions, toSidc } from '../../core/model/sidc';

export interface MapSymbol {
  href: string; width: number; height: number;
  /** milsymbol insertion point (frame center, or the staff foot on HQ symbols). */
  anchor: { x: number; y: number };
  /** Frame center (octagon anchor). */
  center: { x: number; y: number };
}
export type Theme = 'light' | 'dark';

const THEME_OPTS: Record<Theme, SymbolOptions> = {
  light: { infoColor: '#1f1d18', infoOutlineColor: 'rgba(238,231,211,0.95)', infoOutlineWidth: 3, outlineColor: 'rgba(238,231,211,0.92)', outlineWidth: 3 },
  dark: { modifierColor:'#dbe4d6', infoColor: '#dbe4d6', infoOutlineColor: 'rgba(23,31,27,0.95)', infoOutlineWidth: 3, outlineColor: '#dbe4d6', outlineWidth: 4 },
};

const cache = new Map<string, MapSymbol>();
const LIMIT = 400;
const toHref = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function memo(key: string, make: () => MapSymbol): MapSymbol {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const made = make();
  cache.set(key, made);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
  return made;
}

export function sidcSymbol(sidc: string, options: SymbolOptions): MapSymbol {
  return memo(JSON.stringify([sidc, options]), () => {
    const s = new ms.Symbol(sidc, { simpleStatusModifier: true, ...options });
    return { href: toHref(s.asSVG()), ...s.getSize(), anchor: s.getAnchor(), center: s.getOctagonAnchor() };
  });
}

/**
 * A unit symbol: the model's SIDC and per-view amplifiers (sidc.ts), plus theme text color,
 * a ground-colored halo for legibility over terrain, and the engagement bar on contact.
 */
export function unitSymbol(u: Unit, view: View, size: number, theme: Theme, extra: { contact?: boolean; bare?:boolean } = {}): MapSymbol {
  const options: SymbolOptions = { ...symbolOptions(u, view), size, ...THEME_OPTS[theme] };
  if(extra.bare){options.uniqueDesignation='';delete options.combatEffectiveness;delete options.dtg;delete options.staffComments;delete options.evaluationRating;delete options.type;delete options.reinforcedReduced;delete options.higherFormation;}
  if (extra.contact) options.engagementBar = 'ENG';
  return sidcSymbol(toSidc(u), options);
}

export const HQ_SIDC = '13031002181100000000';         // brigade HQ (the user)
export const SECTOR_HQ_SIDC = '13031002161100000000';  // battalion HQ per sector
export const KEY_TERRAIN_SIDC = '13032500001321000000'; // tactical point: key terrain

export function hqSymbol(designation: string, size: number, theme: Theme): MapSymbol {
  return sidcSymbol(HQ_SIDC, { size, uniqueDesignation: designation, ...THEME_OPTS[theme] });
}
export function sectorHqSymbol(size: number, theme: Theme, designation=''): MapSymbol {
  return sidcSymbol(SECTOR_HQ_SIDC, { size, uniqueDesignation:designation, ...THEME_OPTS[theme] });
}
export function keyTerrainSymbol(size: number, theme: Theme): MapSymbol {
  return sidcSymbol(KEY_TERRAIN_SIDC, { size, ...THEME_OPTS[theme] });
}
export const LINKUP_SIDC = '13032500001311000000';      // tactical point: linkup point
export function linkupSymbol(size: number, theme: Theme): MapSymbol {
  return sidcSymbol(LINKUP_SIDC, { size, ...THEME_OPTS[theme] });
}
