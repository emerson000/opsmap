// Two-way sync between a map and a Vikunja project tree: the map (the A/O) is a project, each sector one of its
// child projects, each unit a task. Fields merge three ways against the values both sides last agreed on
// (`vk_links.base`): a field changed on one side is copied across; changed on both, the newer side wins.
// Pulled changes become ordinary ops (`vk` add, pull, gone) by the system user with via "vikunja".
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Affiliation, Command, Doc, Unit } from '../../src/core/model/types';
import type { VkChanges, VkStatus } from '../../src/core/commands/apply';
import { localDay } from '../../src/core/model/time';
import type { Maps } from '../maps';
import type { Hub, Op } from '../hub';
import type { Store, User } from '../db';
import type { VkApi, VkLabel, VkProject, VkTask } from './api';

export interface VkFields { title: string; due: string | null; note: string; progress: number | null; status: VkStatus | null; sector: string | null; affiliation: Affiliation | null }
const FIELDS = ['title', 'due', 'note', 'progress', 'status', 'sector', 'affiliation'] as const;

/** Identity ↔ Vikunja label: the first title is the one created; the others are also read. Colors follow the frames. */
export const AFFILIATION_LABELS: Record<Affiliation, { titles: string[]; color: string }> = {
  hostile: { titles: ['hostile', 'enemy'], color: 'ff8080' },
  suspect: { titles: ['suspect'], color: 'ffbb66' },
  friend: { titles: ['friendly', 'friend'], color: '80e0ff' },
  assumed: { titles: ['assumed', 'assumed friend'], color: 'b3ecff' },
  neutral: { titles: ['neutral'], color: 'aaffaa' },
  unknown: { titles: ['unknown'], color: 'ffff80' },
  pending: { titles: ['pending'], color: 'fff3b0' },
};
const affiliationOfTitle = (title: string): Affiliation | undefined => {
  const t = title.trim().toLowerCase();
  return (Object.keys(AFFILIATION_LABELS) as Affiliation[]).find(a => AFFILIATION_LABELS[a].titles.includes(t));
};
/** The identities a task's labels name (normally zero or one). */
const affiliationsOf = (t: VkTask): Affiliation[] => [...new Set((t.labels ?? []).map(l => affiliationOfTitle(l.title)).filter((a): a is Affiliation => a !== undefined))];
/** The identity labels known this cycle, created on first use. */
class LabelSet {
  private readonly ids = new Map<Affiliation, number>();
  constructor(private readonly api: VkApi, labels: VkLabel[]) {
    for (const l of labels) { const a = affiliationOfTitle(l.title); if (a && !this.ids.has(a)) this.ids.set(a, l.id); }
  }
  async id(a: Affiliation): Promise<number> {
    const known = this.ids.get(a); if (known !== undefined) return known;
    const made = await this.api.createLabel(AFFILIATION_LABELS[a].titles[0], AFFILIATION_LABELS[a].color);
    this.ids.set(a, made.id); return made.id;
  }
}
const EVENTS = ['task.created', 'task.updated', 'task.deleted'];
const SYSTEM = 'system', VIA = 'vikunja';

/** Vikunja's title limit; opsmap's longest note in one op. */
const MAX_TITLE = 250, MAX_NOTE = 16000;
const threat = (u: Unit) => u.affiliation === 'hostile' || u.affiliation === 'suspect';
/** Units that live in Vikunja: tasks and events, not people or places. */
export const syncable = (u: Unit) => u.kind === 'unit' || u.kind === 'event';
const noDate = (value: string | null | undefined) => !value || Date.parse(value) < Date.parse('1900-01-01');

const codePoint = (n: number, raw: string) => { try { return String.fromCodePoint(n); } catch { return raw; } };
/** Vikunja descriptions are HTML; opsmap notes are plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>\s*/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (m, n) => codePoint(Number(n), m)).replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(parseInt(n, 16), m))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function textToHtml(text: string): string {
  if (!text.trim()) return '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text.split('\n').map(line => `<p>${esc(line)}</p>`).join('');
}

const ALIASES: Record<Exclude<VkStatus, 'done'>, string[]> = {
  todo: ['to-do', 'to do', 'todo', 'backlog'],
  active: ['doing', 'in progress', 'in-progress', 'active'],
  blocked: ['blocked', 'waiting', 'on hold'],
};
/** A sector project's kanban: which bucket means which state. */
interface Board { project: number; list: number; kanban: number | null; done: number; bucketOf: Partial<Record<VkStatus, number>>; statusOf: Map<number, VkStatus> }

export interface VkStatusInfo { lastSync?: string; lastError?: string; pushed: number; pulled: number; created: number; added: number; archived?: string[] }

export class VikunjaSync {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly info = new Map<string, VkStatusInfo>();
  private poll?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly onEvent: (event: { kind: string; mapId?: string; op?: Op; deleted?: string }) => void;

  /** `hookBase`: the public origin Vikunja posts webhooks to; without it the sync polls only. */
  constructor(readonly maps: Maps, readonly connect: (userId: string | undefined) => VkApi | undefined, readonly url: string, readonly hookBase?: string, readonly pollMs = 60000, readonly debounceMs = 1000) {
    const db = this.store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS vk_links(map_id TEXT NOT NULL,unit_id TEXT NOT NULL,task_id INTEGER NOT NULL,base TEXT NOT NULL,PRIMARY KEY(map_id,unit_id));
      CREATE TABLE IF NOT EXISTS vk_maps(map_id TEXT PRIMARY KEY,secret TEXT NOT NULL,hooks TEXT NOT NULL DEFAULT '[]',owner TEXT,hooks_checked TEXT,last_delivery TEXT);`);
    // Every change on a bound map, except the sync's own, pushes after a short pause.
    this.onEvent = event => {
      // A deleted map takes its webhooks with it.
      if (event.kind === 'maps' && event.deleted) { void this.serial(event.deleted, () => this.release(event.deleted!)).catch(() => undefined); return; }
      if (event.kind !== 'op' || !event.mapId || event.op?.via === VIA) return;
      if (this.maps.get(event.mapId)?.doc.settings.vikunja || this.row(event.mapId)) this.schedule(event.mapId, this.debounceMs);
    };
    maps.listeners.add(this.onEvent);
  }
  get store(): Store { return this.maps.store; }
  /** The user who bound the map, as recorded on this server at bind time. The doc's `by` is for display only:
   *  a document can be imported or forged, so it never decides whose token runs. */
  private owner(mapId: string): string | undefined {
    return (this.store.db.prepare('SELECT owner FROM vk_maps WHERE map_id=?').get(mapId) as { owner: string | null } | undefined)?.owner ?? undefined;
  }
  private setOwner(mapId: string, userId: string): void {
    this.secret(mapId);
    this.store.db.prepare('UPDATE vk_maps SET owner=? WHERE map_id=?').run(userId, mapId);
  }
  /** A map syncs with the Vikunja token of the user who bound it. */
  private apiFor(userId: string | undefined): VkApi {
    const api = this.connect(userId);
    if (!api) throw new Error(`No Vikunja token for ${userId ? this.store.user(userId)?.name ?? userId : 'this map'}: connect it in the menu → Vikunja`);
    return api;
  }

  start(): void {
    // The poll is the fallback: every minute, or every 5 minutes while Vikunja's webhooks are being delivered.
    this.poll = setInterval(() => {
      for (const hub of this.maps.hubs.values()) {
        if (!hub.doc.settings.vikunja) continue;
        const last = this.info.get(hub.mapId)?.lastSync;
        if (this.delivering(hub.mapId) && last && Date.now() - Date.parse(last) < 5 * this.pollMs) continue;
        this.schedule(hub.mapId, 0);
      }
    }, this.pollMs);
    this.poll.unref?.();
    for (const hub of this.maps.hubs.values()) if (hub.doc.settings.vikunja) this.schedule(hub.mapId, 2000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear(); this.maps.listeners.delete(this.onEvent);
    await Promise.allSettled([...this.chains.values()]);
  }

  // ---------- requests (/vk bind, sync, status) ----------
  async request(mapId: string, args: Record<string, unknown>, user: User, source: Op['source']): Promise<string> {
    const hub = this.hub(mapId), action = String(args.action);
    if (action === 'status') return this.status(hub);
    if (action === 'sync') { if (!hub.doc.settings.vikunja) throw new Error('This map is not bound to Vikunja'); return `VIKUNJA SYNC — ${await this.run(mapId, true)}`; }
    if (action !== 'bind') throw new Error(`Unknown /vk action: ${action}`);
    const name = typeof args.name === 'string' ? args.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 250) throw new Error('Expected a Vikunja project name');
    const bound = hub.doc.settings.vikunja;
    if (bound && bound.title.toLowerCase() !== name.toLowerCase()) throw new Error(`Bound to ${bound.title}: /vk unbind first`);
    const api = this.apiFor(user.id);
    const check = () => {
      const now = this.hub(mapId).doc.settings.vikunja, owner = this.owner(mapId);
      if (now && now.title.toLowerCase() !== name.toLowerCase()) throw new Error(`Bound to ${now.title}: /vk unbind first`);
      if (now && owner && owner !== user.id) throw new Error(`Bound by ${this.store.user(owner)?.name ?? owner}: they sync it with their Vikunja account`);
    };
    check();
    return this.serial(mapId, async () => {
      // Again in the queue: another bind may have finished while this one waited.
      check();
      const projects = await api.projects(), lower = name.toLowerCase();
      // Live projects first: an archived one of the same name is history.
      projects.sort((a, b) => Number(Boolean(a.is_archived)) - Number(Boolean(b.is_archived)));
      const root = projects.find(p => p.parent_project_id === 0 && p.title.toLowerCase() === lower)
        ?? projects.find(p => p.title.toLowerCase() === lower)
        ?? await api.createProject(name, 0);
      const sectors: Record<string, number> = {};
      for (const s of this.hub(mapId).doc.sectors) sectors[s.id] = (await this.child(api, projects, root, s.name)).id;
      check();
      this.setOwner(mapId, user.id);
      // Recorded by the system, so a user's /undo cannot strip the binding from under linked units: /vk unbind does that.
      const op = this.hub(mapId).internal(SYSTEM, 'system', { verb: 'vk', args: { action: 'bound', project: root.id, title: root.title, by: user.id, sectors } }, source === 'mcp' ? 'mcp' : 'web');
      return `${op.log} — ${await this.cycle(mapId, true)}`;
    });
  }

  private status(hub: Hub): string {
    const bound = hub.doc.settings.vikunja;
    if (!bound) return 'VIKUNJA: not bound. /vk bind "‹project›"';
    const s = this.info.get(hub.mapId), linked = hub.doc.units.filter(u => u.vk !== undefined).length;
    const time = (iso?: string) => iso ? new Date(iso).toISOString().slice(11, 19) + 'Z' : 'never';
    const by = this.owner(hub.mapId), owner = by ? this.store.user(by)?.name ?? by : 'nobody on this server (/vk unbind, then /vk bind)', token = !by || this.connect(by) ? '' : ' (no token: connect it in the menu → Vikunja)';
    return `VIKUNJA: bound to ${bound.title} (${this.url}/projects/${bound.project}) by ${owner}${token} · ${hub.doc.sectors.filter(x => x.vk).length} sectors · ${linked} units linked · ` +
      `${this.hookStatus(hub.mapId)} · last sync ${time(s?.lastSync)}${s?.archived?.length ? ` · not synced, project archived in Vikunja: ${s.archived.join(', ')}` : ''}${s?.lastError ? ` · last error: ${s.lastError}` : ''}`;
  }
  /** Webhook health for /vk status. */
  private hookStatus(mapId: string): string {
    if (!this.hookBase) return 'polling every minute (webhooks need PUBLIC_URL to be an address Vikunja can reach)';
    const n = this.hooks(mapId).length, last = this.row(mapId)?.last_delivery;
    if (!n) return 'no webhooks yet (next sync registers them), polling every minute';
    if (last) return `${n} webhooks · last delivery ${new Date(last).toISOString().slice(11, 19)}Z`;
    return `${n} webhooks, none delivered yet: if changes in Vikunja take a minute to arrive, set VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true on Vikunja (it refuses private addresses) · polling every minute`;
  }

  // ---------- webhooks ----------
  /** Vikunja signs each delivery with HMAC-SHA256 of the body in X-Vikunja-Signature. */
  webhook(mapId: string, body: string, signature: string | undefined): boolean {
    const row = this.store.db.prepare('SELECT secret FROM vk_maps WHERE map_id=?').get(mapId) as { secret: string } | undefined;
    if (!row || !signature || !this.maps.get(mapId)) return false;
    const want = Buffer.from(createHmac('sha256', row.secret).update(body).digest('hex')), got = Buffer.from(signature.trim().toLowerCase());
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    this.store.db.prepare('UPDATE vk_maps SET last_delivery=? WHERE map_id=?').run(new Date().toISOString(), mapId);
    this.schedule(mapId, 500);
    return true;
  }
  private row(mapId: string) {
    return this.store.db.prepare('SELECT * FROM vk_maps WHERE map_id=?').get(mapId) as { owner: string | null; hooks: string; hooks_checked: string | null; last_delivery: string | null } | undefined;
  }
  /** Vikunja delivered a webhook in the last 15 minutes. */
  private delivering(mapId: string): boolean {
    const last = this.row(mapId)?.last_delivery;
    return Boolean(last && Date.now() - Date.parse(last) < 15 * 60_000);
  }
  private hooks(mapId: string): { project: number; id: number }[] {
    const row = this.store.db.prepare('SELECT hooks FROM vk_maps WHERE map_id=?').get(mapId) as { hooks: string } | undefined;
    return row ? JSON.parse(row.hooks) : [];
  }
  private secret(mapId: string): string {
    const row = this.store.db.prepare('SELECT secret FROM vk_maps WHERE map_id=?').get(mapId) as { secret: string } | undefined;
    if (row) return row.secret;
    const secret = randomBytes(32).toString('hex');
    this.store.db.prepare('INSERT INTO vk_maps(map_id,secret) VALUES(?,?)').run(mapId, secret);
    return secret;
  }
  /** One opsmap webhook per sector project, with opsmap's events; checked against Vikunja every 10 minutes, and
   *  at once on bind, /vk sync or when the sector projects change. Webhooks deleted in Vikunja are made again. */
  private async ensureHooks(api: VkApi, owner: string | undefined, mapId: string, projects: number[], force = false): Promise<void> {
    if (!this.hookBase) return;
    const target = `${this.hookBase}/api/vikunja/hook/${encodeURIComponent(mapId)}`, secret = this.secret(mapId);
    this.store.db.prepare('UPDATE vk_maps SET owner=? WHERE map_id=?').run(owner ?? null, mapId);
    const checked = this.row(mapId)?.hooks_checked, have = this.hooks(mapId).map(h => h.project).sort().join(',');
    if (!force && checked && Date.now() - Date.parse(checked) < 10 * 60_000 && have === [...projects].sort().join(',')) return;
    const kept = this.hooks(mapId).filter(h => projects.includes(h.project));
    for (const h of this.hooks(mapId)) if (!projects.includes(h.project)) await api.deleteWebhook(h.project, h.id).catch(() => undefined);
    const sameEvents = (events: string[]) => [...events].sort().join() === [...EVENTS].sort().join();
    for (const project of projects) {
      const existing = (await api.webhooks(project)).find(w => w.target_url === target);
      if (existing && sameEvents(existing.events) && kept.some(h => h.project === project && h.id === existing.id)) continue;
      if (existing) await api.deleteWebhook(project, existing.id).catch(() => undefined);
      const made = await api.createWebhook(project, target, EVENTS, secret);
      const i = kept.findIndex(h => h.project === project); if (i >= 0) kept.splice(i, 1);
      kept.push({ project, id: made.id });
    }
    this.store.db.prepare('UPDATE vk_maps SET hooks=?,hooks_checked=? WHERE map_id=?').run(JSON.stringify(kept), new Date().toISOString(), mapId);
  }
  /** Unbound: remove its webhooks and sync state. Tasks stay in Vikunja. */
  private async release(mapId: string): Promise<void> {
    const owner = (this.store.db.prepare('SELECT owner FROM vk_maps WHERE map_id=?').get(mapId) as { owner: string | null } | undefined)?.owner ?? undefined;
    const api = this.connect(owner);
    if (api) for (const h of this.hooks(mapId)) await api.deleteWebhook(h.project, h.id).catch(() => undefined);
    this.store.db.prepare('DELETE FROM vk_maps WHERE map_id=?').run(mapId);
    this.store.db.prepare('DELETE FROM vk_links WHERE map_id=?').run(mapId);
  }

  // ---------- scheduling ----------
  private hub(mapId: string): Hub { const hub = this.maps.get(mapId); if (!hub) throw new Error('Unknown map'); return hub; }
  schedule(mapId: string, delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(mapId));
    const timer = setTimeout(() => { this.timers.delete(mapId); this.run(mapId).catch(() => undefined); }, delay);
    timer.unref?.(); this.timers.set(mapId, timer);
  }
  /** One cycle at a time per map. */
  private serial<T>(mapId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(mapId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.chains.set(mapId, next.catch(() => undefined));
    return next;
  }
  run(mapId: string, force = false): Promise<string> {
    return this.serial(mapId, () => this.cycle(mapId, force));
  }

  // ---------- one sync cycle ----------
  private async child(api: VkApi, projects: VkProject[], root: VkProject, title: string): Promise<VkProject> {
    const found = projects.find(p => p.parent_project_id === root.id && !p.is_archived && p.title.toLowerCase() === title.toLowerCase())
      ?? projects.find(p => p.parent_project_id === root.id && p.title.toLowerCase() === title.toLowerCase());
    if (found) return found;
    const made = await api.createProject(title, root.id);
    projects.push(made);
    return made;
  }
  /** The sector project's kanban, with a Blocked bucket added between Doing and Done when missing. */
  private async board(api: VkApi, project: VkProject): Promise<Board> {
    const views = project.views ?? [];
    const list = views.find(v => v.view_kind === 'list'), kanban = views.find(v => v.view_kind === 'kanban' && v.bucket_configuration_mode === 'manual');
    if (!list) throw new Error(`Vikunja project ${project.title} has no list view`);
    const board: Board = { project: project.id, list: list.id, kanban: kanban?.id ?? null, done: kanban?.done_bucket_id ?? 0, bucketOf: {}, statusOf: new Map() };
    if (!kanban) return board;
    const buckets = await api.buckets(project.id, kanban.id);
    const find = (status: Exclude<VkStatus, 'done'>) => buckets.find(b => b.id !== board.done && ALIASES[status].includes(b.title.trim().toLowerCase()));
    if (!find('blocked')) {
      const doing = find('active'), done = buckets.find(b => b.id === board.done);
      const position = doing?.position !== undefined && done?.position !== undefined && done.position > doing.position ? (doing.position + done.position) / 2 : undefined;
      buckets.push(await api.createBucket(project.id, kanban.id, 'Blocked', position));
    }
    for (const status of ['todo', 'active', 'blocked'] as const) { const b = find(status); if (b) { board.bucketOf[status] = b.id; board.statusOf.set(b.id, status); } }
    if (board.done) { board.bucketOf.done = board.done; board.statusOf.set(board.done, 'done'); }
    return board;
  }

  unitFields(u: Unit, doc: Doc): VkFields {
    const tz = doc.settings.tz;
    return {
      // Compared at Vikunja's length, so a longer opsmap title does not count as a difference every cycle.
      title: u.title.slice(0, MAX_TITLE),
      due: u.dueAt ? localDay(new Date(u.dueAt), tz) : null,
      note: (u.note ?? '').trim(),
      progress: threat(u) ? Math.round(100 - (u.strength ?? 100)) : null,
      status: u.lifecycle === 'done' || u.lifecycle === 'dropped' ? 'done' : u.lifecycle,
      sector: u.sectorId,
      affiliation: u.affiliation,
    };
  }
  taskFields(t: VkTask, u: Unit | undefined, doc: Doc, boards: Map<number, Board>): VkFields {
    const board = boards.get(t.project_id);
    return {
      title: t.title,
      due: noDate(t.due_date) ? null : localDay(new Date(t.due_date!), doc.settings.tz),
      // Compared at opsmap's length: a longer description is not a difference once its start is on the unit.
      note: htmlToText(t.description).slice(0, MAX_NOTE).trim(),
      progress: u && threat(u) ? Math.round((t.percent_done ?? 0) * 100) : null,
      status: t.done ? 'done' : t.bucket_id !== undefined && board ? board.statusOf.get(t.bucket_id) ?? null : null,
      sector: doc.sectors.find(s => s.vk === t.project_id)?.id ?? null,
      // No identity label, or several: no opinion (the unit's identity is written back as the one label).
      affiliation: (() => { const a = affiliationsOf(t); return a.length === 1 ? a[0] : null; })(),
    };
  }
  private base(mapId: string, unitId: string): VkFields | undefined {
    const row = this.store.db.prepare('SELECT base FROM vk_links WHERE map_id=? AND unit_id=?').get(mapId, unitId) as { base: string } | undefined;
    return row ? JSON.parse(row.base) : undefined;
  }
  private setBase(mapId: string, unitId: string, task: number, base: VkFields | null): void {
    if (base === null) { this.store.db.prepare('DELETE FROM vk_links WHERE map_id=? AND unit_id=?').run(mapId, unitId); return; }
    this.store.db.prepare('INSERT INTO vk_links(map_id,unit_id,task_id,base) VALUES(?,?,?,?) ON CONFLICT(map_id,unit_id) DO UPDATE SET task_id=excluded.task_id,base=excluded.base').run(mapId, unitId, task, JSON.stringify(base));
  }
  private system(mapId: string, args: Record<string, unknown>): Op {
    const cmd: Command = { verb: 'vk', args };
    return this.hub(mapId).internal(SYSTEM, 'system', cmd, VIA);
  }

  /** The task as opsmap wants it: the fetched task with `fields` written over it. */
  private taskWith(t: VkTask, f: VkFields, u: Unit, doc: Doc): VkTask {
    const sector = doc.sectors.find(s => s.id === f.sector);
    return {
      ...t, title: f.title, description: f.note === htmlToText(t.description) ? t.description : textToHtml(f.note),
      due_date: f.due === null ? null : (u.dueAt ?? t.due_date),
      percent_done: f.progress === null ? t.percent_done : f.progress / 100,
      done: f.status === 'done', project_id: sector?.vk ?? t.project_id,
    };
  }
  /** The task carries exactly one identity label, for `a`; the user's other labels are left alone. */
  private async label(api: VkApi, labels: LabelSet, task: VkTask, a: Affiliation): Promise<void> {
    const want = await labels.id(a);
    const current = (task.labels ?? []).filter(l => affiliationOfTitle(l.title) !== undefined);
    if (!current.some(l => l.id === want)) await api.addLabel(task.id, want);
    for (const l of current) if (l.id !== want) await api.removeLabel(task.id, l.id);
  }
  private async place(api: VkApi, task: VkTask, status: VkStatus | null, boards: Map<number, Board>, current?: number): Promise<void> {
    const board = boards.get(task.project_id);
    if (!board?.kanban || !status || status === 'done') return;
    const bucket = board.bucketOf[status];
    if (bucket && bucket !== current) await api.moveToBucket(board.project, board.kanban, bucket, task.id);
  }

  async cycle(mapId: string, force = false): Promise<string> {
    const stats = { pushed: 0, pulled: 0, created: 0, added: 0 };
    const info = this.info.get(mapId) ?? { pushed: 0, pulled: 0, created: 0, added: 0 };
    this.info.set(mapId, info);
    try {
      let hub = this.hub(mapId);
      const binding = hub.doc.settings.vikunja;
      if (!binding) { await this.release(mapId); return 'not bound'; }
      const owner = this.owner(mapId);
      if (!owner || (binding.by !== undefined && binding.by !== owner)) throw new Error('This map was not bound on this server: /vk unbind, then /vk bind');
      const api = this.apiFor(owner);
      const projects = await api.projects();
      const root = projects.find(p => p.id === binding.project);
      if (!root) throw new Error(`Vikunja project ${binding.title} is gone: /vk unbind`);
      // Sectors without a child project (added since, or the project was deleted) get one.
      const missing: Record<string, number> = {};
      for (const s of hub.doc.sectors) if (!s.vk || !projects.some(p => p.id === s.vk)) missing[s.id] = (await this.child(api, projects, root, s.name)).id;
      if (Object.keys(missing).length) this.system(mapId, { action: 'sectors', sectors: missing });
      hub = this.hub(mapId);
      // A sector whose project is archived in Vikunja is read-only there: it is left out until it is unarchived.
      const boards = new Map<number, Board>(), frozen = new Set<number>();
      for (const s of hub.doc.sectors) {
        const project = projects.find(p => p.id === s.vk)!;
        if (project.is_archived) frozen.add(project.id); else boards.set(project.id, await this.board(api, project));
      }
      info.archived = hub.doc.sectors.filter(s => frozen.has(s.vk!)).map(s => s.name);
      await this.ensureHooks(api, owner, mapId, [...boards.keys()], force);
      const labels = new LabelSet(api, await api.labels());

      const tasks = new Map<number, VkTask>();
      for (const board of boards.values()) {
        const bucketOf = board.kanban ? await api.bucketsOfTasks(board.project, board.kanban) : new Map<number, number>();
        for (const t of await api.tasks(board.project, board.list)) tasks.set(t.id, { ...t, bucket_id: bucketOf.get(t.id) });
      }

      // One unit or task that fails (a Vikunja error, a rejected value) does not hold up the rest.
      const problems: string[] = [];
      const guard = async (what: string, fn: () => Promise<void>) => {
        try { await fn(); } catch (error) { problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); }
      };

      // Linked units: merge field by field.
      for (const snapshot of hub.doc.units.filter(u => u.vk !== undefined)) {
        const doc = this.hub(mapId).doc, u = doc.units.find(x => x.id === snapshot.id);
        if (!u || u.vk === undefined) continue;
        const id = u.vk, sectorProject = doc.sectors.find(s => s.id === u.sectorId)?.vk;
        if (sectorProject !== undefined && frozen.has(sectorProject)) continue;
        await guard(u.designation, async () => {
          let t = tasks.get(id);
          tasks.delete(id);
          if (!t) {
            const remote = await api.task(id);
            if (!remote) {
              // Deleted in Vikunja: the unit is dropped and lets go of it.
              this.system(mapId, { action: 'gone', unit: u.id }); stats.pulled++;
              this.setBase(mapId, u.id, 0, null);
              return;
            }
            // Still there, outside this A/O's sector projects (a removed sector, or moved away): a task is never
            // treated as deleted while it exists; it goes back to its unit's sector. In an archived project it waits.
            if (frozen.has(remote.project_id)) return;
            t = remote;
          }
          stats.pushed += await this.merge(api, labels, mapId, u, t, boards, stats);
        });
      }

      // Units without a task get one (not ones already finished: their history stays on the map). An open,
      // unlinked task with the same title in the same sector project is the same item (a rebind, or one typed
      // on both sides): it is linked instead of duplicated, but only when that title is unique on both sides, so
      // two tasks called "Call" never pair up. Links are recorded even when a later call fails.
      const links: Record<string, number> = {};
      const key = (title: string) => title.trim().toLowerCase();
      const pending = (doc: Doc) => doc.units.filter(u => u.vk === undefined && syncable(u) && u.lifecycle !== 'done' && u.lifecycle !== 'dropped');
      try {
        for (const snapshot of pending(this.hub(mapId).doc)) {
          await guard(snapshot.designation, async () => {
            const doc = this.hub(mapId).doc, u = doc.units.find(x => x.id === snapshot.id);
            if (!u || u.vk !== undefined || links[u.id] !== undefined) return;
            const project = doc.sectors.find(s => s.id === u.sectorId)?.vk;
            if (!project || frozen.has(project)) return;
            const f = this.unitFields(u, doc);
            const candidates = [...tasks.values()].filter(t => !t.done && t.project_id === project && key(t.title) === key(f.title));
            const namesakes = pending(doc).filter(x => x.sectorId === u.sectorId && key(x.title.slice(0, MAX_TITLE)) === key(f.title));
            const twin = candidates.length === 1 && namesakes.length === 1 ? candidates[0] : undefined;
            if (twin) {
              tasks.delete(twin.id); links[u.id] = twin.id;
              stats.pushed += await this.merge(api, labels, mapId, u, twin, boards, stats);
              return;
            }
            const made = await api.createTask(project, {
              title: f.title, description: textToHtml(f.note), due_date: u.dueAt ?? null, percent_done: (f.progress ?? 0) / 100, done: false,
            });
            // The unit went away while Vikunja answered (an undo of its capture): take the new task back.
            if (!this.hub(mapId).doc.units.some(x => x.id === u.id)) { await api.deleteTask(made.id).catch(() => undefined); return; }
            links[u.id] = made.id; this.setBase(mapId, u.id, made.id, f); stats.created++;
            await this.place(api, made, f.status, boards);
            await this.label(api, labels, made, u.affiliation);
          });
        }
      } finally {
        // Only units that still exist: one undone meanwhile would make the whole batch fail.
        const units = new Set(this.hub(mapId).doc.units.map(u => u.id));
        for (const id of Object.keys(links)) if (!units.has(id)) { await api.deleteTask(links[id]).catch(() => undefined); delete links[id]; }
        if (Object.keys(links).length) this.system(mapId, { action: 'links', links });
      }

      // Tasks made in Vikunja: new pending units (open ones only; finished history stays in Vikunja).
      for (const t of tasks.values()) {
        const doc = this.hub(mapId).doc;
        if (t.done || doc.units.some(u => u.vk === t.id)) continue;
        const sector = doc.sectors.find(s => s.vk === t.project_id);
        if (!sector) continue;
        await guard(`task #${t.id}`, async () => {
          const f = this.taskFields(t, undefined, doc, boards);
          this.system(mapId, { action: 'add', task: t.id, title: t.title.slice(0, MAX_TITLE) || 'Untitled task', sectorId: sector.id,
            ...(noDate(t.due_date) ? {} : { dueAt: new Date(t.due_date!).toISOString() }), ...(f.note ? { note: f.note.slice(0, MAX_NOTE) } : {}), ...(f.status && f.status !== 'todo' ? { status: f.status } : {}), ...(f.affiliation && f.affiliation !== 'pending' ? { affiliation: f.affiliation } : {}) });
          const u = this.hub(mapId).doc.units.find(x => x.vk === t.id)!;
          this.setBase(mapId, u.id, t.id, this.unitFields(u, this.hub(mapId).doc));
          stats.added++;
        });
      }
      info.lastSync = new Date().toISOString();
      for (const k of ['pushed', 'pulled', 'created', 'added'] as const) info[k] += stats[k];
      const summary = `${stats.pushed} pushed, ${stats.pulled} pulled, ${stats.created} tasks created, ${stats.added} new units`;
      if (problems.length) {
        info.lastError = problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : '');
        console.error('Vikunja sync: some items failed', mapId, info.lastError);
        return `${summary} · ${problems.length} failed: ${info.lastError}`;
      }
      delete info.lastError;
      return summary;
    } catch (error) {
      info.lastError = error instanceof Error ? error.message : String(error);
      console.error('Vikunja sync failed', mapId, info.lastError);
      throw error;
    }
  }

  /** Three-way merge of one linked unit and its task. Returns 1 when the task was updated. */
  private async merge(api: VkApi, labels: LabelSet, mapId: string, u: Unit, t: VkTask, boards: Map<number, Board>, stats: { pulled: number }): Promise<number> {
    const doc = this.hub(mapId).doc, U = this.unitFields(u, doc), T = this.taskFields(t, u, doc, boards), B = this.base(mapId, u.id);
    // A task in a bucket that means nothing to opsmap has no opinion on the state, except that an open task is
    // not done (a task reopened into a bucket of the user's own).
    if (T.status === null) { const fallback = B?.status ?? U.status; T.status = !t.done && fallback === 'done' ? 'todo' : fallback; }
    if (T.affiliation === null) T.affiliation = B?.affiliation ?? U.affiliation;
    // A task outside the sector projects goes back to its unit's sector.
    let push = false;
    if (T.sector === null) { T.sector = U.sector; push = true; }
    const unitNewer = Date.parse(u.updatedAt) >= Date.parse(t.updated);
    // No agreed values yet (a task just linked by its title): a filled-in value beats an empty one, so nothing is
    // wiped; otherwise, and when both sides changed, the newer side wins.
    const blank = (v: unknown) => v === null || v === '' || v === 0;
    const choose = (key: (typeof FIELDS)[number]): 'ours' | 'theirs' => {
      const ours = U[key], theirs = T[key];
      if (B) { if (ours === B[key]) return 'theirs'; if (theirs === B[key]) return 'ours'; }
      else if (blank(ours) !== blank(theirs)) return blank(ours) ? 'theirs' : 'ours';
      return unitNewer ? 'ours' : 'theirs';
    };
    // Identity first: whether the task's progress counts as BDA depends on the identity that wins.
    const identity = U.affiliation === T.affiliation ? U.affiliation : choose('affiliation') === 'ours' ? U.affiliation : T.affiliation;
    if (identity !== U.affiliation) T.progress = identity === 'hostile' || identity === 'suspect' ? Math.round((t.percent_done ?? 0) * 100) : null;
    const merged = { ...U }, pull: Partial<VkFields> = {};
    for (const key of FIELDS) {
      const ours = U[key], theirs = T[key];
      if (ours === theirs) continue;
      const take = choose(key);
      if (take === 'ours') { if (key !== 'affiliation') push = true; }
      else { (merged as Record<string, unknown>)[key] = theirs; (pull as Record<string, unknown>)[key] = theirs; }
    }
    if (Object.keys(pull).length) {
      const changes: VkChanges = {};
      if (pull.title !== undefined) changes.title = pull.title.slice(0, MAX_TITLE) || u.title;
      if (pull.due !== undefined) changes.dueAt = pull.due === null ? null : new Date(t.due_date!).toISOString();
      if (pull.note !== undefined) changes.note = pull.note.slice(0, MAX_NOTE);
      if (pull.progress !== undefined && pull.progress !== null) changes.strength = Math.max(0, Math.min(100, 100 - pull.progress));
      if (pull.status !== undefined && pull.status !== null) changes.status = pull.status;
      if (pull.sector !== undefined && pull.sector !== null) changes.sectorId = pull.sector;
      if (pull.affiliation !== undefined && pull.affiliation !== null) changes.affiliation = pull.affiliation;
      this.system(mapId, { action: 'pull', unit: u.id, changes });
      stats.pulled++;
      // A pull can change more than it copied (done destroys a hostile: strength 0, so progress 100%). The op
      // ran synchronously, so nothing else has touched the unit since: send those effects back now.
      const after = this.hub(mapId).doc.units.find(x => x.id === u.id);
      if (after) {
        const now = this.unitFields(after, this.hub(mapId).doc);
        // Title and note are copied as they are (or shortened by opsmap's limits): never written back.
        for (const key of FIELDS) if (key !== 'title' && key !== 'note' && now[key] !== merged[key]) { (merged as Record<string, unknown>)[key] = now[key]; if (key !== 'affiliation') push = true; }
      }
    }
    let pushed = 0;
    if (push) {
      const fresh = this.hub(mapId).doc, now = fresh.units.find(x => x.id === u.id) ?? u;
      // Vikunja replaces the whole task: start from its latest copy, so an edit made in Vikunja since the fetch
      // (to fields opsmap does not manage) is kept.
      const latest = await api.task(t.id) ?? t;
      const wanted = this.taskWith({ ...latest, bucket_id: t.bucket_id }, merged, now, fresh);
      const updated = await api.updateTask(wanted);
      // A new project (sector moved) or a reopened task lands in that project's default bucket.
      await this.place(api, { ...updated, project_id: wanted.project_id }, merged.status, boards, wanted.project_id === t.project_id && t.done === wanted.done ? t.bucket_id : undefined);
      pushed = 1;
    }
    // Identity lives in labels: write it when the task's identity labels are not exactly the merged one.
    // Several identity labels are the user's ambiguity to settle: they are left alone.
    const named = affiliationsOf(t);
    if (merged.affiliation && named.length <= 1 && named[0] !== merged.affiliation) { await this.label(api, labels, t, merged.affiliation); pushed = 1; }
    // The agreed values are what was merged, not the unit read again: an edit made during the push must
    // still count as a change on the next cycle.
    this.setBase(mapId, u.id, t.id, merged);
    return pushed;
  }
}

export const isLoopback = (url: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return true; } };
