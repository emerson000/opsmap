import { describe, expect, it } from 'vitest';
import { apply } from '../../src/core/commands/apply';
import { createInverse } from '../../src/core/model/patch';
import { emptyDoc } from '../../src/core/model/seed';
import type { Command, Doc, Touched } from '../../src/core/model/types';
import { SyncEngine, type SocketLike } from '../../src/lib/sync/engine';
import type { ClientMessage, Op, ServerMessage, User } from '../../src/lib/sync/protocol';
import { parseServerMessage } from '../../src/lib/sync/protocol';

/** A tiny in-memory stand-in for the server hub, implementing the wire protocol with the shared core. */
class FakeHub {
  doc: Doc = emptyDoc();
  ops: (Op & { inverse: unknown; touched: Touched; undoneBy?: number })[] = [];
  clients = new Set<FakeSocket>();
  clock = Date.UTC(2026, 10, 9, 15);
  holding = false;
  held: (() => void)[] = [];
  users: User[] = [{ id: 'alice', name: 'Alice', initials: 'AL' }, { id: 'bob', name: 'Bob', initials: 'BO' }];
  presence = new Map<FakeSocket, string | null>();

  connect(userId: string): FakeSocket { const s = new FakeSocket(this, userId); this.clients.add(s); queueMicrotask(() => { s.readyState = 1; s.onopen?.({}); }); return s; }

  receive(from: FakeSocket, msg: ClientMessage): void {
    const run = () => this.process(from, msg);
    if (this.holding && msg.t !== 'hello') this.held.push(run); else run();
  }
  release(): void { this.holding = false; const h = this.held; this.held = []; h.forEach(f => f()); }

  private process(from: FakeSocket, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello': {
        const me = this.users.find(u => u.id === from.userId)!;
        const base = { t: 'welcome' as const, me, users: this.users, seq: this.ops.length };
        if (msg.since > this.ops.length) { from.deliver({ t: 'reject', opId: '', error: 'Invalid sequence' }); return; }
        from.deliver(msg.since === 0 ? { ...base, doc: this.doc } : { ...base, ops: this.ops.slice(msg.since).map(strip) });
        this.presence.set(from, null);
        this.broadcastPresence();
        break;
      }
      case 'op': {
        const dupe = this.ops.find(o => o.opId === msg.opId);
        if (dupe) { from.deliver({ t: 'op', op: strip(dupe) }); return; }
        this.commit(from, msg.opId, msg.cmd);
        break;
      }
      case 'undo': case 'redo': {
        const dupe = this.ops.find(o => o.opId === msg.opId);
        if (dupe) { from.deliver({ t: 'op', op: strip(dupe) }); return; }
        const isUndo = (o: Op) => o.cmd.verb === 'revert' && this.ops[Number(o.cmd.args.seq) - 1]?.cmd.verb !== 'revert';
        const mine = this.ops.filter(o => o.userId === from.userId && !o.undoneBy);
        const target = (msg.t === 'undo' ? mine.filter(o => !isUndo(o)) : mine.filter(isUndo)).at(-1);
        if (!target) { from.deliver({ t: 'reject', opId: msg.opId, error: `Nothing to ${msg.t}` }); return; }
        const ids = (t: Touched) => [...t.units, ...t.orders, ...t.measures, ...t.sectors, ...t.top];
        const later = this.ops.slice(target.seq).find(o => o.seq > target.seq && ids(o.touched).some(id => ids(target.touched).includes(id)));
        if (later) { from.deliver({ t: 'reject', opId: msg.opId, error: `Changed since by ${this.users.find(u => u.id === later.userId)?.name}` }); return; }
        const op = this.commit(from, msg.opId, { verb: 'revert', args: { seq: target.seq, inverse: target.inverse } });
        if (op) target.undoneBy = op.seq;
        break;
      }
      case 'presence': this.presence.set(from, msg.selectedId); this.broadcastPresence(); break;
      case 'ping': from.deliver({ t: 'pong' }); break;
    }
  }

  commit(from: FakeSocket | null, opId: string, cmd: Command, userId = from?.userId ?? 'system') {
    const at = new Date(this.clock += 1000);
    const result = apply(this.doc, cmd, at, userId, from ? 'web' : 'system');
    if ('error' in result) { from?.deliver({ t: 'reject', opId, error: result.error }); return null; }
    const op = { seq: this.ops.length + 1, opId, userId, source: from ? 'web' as const : 'system' as const, at: at.toISOString(), cmd, log: result.log, inverse: createInverse(this.doc, result.touched), touched: result.touched };
    this.doc = result.doc;
    this.ops.push(op);
    for (const c of this.clients) c.deliver({ t: 'op', op: strip(op) });
    return op;
  }

  drop(s: FakeSocket): void { this.clients.delete(s); this.presence.delete(s); s.readyState = 3; s.onclose?.({}); this.broadcastPresence(); }
  broadcastPresence(): void {
    const users = [...this.presence.entries()].map(([s, selectedId]) => ({ userId: s.userId, selectedId }));
    for (const c of this.clients) c.deliver({ t: 'presence', users });
  }
}
const strip = (o: Op): Op => ({ seq: o.seq, opId: o.opId, userId: o.userId, source: o.source, at: o.at, cmd: o.cmd, log: o.log });

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(private hub: FakeHub, public userId: string) {}
  send(data: string): void { if (this.readyState === 1) this.hub.receive(this, JSON.parse(data)); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.hub.clients.delete(this); this.hub.presence.delete(this); }
  deliver(msg: ServerMessage): void { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const flush = () => new Promise(r => setTimeout(r, 5));
let ids = 0;
function client(hub: FakeHub, userId: string, extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const rejects: string[] = [];
  const engine = new SyncEngine({
    connect: () => { const s = hub.connect(userId); sockets.push(s); return s; },
    uuid: () => `${userId}-${++ids}`,
    onReject: e => rejects.push(e),
    ...extra,
  });
  engine.start();
  return { engine, sockets, rejects, socket: () => sockets.at(-1)! };
}
const newUnit = (title: string, designation: string): Command => ({ verb: 'new', args: { title, designation, affiliation: 'hostile', fn: 'inf', echelon: 'sec', sectorId: 'work', ring: 'near' } });
const json = (d: Doc) => JSON.stringify(d);

describe('protocol parsing', () => {
  it('ignores malformed frames', () => {
    expect(parseServerMessage('nope')).toBeNull();
    expect(parseServerMessage('{"t":"op","op":{"seq":"1"}}')).toBeNull();
    expect(parseServerMessage('{"t":"reject","opId":"x"}')).toEqual({ t: 'reject', opId: 'x', error: 'Rejected by server' });
  });
});

describe('sync engine', () => {
  it('converges two clients and attributes ops', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice'), b = client(hub, 'bob');
    await flush();
    expect(a.engine.status).toBe('live');
    expect(a.engine.submit(newUnit('Tax', 'TAX'))).toMatchObject({ ok: true });
    expect(a.engine.doc.units.map(u => u.designation)).toEqual(['TAX']);
    await flush();
    expect(b.engine.doc.units.map(u => u.designation)).toEqual(['TAX']);
    expect(json(a.engine.doc)).toBe(json(hub.doc));
    expect(json(b.engine.doc)).toBe(json(hub.doc));
    expect(hub.doc.units[0].createdBy).toBe('alice');
    const entry = b.engine.entryInfo(hub.doc.log[0].id);
    expect(entry?.meta.userId).toBe('alice');
  });

  it('rebases pending ops over a remote op and confirms on echo', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice'), b = client(hub, 'bob');
    await flush();
    hub.holding = true;
    a.engine.submit(newUnit('Alpha', 'ALPHA'));
    expect(a.engine.pendingCount).toBe(1);
    // Bob's op lands first on the server.
    hub.release();
    hub.holding = true;
    b.engine.submit(newUnit('Bravo', 'BRAVO'));
    a.engine.submit({ verb: 'note', args: { unit: 'u1', note: 'mine' } });
    hub.release();
    await flush();
    expect(a.engine.pendingCount).toBe(0);
    expect(json(a.engine.doc)).toBe(json(hub.doc));
    expect(json(b.engine.doc)).toBe(json(hub.doc));
    expect(hub.doc.units.map(u => u.designation)).toEqual(['ALPHA', 'BRAVO']);
  });

  it('drops a rejected op, rebuilds, and reports the server error', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice'), b = client(hub, 'bob');
    await flush();
    a.engine.submit(newUnit('Alpha', 'ALPHA'));
    await flush();
    hub.holding = true;
    b.engine.submit({ verb: 'done', args: { unit: 'u1' } });
    a.engine.submit({ verb: 'rename', args: { unit: 'u1', title: 'x', designation: 'BRAVO' } });
    // Make A's op fail on the server: something else takes the designation first.
    hub.commit(null, 'sys-1', newUnit('Other', 'BRAVO'));
    hub.release();
    await flush();
    expect(a.rejects).toHaveLength(1);
    expect(a.rejects[0]).toMatch(/Designation/);
    expect(a.engine.pendingCount).toBe(0);
    expect(json(a.engine.doc)).toBe(json(hub.doc));
  });

  it('resends pending ops after a reconnect and the server deduplicates them', async () => {
    const hub = new FakeHub();
    const timers: (() => void)[] = [];
    const a = client(hub, 'alice', { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
    await flush();
    hub.holding = true;
    a.engine.submit(newUnit('Alpha', 'ALPHA'));
    // The server applies it, but the socket drops before the echo arrives.
    hub.drop(a.socket());
    hub.release();
    expect(hub.ops).toHaveLength(1);
    expect(a.engine.status).toBe('reconnecting');
    a.engine.submit(newUnit('Bravo', 'BRAVO'));
    expect(a.engine.pendingCount).toBe(2);
    timers.splice(0).forEach(f => f());
    await flush();
    expect(a.engine.status).toBe('live');
    expect(a.engine.pendingCount).toBe(0);
    expect(hub.ops).toHaveLength(2);
    expect(new Set(hub.ops.map(o => o.opId)).size).toBe(2);
    expect(json(a.engine.doc)).toBe(json(hub.doc));
  });

  it('catches up from a cache with ops since, or a full doc when the cache is ahead', async () => {
    const hub = new FakeHub();
    hub.commit(null, 's1', newUnit('Alpha', 'ALPHA'));
    const a = client(hub, 'alice');
    await flush();
    const cache = a.engine.cache();
    a.engine.stop();
    hub.commit(null, 's2', newUnit('Bravo', 'BRAVO'));
    const b = client(hub, 'alice', { cache });
    await flush();
    expect(json(b.engine.doc)).toBe(json(hub.doc));
    const stale = client(hub, 'bob', { cache: { seq: 99, doc: emptyDoc(), ops: [] } });
    await flush();
    expect(json(stale.engine.doc)).toBe(json(hub.doc));
    expect(stale.engine.seq).toBe(2);
  });

  it('undo goes through the server, and a conflicting undo is refused', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice'), b = client(hub, 'bob');
    await flush();
    a.engine.submit(newUnit('Alpha', 'ALPHA'));
    await flush();
    a.engine.submit({ verb: 'note', args: { unit: 'u1', note: 'first' } });
    await flush();
    hub.holding = true;
    a.engine.request('undo');
    // Not optimistic: the note stays until the server confirms.
    expect(a.engine.doc.units[0].note).toBe('first');
    expect(a.engine.pendingCount).toBe(1);
    hub.release();
    await flush();
    expect(a.engine.doc.units[0].note).toBeUndefined();
    expect(b.engine.doc.units[0].note).toBeUndefined();
    const noteSeq = 2;
    expect(a.engine.isUndone(noteSeq)).toBe(true);
    a.engine.request('redo');
    await flush();
    expect(a.engine.doc.units[0].note).toBe('first');
    expect(a.engine.isUndone(noteSeq)).toBe(false);
    // Bob edits the same unit; Alice's undo is refused.
    b.engine.submit({ verb: 'note', args: { unit: 'u1', note: 'bob' } });
    await flush();
    a.engine.request('undo');
    await flush();
    expect(a.rejects.at(-1)).toBe('Changed since by Bob');
    expect(a.engine.doc.units[0].note).toBe('bob');
    expect(json(a.engine.doc)).toBe(json(hub.doc));
  });

  it('shares presence and refuses server-only verbs', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice'), b = client(hub, 'bob');
    await flush();
    a.engine.setSelection('u9');
    await flush();
    expect(b.engine.presence).toContainEqual({ userId: 'alice', selectedId: 'u9' });
    expect(a.engine.submit({ verb: 'import', args: { doc: emptyDoc() } })).toMatchObject({ ok: false });
    expect(a.engine.submit({ verb: 'revert', args: { seq: 1 } })).toMatchObject({ ok: false });
  });

  it('resyncs from a full doc when an op arrives out of sequence', async () => {
    const hub = new FakeHub();
    const a = client(hub, 'alice');
    await flush();
    hub.commit(null, 's1', newUnit('Alpha', 'ALPHA'));
    await flush();
    // Deliver a frame that skips a seq.
    a.socket().deliver({ t: 'op', op: { seq: 5, opId: 'x', userId: 'system', source: 'system', at: new Date().toISOString(), cmd: { verb: 'turn', args: {} }, log: '' } });
    await flush();
    expect(a.engine.status).toBe('live');
    expect(json(a.engine.doc)).toBe(json(hub.doc));
  });
});

describe('sync engine maps', () => {
  /** A single-socket server stand-in that records hellos and answers with a chosen map. */
  function scripted(serve: (hello: Extract<ClientMessage, { t: 'hello' }>) => ServerMessage) {
    const hellos: Extract<ClientMessage, { t: 'hello' }>[] = [];
    const socket: SocketLike & { deliver(msg: ServerMessage): void } = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(data: string) { const msg = JSON.parse(data) as ClientMessage; if (msg.t === 'hello') { hellos.push(msg); socket.deliver(serve(msg)); } },
      close() { socket.readyState = 3; },
      deliver(msg: ServerMessage) { this.onmessage?.({ data: JSON.stringify(msg) }); },
    };
    return { hellos, socket, open: () => { queueMicrotask(() => { socket.readyState = 1; socket.onopen?.({}); }); return socket; } };
  }
  const me = { id: 'alice', name: 'Alice' };
  const maps = [{ id: 'main', name: 'Main' }, { id: 'garden', name: 'Garden' }];

  it('asks for its map in hello and keeps the map list current', async () => {
    const s = scripted(h => ({ t: 'welcome', me, users: [me], seq: 0, doc: emptyDoc(), map: h.map ?? 'main', maps }));
    const changes: string[] = [];
    const engine = new SyncEngine({ connect: s.open, map: 'garden', onMapChange: m => changes.push(m) });
    engine.start(); await flush();
    expect(s.hellos[0]).toEqual({ t: 'hello', since: 0, map: 'garden' });
    expect(engine.map).toBe('garden'); expect(engine.maps).toEqual(maps); expect(changes).toEqual([]);
    s.socket.deliver({ t: 'maps', maps: [maps[0]] });
    expect(engine.maps).toEqual([maps[0]]);
    engine.stop();
  });

  it('learns the default map when none is asked for', async () => {
    const s = scripted(() => ({ t: 'welcome', me, users: [me], seq: 0, doc: emptyDoc(), map: 'main', maps }));
    const changes: string[] = [];
    const engine = new SyncEngine({ connect: s.open, onMapChange: m => changes.push(m) });
    engine.start(); await flush();
    expect(s.hellos[0]).toEqual({ t: 'hello', since: 0 }); expect(engine.map).toBe('main'); expect(changes).toEqual([]);
    engine.stop();
  });

  it('drops queued changes when the server serves another map', async () => {
    const s = scripted(() => ({ t: 'welcome', me, users: [me], seq: 0, doc: emptyDoc(), map: 'main', maps: [maps[0]], fallback: true }));
    const changes: string[] = [], rejects: string[] = [];
    const engine = new SyncEngine({ connect: s.open, map: 'garden', onMapChange: m => changes.push(m), onReject: e => rejects.push(e) });
    expect(engine.submit(newUnit('Weeds', 'WEED'))).toMatchObject({ ok: true });
    engine.start(); await flush();
    expect(changes).toEqual(['main']); expect(rejects).toEqual(['That map was deleted']);
    expect(engine.pendingCount).toBe(0); expect(engine.doc.units).toEqual([]);
    engine.stop();
  });

  it('adopts the id of a map asked for by name without dropping changes', async () => {
    const s = scripted(() => ({ t: 'welcome', me, users: [me], seq: 0, doc: emptyDoc(), map: 'garden', maps }));
    const changes: string[] = [];
    const engine = new SyncEngine({ connect: s.open, map: 'Garden', onMapChange: m => changes.push(m) });
    engine.submit(newUnit('Weeds', 'WEED'));
    engine.start(); await flush();
    expect(engine.map).toBe('garden'); expect(changes).toEqual([]); expect(engine.doc.units).toHaveLength(1);
    engine.stop();
  });

  it('parses map frames', () => {
    expect(parseServerMessage('{"t":"maps","maps":[{"id":"a","name":"A"},{"id":3}]}')).toEqual({ t: 'maps', maps: [{ id: 'a', name: 'A', createdAt: undefined, createdBy: undefined }] });
    expect(parseServerMessage('{"t":"welcome","me":{"id":"x"},"users":[],"seq":0,"map":7}')).toBeNull();
  });
});
