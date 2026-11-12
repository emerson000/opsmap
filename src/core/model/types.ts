export type Affiliation = 'pending'|'unknown'|'assumed'|'friend'|'neutral'|'suspect'|'hostile';
export type Lifecycle = 'todo'|'active'|'blocked'|'done'|'dropped';
export type Presence = 'present'|'planned';
export type Condition = 'none'|'fully-capable'|'damaged'|'destroyed'|'full';
export type Echelon = 'tm'|'sqd'|'sec'|'plt'|'coy'|'bn'|'rgt'|'bde'|'div'|'corps'|'army';
export type CommandPost = 'main'|'tac'|'alt'|'rear';
export type Ring = 'hq'|'near'|'mid'|'far'|'beyond';
export type FunctionKey = 'inf'|'armor'|'ca'|'recon'|'mi'|'eng'|'sig'|'liaison'|'civ'|'med'|'mtf'|'fin'|'sup'|'trans'|'maint'|'sec'|'ad'|'mp'|'eod'|'sf'|'rel'|'learn'|'hq'|'place'|'person'|'event';
export interface Unit {
  id: string;
  designation: string;
  title: string;
  kind: 'unit'|'person'|'place'|'event';
  affiliation: Affiliation;
  fn: FunctionKey;
  echelon?: Echelon;
  lifecycle: Lifecycle;
  presence: Presence;
  condition: Condition;
  strength?: number;
  reinforced?: '+'|'-'|'±';
  taskForce?: boolean;
  /** A task force drawn as one stacked symbol: every unit attached under it is hidden on the map (`/collapse`). */
  collapsed?: boolean;
  parentId?: string;
  sectorId: string;
  pos: { r: number; theta: number };
  posOverride?: boolean;
  dueAt?: string;
  note?: string;
  rating?: string;
  keyTerrain?: boolean;
  /** Command post type: draws the HQ staff with MAIN, TAC, ALT or REAR inside the frame. */
  cp?: CommandPost;
  sidcOverride?: string;
  /** Linked Vikunja task id, when the map is bound to a Vikunja project (`/vk bind`). */
  vk?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}
export interface Order {
  id: string;
  /** `support`: a friendly backing another friendly (allowed across sectors). */
  type: 'attack'|'axis'|'advance'|'move'|'link'|'support';
  from: string;
  to: string | 'hq';
  role?: 'main'|'support';
  kind?: 'dependency'|'handoff';
  planned?: boolean;
  via?: string[];
  createdAt: string;
}
/** `vk`: the Vikunja child project this sector syncs with, when the map is bound. */
export interface Sector { id: string; name: string; startDeg: number; widthDeg: number; color?: string; vk?: number; }
/** Area measures (OBJ, EA, NAI) have a center, a minimum radius (`size`) and optional member units; the drawn
 *  area is centered on its members and grows to enclose them. A unit belongs to at most one area. */
export interface ControlMeasure { id: string; type: 'obj'|'ea'|'nai'|'pl'; name: string; sectorId?: string; pos?: {r:number;theta:number}; size?: number; members?: string[]; date?: string; }
export interface LogEntry { id: string; at: string; text: string; cmd?: string; by?: string; via?: string; }
export interface Doc {
  version: 1;
  sectors: Sector[];
  units: Unit[];
  orders: Order[];
  measures: ControlMeasure[];
  log: LogEntry[];
  intent?: { date: string; text: string };
  lastTurn?: string;
  settings: { view: 'commander'|'staff'|'detail'; theme: 'light'|'dark'; autoAdvance: boolean; tz?: string; /** `/ao size` scale (AO_SIZES); absent = medium. */ aoSize?: number;
    /** The Vikunja project this map (the A/O) is bound to; each sector is one of its child projects. */ vikunja?: { project: number; title: string; /** The user whose Vikunja token syncs it. */ by?: string } };
}
export type Command = { verb: string; args: Record<string, unknown>; raw?: string };
export type View = Doc['settings']['view'];

/** Entity IDs changed by an operation. Audit log entries do not cause undo conflicts. */
export interface Touched { units:string[]; orders:string[]; measures:string[]; sectors:string[]; top:string[]; }
export type EntityCollection = 'units'|'orders'|'measures'|'sectors';
export type TopField = Exclude<keyof Doc, EntityCollection|'log'>;
export type BeforeImage<T> = {id:string; index:number; value:T|null};
export interface InversePatch {
  units:BeforeImage<Unit>[];
  orders:BeforeImage<Order>[];
  measures:BeforeImage<ControlMeasure>[];
  sectors:BeforeImage<Sector>[];
  top:Partial<Record<TopField,unknown>>;
}
