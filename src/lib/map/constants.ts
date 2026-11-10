// World space: 1 model ring unit = SCALE world pixels. HQ sits at the world origin.
export const SCALE = 100;
/** milsymbol `size` for ordinary units, sector HQs and the life HQ. */
export const UNIT_SIZE = 25;
export const SECTOR_HQ_SIZE = 20;
export const HQ_SIZE = 18;
/** Radius (world px) arrows keep clear of a unit symbol, before symbol scaling. */
export const UNIT_CLEAR = 22;
export const HQ_CLEAR = 26;
/** Where the sector HQs sit, as a fraction of the HQ ring. */
export const SECTOR_HQ_R = 1;
/** Map edge (PL QUARTER), the beyond band and the outer rim labels, in ring units. */
export const MAP_EDGE_R = 4;
export const BEYOND_R = 4.45;
export const CHEVRON_R = 4.22;
export const RIM_LABEL_R = 4.62;
/** Terrain extent, world px. Larger than any fitted viewport. */
export const TERRAIN_BOUNDS = { x0: -1500, y0: -1100, x1: 1500, y1: 1100 };
export const TERRAIN_SEED = 'opsmap';
