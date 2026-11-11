// Wire protocol for WebSocket /ws. The client copy of the types; the server owns validation.
import type { Command, Doc } from '../../core/model/types';

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
export interface MapInfo { id: string; name: string; createdAt?: string; createdBy?: string | null }

export type ClientMessage =
  | { t: 'hello'; since: number; map?: string }
  | { t: 'op'; opId: string; cmd: Command }
  | { t: 'undo'; opId: string }
  | { t: 'redo'; opId: string }
  | { t: 'presence'; selectedId: string | null }
  | { t: 'vk'; opId: string; args: Record<string, unknown> }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; me: User; users: User[]; seq: number; doc?: Doc; ops?: Op[]; map?: string; maps?: MapInfo[]; fallback?: boolean; vikunja?: { url: string } | null }
  | { t: 'vk'; opId: string; ok: boolean; log?: string; error?: string }
  | { t: 'maps'; maps: MapInfo[] }
  | { t: 'op'; op: Op }
  | { t: 'reject'; opId: string; error: string }
  | { t: 'presence'; users: PresenceEntry[] }
  | { t: 'pong' };

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUser = (v: unknown): v is User => object(v) && typeof v.id === 'string';
const isMap = (v: unknown): v is MapInfo => object(v) && typeof v.id === 'string' && typeof v.name === 'string';
const maps = (v: unknown): MapInfo[] => (v as unknown[]).filter(isMap).map(m => ({ id: m.id, name: m.name, createdAt: m.createdAt, createdBy: m.createdBy }));
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
        vikunja: object(v.vikunja) && typeof v.vikunja.url === 'string' && /^https?:\/\//.test(v.vikunja.url) ? { url: v.vikunja.url } : null };
    case 'vk': return typeof v.opId === 'string' ? { t: 'vk', opId: v.opId, ok: v.ok === true, log: typeof v.log === 'string' ? v.log : undefined, error: typeof v.error === 'string' ? v.error : undefined } : null;
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
