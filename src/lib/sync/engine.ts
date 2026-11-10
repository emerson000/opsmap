// Sync engine: confirmed doc from the server plus optimistic pending ops, rebased on
// every remote op. Pure TypeScript with an injected socket and clock, so it runs under vitest.
import type { Command, Doc } from '../../core/model/types';
import { apply } from '../../core/commands/apply';
import { cloneDoc } from '../../core/model/clone';
import { emptyDoc } from '../../core/model/seed';
import { parseServerMessage, type ClientMessage, type MapInfo, type Op, type OpSource, type PresenceEntry, type ServerMessage, type User } from './protocol';

export type Status = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** What the client remembers about a confirmed op: enough for attribution and undo display. */
export interface OpMeta {
  seq: number;
  opId: string;
  userId: string;
  source: OpSource;
  via?: string;
  at: string;
  log: string;
  verb: string;
  /** For a revert op: the seq it reverted. */
  reverts?: number;
  /** Ids of the log entries the op appended. */
  logIds: string[];
}

export interface Outgoing { opId: string; kind: 'op' | 'undo' | 'redo'; cmd?: Command; at: string; sent: boolean; error?: string }

export interface Cache { seq: number; doc: Doc; ops: OpMeta[] }

export interface EngineOptions {
  connect: () => SocketLike;
  now?: () => Date;
  uuid?: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  cache?: Cache | null;
  /** Called after any state change (doc, status, users, presence, outbox). */
  onChange?: () => void;
  /** The server refused an op or an undo/redo. `item` is the dropped outbox entry. */
  onReject?: (error: string, item: Outgoing) => void;
  /** A confirmed op arrived. `own` = this tab sent it. */
  onOp?: (op: Op, own: Outgoing | undefined) => void;
  /** The socket closed before a welcome twice in a row: the session may have expired. */
  onAuthSuspect?: () => void;
  /** The map to open. The server serves its default map when this one does not exist. */
  map?: string;
  /** The server served a different map than the one asked for (it was deleted). Pending changes are dropped. */
  onMapChange?: (map: string) => void;
}

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];
const PING_MS = 20_000, SILENCE_MS = 45_000, META_LIMIT = 2000;
/** Verbs that only the server may originate. */
const SERVER_ONLY = new Set(['revert', 'import', 'turn', 'view']);

function fallbackUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class SyncEngine {
  confirmed: Doc;
  seq: number;
  doc: Doc;
  status: Status = 'connecting';
  me: User | null = null;
  users = new Map<string, User>();
  presence: PresenceEntry[] = [];
  outbox: Outgoing[] = [];
  meta = new Map<number, OpMeta>();
  logIndex = new Map<string, number>();
  selectedId: string | null = null;
  /** The map this engine is on, once the server has named it. */
  map: string | undefined;
  maps: MapInfo[] = [];

  private socket: SocketLike | null = null;
  private attempts = 0;
  private earlyCloses = 0;
  private welcomed = false;
  private stopped = true;
  private forceFull = false;
  private retryTimer: unknown;
  private pingTimer: unknown;
  private silenceTimer: unknown;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? fallbackUuid;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.map = opts.map;
    const cache = opts.cache;
    this.confirmed = cache ? cloneDoc(cache.doc) : emptyDoc();
    this.seq = cache?.seq ?? 0;
    for (const m of cache?.ops ?? []) this.remember(m);
    this.doc = this.confirmed;
  }

  get pendingCount(): number { return this.outbox.length; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer(this.retryTimer);
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) { s.onclose = null; s.onmessage = null; s.onerror = null; s.onopen = null; try { s.close(); } catch { /* already closed */ } }
  }

  /** Apply a doc-changing command optimistically and queue it for the server. */
  submit(cmd: Command): { ok: true; log: string; opId?: string; local: boolean } | { ok: false; error: string } {
    if (SERVER_ONLY.has(cmd.verb)) return { ok: false, error: `/${cmd.verb} is not available here` };
    const at = this.now();
    const result = apply(this.doc, cmd, at, this.me?.id, 'web');
    if ('error' in result) return { ok: false, error: result.error };
    // Read-only verbs (find, sitrep, export, help) change nothing and never reach the server.
    if (result.doc === this.doc) return { ok: true, log: result.log, local: true };
    const item: Outgoing = { opId: this.uuid(), kind: 'op', cmd: structuredCloneSafe(cmd), at: at.toISOString(), sent: false };
    this.outbox.push(item);
    this.doc = result.doc;
    this.flush();
    this.changed();
    return { ok: true, log: result.log, opId: item.opId, local: false };
  }

  /** Ask the server to undo or redo this user's most recent op. Not optimistic: it shows as pending. */
  request(kind: 'undo' | 'redo'): string {
    const item: Outgoing = { opId: this.uuid(), kind, at: this.now().toISOString(), sent: false };
    this.outbox.push(item);
    this.flush();
    this.changed();
    return item.opId;
  }

  setSelection(selectedId: string | null): void {
    if (selectedId === this.selectedId) return;
    this.selectedId = selectedId;
    if (this.status === 'live') this.send({ t: 'presence', selectedId });
  }

  /** Feed a raw frame (exposed for tests). */
  receive(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    this.armSilence();
    this.handle(msg);
  }

  // ---- connection -------------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return;
    this.welcomed = false;
    let s: SocketLike;
    try { s = this.opts.connect(); } catch { this.scheduleRetry(); return; }
    this.socket = s;
    s.onopen = () => {
      this.send({ t: 'hello', since: this.forceFull ? 0 : this.seq, ...(this.map ? { map: this.map } : {}) });
      this.armSilence();
    };
    s.onmessage = ev => { if (typeof ev.data === 'string') this.receive(ev.data); };
    s.onerror = () => { /* onclose follows */ };
    s.onclose = () => {
      if (this.socket !== s) return;
      this.socket = null;
      this.clearTimers();
      if (!this.welcomed && ++this.earlyCloses >= 2) { this.earlyCloses = 0; this.opts.onAuthSuspect?.(); }
      this.presence = [];
      for (const item of this.outbox) item.sent = false;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    this.attempts++;
    this.status = this.attempts > 3 ? 'offline' : 'reconnecting';
    this.changed();
    this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => this.open(), delay);
  }

  /** Drop the socket and reconnect at once, optionally asking for a full doc. */
  private resync(full: boolean): void {
    if (full) this.forceFull = true;
    const s = this.socket;
    this.socket = null;
    this.clearTimers();
    if (s) { s.onclose = null; try { s.close(); } catch { /* ignore */ } }
    for (const item of this.outbox) item.sent = false;
    this.status = 'reconnecting';
    this.changed();
    this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => this.open(), 0);
  }

  private clearTimers(): void {
    this.clearTimer(this.pingTimer);
    this.clearTimer(this.silenceTimer);
  }

  private armSilence(): void {
    this.clearTimer(this.silenceTimer);
    this.silenceTimer = this.setTimer(() => { if (this.socket) this.resync(false); }, SILENCE_MS);
  }

  private armPing(): void {
    this.clearTimer(this.pingTimer);
    this.pingTimer = this.setTimer(() => { this.send({ t: 'ping' }); this.armPing(); }, PING_MS);
  }

  private send(msg: ClientMessage): boolean {
    const s = this.socket;
    if (!s || s.readyState !== 1) return false;
    try { s.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  /** Send unsent outbox entries in order, once the server has welcomed us. */
  private flush(): void {
    if (this.status !== 'live') return;
    // Iterate a copy: an echo can settle (remove) entries while we send.
    for (const item of [...this.outbox]) {
      if (item.sent || !this.outbox.includes(item)) continue;
      const msg: ClientMessage = item.kind === 'op' ? { t: 'op', opId: item.opId, cmd: item.cmd! } : { t: item.kind, opId: item.opId };
      if (!this.send(msg)) return;
      item.sent = true;
    }
  }

  // ---- messages ---------------------------------------------------------------------------------

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': this.welcome(msg); break;
      case 'op': this.incoming(msg.op); break;
      case 'reject': {
        // A refused hello (our cache is ahead of the server, e.g. a reset database): start from a full doc.
        if (!this.welcomed && !msg.opId) { this.seq = 0; this.resync(true); return; }
        const i = this.outbox.findIndex(o => o.opId === msg.opId);
        if (i < 0) return;
        const [item] = this.outbox.splice(i, 1);
        this.rebuild();
        this.opts.onReject?.(msg.error, item);
        this.changed();
        break;
      }
      case 'presence': this.presence = msg.users; this.changed(); break;
      case 'maps': this.maps = msg.maps; this.changed(); break;
      case 'pong': break;
    }
  }

  private welcome(msg: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.me = msg.me;
    if (msg.maps) this.maps = msg.maps;
    if (msg.map && msg.map !== this.map) {
      // Asked for a map the server no longer has: what was queued for it cannot go to this one.
      // (A map asked for by name is simply named by its id; that is not a switch.)
      const switched = this.map !== undefined && msg.fallback === true;
      this.map = msg.map;
      if (switched) {
        const dropped = this.outbox.splice(0);
        for (const item of dropped) this.opts.onReject?.('That map was deleted', item);
        this.opts.onMapChange?.(msg.map);
        if (!msg.doc) { this.seq = 0; this.resync(true); return; }
      }
    }
    this.users = new Map(msg.users.map(u => [u.id, u]));
    if (!this.users.has(msg.me.id)) this.users.set(msg.me.id, msg.me);
    try {
      if (msg.doc) {
        this.confirmed = cloneDoc(msg.doc);
        this.seq = msg.seq;
        this.meta.clear();this.logIndex.clear();
      } else {
        for (const op of [...(msg.ops ?? [])].sort((a, b) => a.seq - b.seq)) {
          if (op.seq <= this.seq) { this.settle(op.opId); continue; }
          if (op.seq !== this.seq + 1) throw new Error('gap');
          this.confirm(op);
        }
        if (this.seq !== msg.seq) throw new Error('seq mismatch');
      }
    } catch {
      // The catch-up did not line up with our cache: start over from a full doc.
      this.seq = 0;
      this.resync(true);
      return;
    }
    this.forceFull = false;
    this.welcomed = true;
    this.earlyCloses = 0;
    this.attempts = 0;
    this.status = 'live';
    this.rebuild();
    this.send({ t: 'presence', selectedId: this.selectedId });
    this.armPing();
    this.flush();
    this.changed();
  }

  private incoming(op: Op): void {
    if (op.seq <= this.seq) {
      // A dedupe echo of an op we already hold (sent again after a reconnect).
      const own = this.settle(op.opId);
      if (own) { this.rebuild(); this.opts.onOp?.(op, own); this.changed(); }
      return;
    }
    if (op.seq !== this.seq + 1) { this.resync(false); return; }
    let own: Outgoing | undefined;
    try { own = this.confirm(op); } catch { this.seq = 0; this.resync(true); return; }
    this.rebuild();
    this.opts.onOp?.(op, own);
    this.changed();
  }

  /** Apply a confirmed op to the confirmed doc. Throws when the core refuses it (divergence). */
  private confirm(op: Op): Outgoing | undefined {
    const result = apply(this.confirmed, op.cmd, new Date(op.at), op.userId, op.via ?? op.source);
    if ('error' in result) throw new Error(result.error);
    const known = new Set(this.confirmed.log.map(l => l.id));
    const logIds = result.doc.log.filter(l => !known.has(l.id)).map(l => l.id);
    this.confirmed = result.doc;
    this.seq = op.seq;
    const reverts = op.cmd.verb === 'revert' && Number.isSafeInteger(op.cmd.args.seq) ? Number(op.cmd.args.seq) : undefined;
    this.remember({ seq: op.seq, opId: op.opId, userId: op.userId, source: op.source, via: op.via, at: op.at, log: op.log, verb: op.cmd.verb, reverts, logIds });
    return this.settle(op.opId);
  }

  private settle(opId: string): Outgoing | undefined {
    const i = this.outbox.findIndex(o => o.opId === opId);
    return i < 0 ? undefined : this.outbox.splice(i, 1)[0];
  }

  private remember(m: OpMeta): void {
    this.meta.set(m.seq, m);
    for (const id of m.logIds) this.logIndex.set(id, m.seq);
    if (this.meta.size > META_LIMIT) {
      const oldest = Math.min(...this.meta.keys());
      for (const id of this.meta.get(oldest)!.logIds) this.logIndex.delete(id);
      this.meta.delete(oldest);
    }
  }

  /** view = confirmed + pending ops reapplied. A pending op that no longer applies is kept for the
   *  server to judge but left out of the view. */
  private rebuild(): void {
    let doc = this.confirmed;
    for (const item of this.outbox) {
      if (item.kind !== 'op') continue;
      const result = apply(doc, item.cmd!, new Date(item.at), this.me?.id, 'web');
      if ('error' in result) { item.error = result.error; continue; }
      item.error = undefined;
      doc = result.doc;
    }
    this.doc = doc;
  }

  private changed(): void { this.opts.onChange?.(); }

  // ---- derived views ----------------------------------------------------------------------------

  cache(): Cache { return { seq: this.seq, doc: this.confirmed, ops: [...this.meta.values()].slice(-500) }; }

  /** True when the op at `seq` is currently reverted (a revert of it exists that is not itself reverted). */
  isUndone(seq: number): boolean {
    const revertsOf = new Map<number, number[]>();
    for (const m of this.meta.values()) if (m.reverts !== undefined) revertsOf.set(m.reverts, [...(revertsOf.get(m.reverts) ?? []), m.seq]);
    const undone = (s: number, depth: number): boolean => depth < 64 && (revertsOf.get(s) ?? []).some(r => !undone(r, depth + 1));
    return undone(seq, 0);
  }

  /** Who wrote a log entry, and how it relates to undo. */
  entryInfo(logId: string): { meta: OpMeta; undone: boolean; target?: OpMeta } | undefined {
    const seq = this.logIndex.get(logId);
    if (seq === undefined) return undefined;
    const meta = this.meta.get(seq)!;
    return { meta, undone: this.isUndone(seq), target: meta.reverts !== undefined ? this.meta.get(meta.reverts) : undefined };
  }
}

function structuredCloneSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
