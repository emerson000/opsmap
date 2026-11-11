// Reactive sync client for the Svelte app. Owns the session, the SyncEngine,
// the presented document (shared doc + local view preference) and the local cache for a fast first paint.
import type { Doc } from '../../core/model/types';
import { importJson } from '../../core/model/json';
import { setDoc } from '../model/store.svelte';
import { useRemote } from '../commands/dispatch';
import { features } from '../model/features.svelte';
import { clearRecent } from '../commands/recent.svelte';
import { STORAGE_KEY as V1_KEY } from '../model/persist';
import { lastResult, toast } from '../ui/shell.svelte';
import { SyncEngine, type Cache, type OpMeta, type SocketLike, type Status } from './engine';
import { colorOf, initialsOf, type MapInfo, type Op, type PresenceEntry, type User } from './protocol';

export interface Me extends User { isAdmin?: boolean }
export const isAdmin = (me: Me | null): boolean => Boolean(me && (me.isAdmin || me.admin));
type View = Doc['settings']['view'];

const VIEW_KEY = 'opsmap.ui.view';
/** Before multiple maps there was one cache; the server always sends a full doc, so it is simply dropped. */
const LEGACY_CACHE_KEY = 'opsmap.v2.cache';
const CACHE_PREFIX = 'opsmap.v2.cache.';
/** The map this browser last had open. The ?map= URL parameter wins over it. */
const MAP_KEY = 'opsmap.ui.map';
const cacheKey = (map: string) => CACHE_PREFIX + map;
const LOCAL_DONE_KEY = 'opsmap.v2.localImported';

function read(key: string): string | null { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } }
function write(key: string, value: string | null): void {
  try { if (value === null) globalThis.localStorage?.removeItem(key); else globalThis.localStorage?.setItem(key, value); } catch { /* storage may be full or disabled */ }
}

export const session = $state({
  phase: 'loading' as 'loading' | 'login' | 'ready' | 'error',
  me: null as Me | null,
  devUsers: [] as string[],
  error: '',
});

export const live = $state({
  status: 'connecting' as Status,
  pending: 0,
  /** Bumped on every engine change, so log annotations recompute. */
  version: 0,
  online: [] as PresenceEntry[],
  users: {} as Record<string, User>,
  /** A v1 browser map is present and has not been imported yet. */
  localMap: false,
  /** Every shared map; the first is the server's default. */
  maps: [] as MapInfo[],
  /** The open map ('' until the server names it). */
  mapId: '',
});

const initialView = read(VIEW_KEY);
export const prefs = $state({ view: (initialView === 'staff' || initialView === 'detail' ? initialView : 'commander') as View });

let engine: SyncEngine | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;

function readCache(map: string | undefined): Cache | null {
  if (!map) return null;
  const raw = read(cacheKey(map));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Cache;
    if (!Number.isSafeInteger(value.seq) || !Array.isArray(value.ops)) return null;
    return { seq: value.seq, doc: importJson(JSON.stringify(value.doc)), ops: value.ops };
  } catch { write(cacheKey(map), null); return null; }
}
function saveCacheSoon(): void {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(saveCache, 1000);
}
function saveCache(): void {
  if (engine?.map && engine.seq > 0) write(cacheKey(engine.map), JSON.stringify(engine.cache()));
}

/** Shared doc with this browser's view preference laid over it. */
function present(): void {
  if (!engine) return;
  const doc = engine.doc;
  setDoc(doc.settings.view === prefs.view ? doc : { ...doc, settings: { ...doc.settings, view: prefs.view } });
}

function mirror(): void {
  if (!engine) return;
  live.status = engine.status;
  live.pending = engine.pendingCount;
  live.online = engine.presence;
  live.users = Object.fromEntries(engine.users);
  if (engine.maps.length) live.maps = engine.maps;
  if ((engine.vikunja?.url ?? null) !== (features.vikunja?.url ?? null)) features.vikunja = engine.vikunja;
  if (engine.map && engine.map !== live.mapId) { live.mapId = engine.map; remember(engine.map); }
  live.version++;
}

export function userOf(id: string): User | undefined { return live.users[id] ?? (session.me?.id === id ? session.me : undefined); }
export function initials(id: string): string { return id === 'system' ? 'SYS' : initialsOf(userOf(id), id); }
export function color(id: string): string { return id === 'system' ? 'var(--ink-3)' : colorOf(userOf(id), id); }
export function nameOf(id: string): string { return id === 'system' ? 'Daily turn' : userOf(id)?.name ?? id; }

/** The other users online and what they have selected (one entry per user). */
export function others(): PresenceEntry[] {
  const me = session.me?.id;
  return live.online.filter(p => p.userId !== me);
}

function describe(meta: OpMeta): string {
  if (meta.reverts === undefined) return meta.log;
  const target = engine?.meta.get(meta.reverts);
  if (!target) return meta.log;
  if (target.reverts === undefined) return `UNDONE: ${target.log}`;
  const original = engine?.meta.get(target.reverts);
  return `REDONE: ${original?.log ?? target.log}`;
}

export interface Annotation { userId: string; initials: string; color: string; name: string; ai: boolean; via?:string; undone: boolean; text?: string }
/** Author and undo state for a doc log entry, when this client knows the op that wrote it. */
export function annotate(logId: string): Annotation | null {
  void live.version;
  const info = engine?.entryInfo(logId);
  if (!info) {const entry=engine?.doc.log.find(l=>l.id===logId);if(!entry?.by)return null;return {userId:entry.by,initials:initials(entry.by),color:color(entry.by),name:nameOf(entry.by),ai:entry.via?.startsWith('mcp')??false,via:entry.via?.startsWith('mcp:')?entry.via.slice(4):undefined,undone:false};}
  const { meta } = info;
  return {
    userId: meta.userId, initials: initials(meta.userId), color: color(meta.userId), name: nameOf(meta.userId),
    ai: meta.source === 'mcp', via:meta.via?.startsWith('mcp:')?meta.via.slice(4):undefined, undone: info.undone, text: meta.reverts !== undefined ? describe(meta) : undefined,
  };
}

/** Core reverts restore the doc without a log line, so undo/redo lines come from op metadata. */
export function revertLines(): { id: string; at: string; text: string; by: Annotation }[] {
  void live.version;
  if (!engine) return [];
  const lines = [];
  for (const meta of engine.meta.values()) {
    if (meta.reverts === undefined || meta.logIds.length) continue;
    lines.push({ id: `op-${meta.seq}`, at: meta.at, text: describe(meta), by: {
      userId: meta.userId, initials: initials(meta.userId), color: color(meta.userId), name: nameOf(meta.userId), ai: meta.source === 'mcp', via:meta.via?.startsWith('mcp:')?meta.via.slice(4):undefined, undone: false,
    } });
  }
  return lines;
}

function onOp(op: Op, own: { kind: string } | undefined): void {
  const meta = engine?.meta.get(op.seq);
  if (own && meta && op.cmd.verb === 'revert') {
    lastResult.text = describe(meta); lastResult.ok = true; lastResult.seq++;
  } else if (!own && op.source === 'system' && op.cmd.verb === 'turn') {
    toast(`Daily turn: ${op.log}`, 'info');
  } else if (op.cmd.verb === 'import' && op.userId === session.me?.id) {
    toast('Map imported for everyone', 'info');
  }
}

function wsUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`;
}

/** Keep this browser's last map and the address bar in step with the open map. */
function remember(map: string): void {
  write(MAP_KEY, map);
  try {
    const url = new URL(globalThis.location.href);
    const isDefault = live.maps[0]?.id === map;
    if (isDefault ? url.searchParams.has('map') : url.searchParams.get('map') !== map) {
      if (isDefault) url.searchParams.delete('map'); else url.searchParams.set('map', map);
      globalThis.history?.replaceState(globalThis.history.state, '', url);
    }
  } catch { /* no location in tests */ }
}

function requestedMap(): string | undefined {
  try { const fromUrl = new URL(globalThis.location.href).searchParams.get('map'); if (fromUrl) return fromUrl; } catch { /* no location */ }
  return read(MAP_KEY) ?? undefined;
}

function connect(map: string | undefined): void {
  engine?.stop();
  engine = new SyncEngine({
    connect: () => new WebSocket(wsUrl()) as unknown as SocketLike,
    cache: readCache(map),
    map,
    onMapChange: () => { toast(`That map was deleted. Showing ${mapName(engine?.map ?? '')}.`, 'info'); },
    onChange: () => { mirror(); present(); saveCacheSoon(); },
    onReject: (error, item) => {
      if (item.kind === 'op') toast(`Not saved: ${error}`);
      else toast(error);
      lastResult.text = error; lastResult.ok = false; lastResult.seq++;
    },
    onOp,
    onAuthSuspect: () => { void recheck(); },
  });
  useRemote({
    submit: cmd => engine!.submit(cmd),
    request: kind => { engine!.request(kind); return { ok: true, log: `${kind.toUpperCase()} SENT` }; },
    setView: view => { prefs.view = view as View; write(VIEW_KEY, view); present(); },
    vk: args => {
      void engine!.vk(args).then(r => {
        if (r.ok) { lastResult.text = r.log; lastResult.ok = true; lastResult.seq++; toast(r.log, 'info'); }
        else { lastResult.text = r.error; lastResult.ok = false; lastResult.seq++; toast(r.error); }
      });
    },
  });
  mirror(); present();
  engine.start();
}

async function fetchMe(): Promise<Response | null> {
  try { return await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } }); } catch { return null; }
}

/** Load the session; on success open the socket, otherwise show the login screen. */
export async function boot(): Promise<void> {
  live.localMap = read(V1_KEY) !== null && read(LOCAL_DONE_KEY) === null;
  const res = await fetchMe();
  if (!res) { session.phase = 'error'; session.error = 'The opsmap server is not reachable.'; return; }
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* not JSON: wrong server */ }
  if (res.status === 401) {
    session.devUsers = Array.isArray(body.devUsers) ? body.devUsers.filter((u): u is string => typeof u === 'string') : [];
    session.phase = 'login';
    return;
  }
  if (!res.ok || typeof body.id !== 'string') { session.phase = 'error'; session.error = 'The opsmap server sent an unexpected answer.'; return; }
  session.me = body as unknown as Me;
  session.phase = 'ready';
  write(LEGACY_CACHE_KEY, null);
  connect(requestedMap());
}

/** The socket keeps failing before a welcome: if the session is gone, go back to the login screen. */
async function recheck(): Promise<void> {
  const res = await fetchMe();
  if (res?.status === 401) { engine?.stop(); useRemote(null); session.phase = 'login'; session.me = null; }
}

export function setSelection(id: string | null): void { engine?.setSelection(id); }

/** Admin only: replace the shared map with a JSON document. The op arrives over the socket. */
export async function importShared(text: string, mapId = live.mapId): Promise<boolean> {
  try { importJson(text); } catch (e) { toast(e instanceof Error ? e.message : 'Invalid document'); return false; }
  let res: Response;
  try {
    res = await fetch(`/api/import?map=${encodeURIComponent(mapId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: text });
  } catch { toast('Import failed: the server is not reachable'); return false; }
  if (res.ok) return true;
  let error = `Import failed (${res.status})`;
  try { const body = await res.json(); if (typeof body.error === 'string') error = `Import failed: ${body.error}`; } catch { /* keep status text */ }
  toast(error);
  return false;
}

// ---- maps ---------------------------------------------------------------------------------------

export function mapName(id: string): string { return live.maps.find(m => m.id === id)?.name ?? 'the default map'; }
export function currentMap(): MapInfo | undefined { return live.maps.find(m => m.id === live.mapId); }

/** Open another map. Refused while changes on this map still wait for the server. */
export function switchMap(id: string): boolean {
  if (!engine || id === live.mapId) return true;
  if (engine.pendingCount) { toast(`Wait: ${engine.pendingCount} change${engine.pendingCount === 1 ? '' : 's'} on this map not saved yet`); return false; }
  saveCache();
  live.mapId = id; live.online = [];
  clearRecent(); // unit ids belong to the map they came from
  remember(id);
  connect(id);
  return true;
}

async function mapRequest(method: string, path: string, body?: unknown): Promise<{ ok: true; map?: MapInfo } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { return { ok: false, error: 'The server is not reachable' }; }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* keep status */ }
  if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `Request failed (${res.status})` };
  return { ok: true, map: data.map as MapInfo | undefined };
}

/** Create a map (empty, or from a JSON document) and open it. */
export async function createMap(name: string, doc?: string): Promise<boolean> {
  let parsed: unknown;
  if (doc !== undefined) { try { parsed = JSON.parse(doc); importJson(doc); } catch (e) { toast(e instanceof Error ? e.message : 'Invalid document'); return false; } }
  const res = await mapRequest('POST', '/api/maps', { name, ...(parsed === undefined ? {} : { doc: parsed }) });
  if (!res.ok) { toast(`Map not created: ${res.error}`); return false; }
  if (res.map && !live.maps.some(m => m.id === res.map!.id)) live.maps = [...live.maps, res.map];
  if (res.map) switchMap(res.map.id);
  toast(`Map ${res.map?.name ?? name} created`, 'info');
  return true;
}

export async function renameMap(id: string, name: string): Promise<boolean> {
  const res = await mapRequest('PATCH', `/api/maps/${encodeURIComponent(id)}`, { name });
  if (!res.ok) { toast(`Not renamed: ${res.error}`); return false; }
  if (res.map) live.maps = live.maps.map(m => m.id === id ? { ...m, name: res.map!.name } : m);
  return true;
}

/** Admin only. Everyone on that map is moved to the default map by the server. */
export async function deleteMap(id: string): Promise<boolean> {
  const name = mapName(id);
  // Leave the map first, so this tab does not get bounced off it by the server.
  if (id === live.mapId) {
    const next = live.maps.find(m => m.id !== id);
    if (!next) { toast('The last map cannot be deleted'); return false; }
    if (!switchMap(next.id)) return false;
  }
  const res = await mapRequest('DELETE', `/api/maps/${encodeURIComponent(id)}`);
  if (!res.ok) { toast(`Not deleted: ${res.error}`); return false; }
  write(cacheKey(id), null);
  toast(`Map ${name} deleted`, 'info');
  return true;
}

/** The v1 map saved in this browser, if any. */
export function localMapText(): string | null { return read(V1_KEY); }
export function markLocalImported(): void { write(LOCAL_DONE_KEY, new Date().toISOString()); live.localMap = false; }

export function logout(): void {
  saveCache();
  engine?.stop();
  try {
    const store = globalThis.localStorage;
    for (const key of Object.keys(store ?? {})) if (key.startsWith(CACHE_PREFIX)) store.removeItem(key);
  } catch { /* storage may be disabled */ }
  const form=document.createElement('form');form.method='POST';form.action='/auth/logout';document.body.append(form);form.submit();
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', saveCache);
