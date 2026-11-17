// Wire protocol for WebSocket /ws. The client copy of the types; the server owns validation.
import { SYNC_FIELDS, type Command, type Doc, type SyncField } from '../../core/model/types';

export type OpSource = 'web' | 'mcp' | 'system';
export interface User {
  id: string;
  email?: string;
  name?: string;
  initials?: string;
  color?: string;
  admin?: boolean;
}
export interface Op {
  seq: number;
  opId: string;
  userId: string;
  source: OpSource;
  via?: string;
  at: string;
  cmd: Command;
  log: string;
}
export interface PresenceEntry { userId: string; selectedId: string | null }
/** A shared map. The first one in the server's list is the default. */
/** A task service the server has (server/tasksync/contract.ts ProviderDescriptor): its names, nouns and URL templates
 *  ({root} {container} {id}), so the UI can show it without naming any service. `fields`: the field switches (D21) the
 *  service syncs, in SYNC_FIELDS order. */
export interface ProviderDescriptor { id: string; label: string; aliases: string[]; rootNoun: string; containerNoun: string; tokenHelp: string; tokenUrl?: string; urls: { root: string; container?: string; task: string }; fields: SyncField[] }
/** How a bound map learns of remote changes, as the /tasks status answer gives it: one line, and the full reason. */
export interface TaskDelivery { mode: 'off' | 'pending' | 'live' | 'failed'; summary: string; reason: string }
export interface MapInfo { id: string; name: string; createdAt?: string; createdBy?: string | null }

export type ClientMessage =
  | { t: 'hello'; since: number; map?: string }
  | { t: 'op'; opId: string; cmd: Command }
  | { t: 'undo'; opId: string }
  | { t: 'redo'; opId: string }
  | { t: 'presence'; selectedId: string | null }
  | { t: 'tasks'; opId: string; args: Record<string, unknown> }
  | { t: 'tasks-nudge' }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; me: User; users: User[]; seq: number; doc?: Doc; ops?: Op[]; map?: string; maps?: MapInfo[]; fallback?: boolean; taskSync?: ProviderDescriptor[] }
  | { t: 'tasks'; opId: string; ok: boolean; log?: string; error?: string; delivery?: TaskDelivery }
  | { t: 'maps'; maps: MapInfo[] }
  | { t: 'op'; op: Op }
  | { t: 'reject'; opId: string; error: string }
  | { t: 'presence'; users: PresenceEntry[] }
  | { t: 'pong' };

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUser = (v: unknown): v is User => object(v) && typeof v.id === 'string';
const isMap = (v: unknown): v is MapInfo => object(v) && typeof v.id === 'string' && typeof v.name === 'string';
const maps = (v: unknown): MapInfo[] => (v as unknown[]).filter(isMap).map(m => ({ id: m.id, name: m.name, createdAt: m.createdAt, createdBy: m.createdBy }));
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const link = (v: unknown): v is string => text(v) && /^https?:\/\//.test(v);
/** A task service from the welcome, or nothing when it is malformed (links must be http or https). */
function service(v: unknown): ProviderDescriptor[] {
  if (!object(v) || !text(v.id, 64) || !text(v.label, 64) || !Array.isArray(v.aliases) || !v.aliases.every(a => text(a, 64)) || !text(v.rootNoun, 64) || !text(v.containerNoun, 64) || typeof v.tokenHelp !== 'string') return [];
  const urls = v.urls;
  if (!object(urls) || !link(urls.root) || !link(urls.task) || (urls.container !== undefined && !link(urls.container)) || (v.tokenUrl !== undefined && !link(v.tokenUrl))) return [];
  return [{ id: v.id, label: v.label, aliases: [...v.aliases as string[]], rootNoun: v.rootNoun, containerNoun: v.containerNoun, tokenHelp: v.tokenHelp.slice(0, 2000),
    ...(v.tokenUrl !== undefined ? { tokenUrl: v.tokenUrl as string } : {}), urls: { root: urls.root, task: urls.task, ...(urls.container !== undefined ? { container: urls.container as string } : {}) },
    fields: SYNC_FIELDS.filter(f => Array.isArray(v.fields) && v.fields.includes(f)) }];
}
const MODES = ['off', 'pending', 'live', 'failed'];
function delivery(v: unknown): TaskDelivery | undefined {
  return object(v) && MODES.includes(v.mode as string) && text(v.summary, 200) && typeof v.reason === 'string' ? { mode: v.mode as TaskDelivery['mode'], summary: v.summary, reason: v.reason.slice(0, 2000) } : undefined;
}
export const isOp = (v: unknown): v is Op => object(v) && Number.isSafeInteger(v.seq) && typeof v.opId === 'string' &&
  typeof v.userId === 'string' && typeof v.at === 'string' && object(v.cmd) && typeof v.cmd.verb === 'string' && object(v.cmd.args);

/** Parse a server frame. Unknown or malformed frames return null and are ignored. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!object(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'welcome':
      if (!isUser(v.me) || !Array.isArray(v.users) || !Number.isSafeInteger(v.seq)) return null;
      if (v.ops !== undefined && !(Array.isArray(v.ops) && v.ops.every(isOp))) return null;
      if (v.doc !== undefined && !object(v.doc)) return null;
      if (v.map !== undefined && typeof v.map !== 'string') return null;
      if (v.maps !== undefined && !Array.isArray(v.maps)) return null;
      return { t: 'welcome', me: v.me, users: v.users.filter(isUser), seq: v.seq as number, doc: v.doc as Doc | undefined, ops: v.ops as Op[] | undefined,
        map: v.map as string | undefined, maps: v.maps === undefined ? undefined : maps(v.maps), fallback: v.fallback === true ? true : undefined,
        taskSync: Array.isArray(v.taskSync) ? v.taskSync.flatMap(service) : [] };
    case 'tasks': return typeof v.opId === 'string' ? { t: 'tasks', opId: v.opId, ok: v.ok === true, log: typeof v.log === 'string' ? v.log : undefined, error: typeof v.error === 'string' ? v.error : undefined, ...(delivery(v.delivery) ? { delivery: delivery(v.delivery) } : {}) } : null;
    case 'maps': return Array.isArray(v.maps) ? { t: 'maps', maps: maps(v.maps) } : null;
    case 'op': return isOp(v.op) ? { t: 'op', op: v.op } : null;
    case 'reject': return typeof v.opId === 'string' ? { t: 'reject', opId: v.opId, error: typeof v.error === 'string' ? v.error : 'Rejected by server' } : null;
    case 'presence':
      if (!Array.isArray(v.users)) return null;
      return { t: 'presence', users: v.users.filter((u): u is PresenceEntry => object(u) && typeof u.userId === 'string')
        .map(u => ({ userId: u.userId, selectedId: typeof u.selectedId === 'string' ? u.selectedId : null })) };
    case 'pong': return { t: 'pong' };
    default: return null;
  }
}

/** Two-letter initials for a user that has none on record. */
export function initialsOf(user: User | undefined, fallbackId = '?'): string {
  if (user?.initials) return user.initials.toUpperCase();
  const name = user?.name || user?.email?.split('@')[0] || user?.id || fallbackId;
  if (name === 'system') return 'SYS';
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

const PALETTE = ['#1f6feb', '#c2410c', '#7c3aed', '#047857', '#b91c1c', '#0e7490'];
/** A stable color for a user without one on record. */
export function colorOf(user: User | undefined, fallbackId = ''): string {
  if (user?.color) return user.color;
  const id = user?.id ?? fallbackId;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
