// Two-way sync between a map and a task service, for any provider (server/providers/*): the map (the A/O) is a root,
// each sector a container, each unit a task. The engine talks to the service only through ProviderSession and reads
// what it may sync from the provider's capabilities; it never asks which provider it has. Pulled changes become
// ordinary ops (`tasks` add, pull, gone, relate) by the system user, with the provider's id as via.
import { SYNC_FIELDS, type Command, type Doc, type Order, type Unit } from '../../src/core/model/types';
import { boundElsewhere, FIELD_HELP, NOT_BOUND, type RemoteChanges } from '../../src/core/commands/apply';
import { DEFAULT_TZ } from '../../src/core/model/time';
import type { Maps } from '../maps';
import type { Hub, Op } from '../hub';
import type { User } from '../db';
import { RateLimited, RemoteAuthError, type Delivery, type FieldKey, type ProviderSession, type RelationKind, type RemoteRoot, type RemoteTask, type TaskProvider, type TaskWrite, type WebhookResult } from './contract';
import type { Credentials } from './credentials';
import type { ProviderRegistry } from './registry';
import type { SyncService } from './service';
import { SyncTables, type Base } from './links';
import { migrateTaskSync } from './migrate';
import { classifyPublicUrl, lookupAll, type Reachability } from './reachability';
import { FIELD_KEY, FIELDS, NOTE_LIMIT, SWITCHED, dayInstant, mergeFields, sectorOf, syncable, taskFields, unitFields, type Field, type Fields, type Limits } from './merge';
import { checkDue, deliveryMode, type DeliveryRecord, deliveryStatus, handshakeMissing, handshakeReason, NUDGE_DELAY_MS, NUDGE_EVERY_MS, pollIntervals, REACH_MS, retryDelay, webhooksBlocked, webhooksBlockedWhy, deliverySummary, type DeliverySummary, type WebhookSetting } from './delivery';

export interface Timers { set(fn:()=>void,ms:number):unknown; clear(handle:unknown):void }
export interface EngineOptions {
  /** The clock, in milliseconds. */ now?:()=>number;
  /** Every address of a host name (PUBLIC_URL's). */ resolve?:(host:string)=>Promise<string[]>;
  /** TASKSYNC_WEBHOOKS. */ webhooks?:WebhookSetting;
  /** Where scheduled cycles wait. */ timers?:Timers;
  /** Provider id → the webhook path (with :map) its existing webhooks post to, when not the generic one (D7). */ hookPaths?:Readonly<Record<string,string>>;
}
interface Info { lastSync?:string; lastAttempt?:number; lastError?:string; pushed:number; pulled:number; created:number; added:number; archived?:string[]; unmatched?:{ name:string; open:number }[] }
interface Stats { pushed:number; pulled:number; created:number; added:number }
type Guard=(what:string,fn:()=>Promise<void>)=>Promise<void>;
/** What one cycle works with. */
interface Cycle { mapId:string; provider:TaskProvider; session:ProviderSession; root:RemoteRoot; tz:string; limits:Limits; declared:ReadonlySet<Field>; /** Switched off on this map (D21). */ off:ReadonlySet<Field>; stats:Stats }
const SYSTEM='system';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const iso=(ms:number)=>new Date(ms).toISOString();
/** One relation between two units; a plain link has no direction, so its ends are sorted. */
const edgeKey=(kind:RelationKind,from:string,to:string)=>JSON.stringify(kind==='link'?[kind,...[from,to].sort()]:[kind,from,to]);

export class TaskSyncEngine implements SyncService {
  readonly tables:SyncTables;
  private readonly chains=new Map<string,Promise<unknown>>();
  private readonly planned=new Map<string,{ handle:unknown; at:number }>();
  private readonly info=new Map<string,Info>();
  private readonly nudged=new Map<string,number>();
  private poller?:ReturnType<typeof setInterval>;
  private stopped=false;
  private reach?:{ value:Reachability; at:number };
  private reaching?:Promise<Reachability|undefined>;
  private readonly now:()=>number;
  private readonly resolveHost:(host:string)=>Promise<string[]>;
  private readonly setting:WebhookSetting;
  private readonly timers:Timers;
  private readonly hookPaths:Readonly<Record<string,string>>;
  private readonly onEvent:(event:{ kind:string; mapId?:string; op?:Op; deleted?:string })=>void;

  /** `hookBase`: PUBLIC_URL, where services post webhooks; without it the engine polls only. `pollOverrideMs`: TASKSYNC_POLL_SECONDS. */
  constructor(readonly maps:Maps,readonly registry:ProviderRegistry,readonly credentials:Credentials,readonly hookBase?:string,readonly debounceMs=1000,readonly pollOverrideMs?:number,options:EngineOptions={}) {
    this.tables=new SyncTables(maps.store);migrateTaskSync(maps.store);
    this.now=options.now??Date.now;this.resolveHost=options.resolve??lookupAll;this.setting=options.webhooks??'auto';this.hookPaths=options.hookPaths??{};
    this.timers=options.timers??{set:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();return t;},clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
    // Every change on a bound map, except the sync's own, pushes after a short pause. A deleted map takes its webhooks with it.
    this.onEvent=event=>{
      if(event.kind==='maps'&&event.deleted){const id=event.deleted;void this.serial(id,()=>this.release(id)).catch(()=>undefined);return;}
      if(event.kind!=='op'||!event.mapId||event.op?.via!==undefined&&this.registry.get(event.op.via))return;
      if(this.maps.get(event.mapId)?.doc.settings.taskSync||this.tables.row(event.mapId))this.schedule(event.mapId,this.debounceMs);
    };
    maps.listeners.add(this.onEvent);
    void this.reachability();
  }

  // ---------- scheduling ----------
  start():void {
    this.poller=setInterval(()=>this.poll(),5000);this.poller.unref?.();
    for(const hub of this.maps.hubs.values())if(hub.doc.settings.taskSync)this.schedule(hub.mapId,2000);
  }
  async stop():Promise<void> {
    this.stopped=true;
    if(this.poller)clearInterval(this.poller);
    for(const p of this.planned.values())this.timers.clear(p.handle);
    this.planned.clear();this.maps.listeners.delete(this.onEvent);
    await Promise.allSettled([...this.chains.values()]);
  }
  /** Runs a cycle for each bound map whose poll interval (by delivery mode) has passed; a map without a token waits. */
  poll():void {
    for(const hub of this.maps.hubs.values()) {
      const bound=hub.doc.settings.taskSync,p=bound&&this.registry.get(bound.provider);
      if(!p||!this.credentials.token(this.tables.row(hub.mapId)?.owner??undefined,p.descriptor.id))continue;
      const last=this.info.get(hub.mapId)?.lastAttempt;
      if(last===undefined||this.now()-last>=this.delivery(hub.mapId).nextPollMs)this.schedule(hub.mapId,0,true);
    }
  }
  /** Someone is looking at the map: pull within 2 s when webhooks are not live, at most once per 20 s per map. */
  nudge(mapId:string):void {
    const bound=this.maps.get(mapId)?.doc.settings.taskSync,p=bound&&this.registry.get(bound.provider);
    if(!p||!this.credentials.token(this.tables.row(mapId)?.owner??undefined,p.descriptor.id)||this.delivery(mapId).mode==='live')return;
    const last=this.nudged.get(mapId);if(last!==undefined&&this.now()-last<NUDGE_EVERY_MS)return;
    this.nudged.set(mapId,this.now());this.schedule(mapId,NUDGE_DELAY_MS,true);
  }
  /** A cycle in `delay` ms; `earlier`: only when that is sooner than the one already planned. */
  schedule(mapId:string,delay:number,earlier=false):void {
    if(this.stopped)return;
    const at=this.now()+delay,current=this.planned.get(mapId);
    // An overdue one is firing now, or late: it does not hold this one back.
    if(earlier&&current&&current.at<=at&&current.at>=this.now())return;
    if(current)this.timers.clear(current.handle);
    const handle=this.timers.set(()=>{this.planned.delete(mapId);this.run(mapId).catch(()=>undefined);},delay);
    this.planned.set(mapId,{handle,at});
  }
  /** One cycle at a time per map. */
  private serial<T>(mapId:string,fn:()=>Promise<T>):Promise<T> {
    const next=(this.chains.get(mapId)??Promise.resolve()).catch(()=>undefined).then(fn);
    this.chains.set(mapId,next.catch(()=>undefined));
    return next;
  }
  run(mapId:string,force=false):Promise<string> {return this.serial(mapId,()=>this.cycle(mapId,force));}

  // ---------- requests (/tasks bind, sync, status) ----------
  private hub(mapId:string):Hub {const hub=this.maps.get(mapId);if(!hub)throw new Error('Unknown map');return hub;}
  private infoOf(mapId:string):Info {let info=this.info.get(mapId);if(!info){info={pushed:0,pulled:0,created:0,added:0};this.info.set(mapId,info);}return info;}
  /** A map syncs with the token of the user who bound it. */
  private sessionFor(userId:string|undefined,p:TaskProvider):ProviderSession {
    const session=this.credentials.session(userId,p.descriptor.id),label=p.descriptor.label;
    if(!session)throw new Error(`No ${label} token for ${userId?this.maps.store.user(userId)?.name??userId:'this map'}: connect it in the menu → ${label}`);
    return session;
  }
  private bindProvider(id:unknown):TaskProvider {
    if(typeof id==='string'){const p=this.registry.get(id);if(!p)throw new Error(`Unknown task service: ${id.slice(0,64)}`);return p;}
    const all=this.registry.list();if(all.length===1)return all[0];
    throw new Error(all.length?`Name the task service: /tasks bind ‹${all.map(p=>p.descriptor.id).join('|')}› "‹project›"`:'No task service is configured on this server');
  }
  async request(mapId:string,args:Record<string,unknown>,user:User,source:Op['source']):Promise<string> {
    const hub=this.hub(mapId),action=String(args.action);
    if(action==='status'){await this.reachability();return this.status(hub);}
    if(action==='sync'){const bound=hub.doc.settings.taskSync;if(!bound)throw new Error(NOT_BOUND);return `${bound.label.toUpperCase()} SYNC — ${await this.run(mapId,true)}`;}
    if(action!=='bind')throw new Error(`Unknown /tasks action: ${action}`);
    const p=this.bindProvider(args.provider),{id,label,rootNoun}=p.descriptor;
    const name=typeof args.name==='string'?args.name.replace(/\s+/g,' ').trim():'';
    if(!name||name.length>250)throw new Error(`Expected a ${label} ${rootNoun} name`);
    const same=(b:{provider:string;title:string})=>b.provider===id&&b.title.toLowerCase()===name.toLowerCase();
    const bound=hub.doc.settings.taskSync;if(bound&&!same(bound))throw new Error(boundElsewhere(bound));
    // `without ‹fields›` (D21): bound with those already off.
    if(args.off!==undefined&&!(Array.isArray(args.off)&&args.off.every(f=>(SYNC_FIELDS as readonly unknown[]).includes(f))))throw new Error(FIELD_HELP);
    const off=Array.isArray(args.off)?SYNC_FIELDS.filter(f=>(args.off as unknown[]).includes(f)):undefined;
    const session=this.sessionFor(user.id,p);
    const check=()=>{
      const now=this.hub(mapId).doc.settings.taskSync,owner=this.tables.row(mapId)?.owner;
      if(now&&!same(now))throw new Error(boundElsewhere(now));
      if(now&&owner&&owner!==user.id)throw new Error(`Bound by ${this.maps.store.user(owner)?.name??owner}: they sync it with their ${label} account`);
    };
    check();
    return this.serial(mapId,async()=>{
      // Again in the queue: another bind may have finished while this one waited.
      check();
      const root=await session.resolveRoot(name);
      const containers=await session.ensureContainers(root,this.hub(mapId).doc.sectors.map(s=>({sectorId:s.id,name:s.name})),{});
      check();
      this.tables.ensure(mapId,id);this.tables.set(mapId,{owner:user.id});
      // Recorded by the system, so a user's /undo cannot strip the binding from under linked units: /tasks unbind does that.
      const op=this.hub(mapId).internal(SYSTEM,'system',{verb:'tasks',args:{action:'bound',provider:id,label,root:root.id,title:root.title,by:user.id,containers,...(off?{off}:{})}},source==='mcp'?'mcp':'web');
      return `${op.log} — ${await this.cycle(mapId,true)}`;
    });
  }
  private status(hub:Hub):string {
    const bound=hub.doc.settings.taskSync;if(!bound)return NOT_BOUND;
    const p=this.registry.get(bound.provider),LABEL=bound.label.toUpperCase();
    if(!p)return `${LABEL}: bound to ${bound.title}, but ${bound.label} is not configured on this server`;
    const d=p.descriptor,s=this.info.get(hub.mapId),linked=hub.doc.units.filter(u=>u.remote!==undefined).length;
    const time=(at?:string)=>at?new Date(at).toISOString().slice(11,19)+'Z':'never';
    const by=this.tables.row(hub.mapId)?.owner??undefined,owner=by?this.maps.store.user(by)?.name??by:'nobody on this server (/tasks unbind, then /tasks bind)';
    const token=!by||this.credentials.token(by,d.id)?'':` (no token: connect it in the menu → ${d.label})`;
    const archived=s?.archived?.length?` · not synced, ${d.containerNoun} archived in ${d.label}: ${s.archived.join(', ')}`:'';
    const unmatched=s?.unmatched?.length?` · not synced: ${s.unmatched.map(u=>`${d.containerNoun} ${u.name} (${u.open} task${u.open===1?'':'s'})`).join(', ')}`:'';
    return `${LABEL}: bound to ${bound.title} (${d.urls.root.replace('{root}',encodeURIComponent(bound.root))}) by ${owner}${token} · ${hub.doc.sectors.filter(x=>x.remote).length} sectors · ${linked} units linked · ${bound.off?.length?`not synced: ${bound.off.join(', ')} · `:''}`+
      `${deliveryStatus(this.delivery(hub.mapId),this.hookCount(hub.mapId),p.capabilities.webhookHint)} · last sync ${time(s?.lastSync)}${archived}${unmatched}${s?.lastError?` · last error: ${s.lastError}`:''}`;
  }

  // ---------- webhooks and delivery ----------
  /** PUBLIC_URL as a task service sees it, checked at start, again every hour, and on every cycle while it does not resolve. */
  private reachability():Promise<Reachability|undefined> {
    if(!this.hookBase)return Promise.resolve(undefined);
    const known=this.reach;if(known&&!known.value.failed&&this.now()-known.at<REACH_MS)return Promise.resolve(known.value);
    this.reaching??=classifyPublicUrl(this.hookBase,this.resolveHost).then(value=>{this.reach={value,at:this.now()};return value;}).finally(()=>{this.reaching=undefined;});
    return this.reaching;
  }
  private blocked(p:TaskProvider):string|undefined {return webhooksBlocked(this.setting,this.hookBase,this.reach?.value,p.capabilities,p.descriptor.label);}
  /** How the map learns of remote changes now, and how often it polls. */
  delivery(mapId:string):Delivery {
    const bound=this.maps.get(mapId)?.doc.settings.taskSync,p=bound&&this.registry.get(bound.provider);
    if(!p)return {mode:'off',reason:'not bound',nextPollMs:0};
    const {pollMs,idlePollMs}=pollIntervals(p.capabilities,this.pollOverrideMs);
    return deliveryMode({blocked:this.blocked(p),caps:p.capabilities,label:p.descriptor.label,rec:this.tables.delivery(mapId),checkedAt:this.tables.row(mapId)?.hooks_checked,lastDelivery:this.tables.row(mapId)?.last_delivery,now:this.now(),pollMs,idlePollMs,count:this.hookCount(mapId)});
  }
  /** The delivery mode as the sidebar shows it (sent with the /tasks status answer), or undefined when the map is not bound. */
  async deliveryInfo(mapId:string):Promise<DeliverySummary|undefined> {
    const bound=this.maps.get(mapId)?.doc.settings.taskSync,p=bound&&this.registry.get(bound.provider);if(!p)return undefined;
    await this.reachability();
    return deliverySummary(this.delivery(mapId),this.hookCount(mapId),webhooksBlockedWhy(this.setting,this.hookBase,this.reach?.value,p.capabilities,p.descriptor.label)?.note);
  }
  /** Registered webhooks, as the provider counts its state, else one per watched container. */
  private hookCount(mapId:string):number {
    const hooks=this.tables.hooks(mapId),p=this.registry.get(this.tables.row(mapId)?.provider??'');
    return hooks===null?0:p?.hookCount?.(hooks)??this.tables.delivery(mapId).containers?.length??0;
  }
  /** Where the provider posts: the generic path, or the older one its webhooks were made with (D7). */
  private target(p:TaskProvider,mapId:string):string {
    const path=this.hookPaths[p.descriptor.id]??`/api/tasksync/${p.descriptor.id}/hook/:map`;
    return `${this.hookBase}${path.replace(':map',encodeURIComponent(mapId))}`;
  }
  /** Registers or checks the map's webhooks when they are due (every 10 minutes, at once on /tasks sync or a sector
   *  change, and on the backoff after a failure). A failure is kept for status; it never stops the cycle. */
  private async webhooks(c:Cycle,containers:string[],force:boolean):Promise<void> {
    const {mapId,provider:p,session,root}=c,now=this.now(),rec=this.tables.delivery(mapId),row=this.tables.row(mapId)!;
    rec.root=root;
    const blocked=this.blocked(p),hooks=this.tables.hooks(mapId);
    if(blocked||!session.ensureWebhooks||!p.capabilities.webhooks) {
      // Turned off since they were made (or PUBLIC_URL moved): take them down, unless the address only failed to resolve.
      if(hooks!==null&&session.removeWebhooks&&!this.reach?.value.failed){await session.removeWebhooks(root,hooks).catch(()=>undefined);this.tables.set(mapId,{hooks:null,hooks_checked:null});}
      this.tables.setDelivery(mapId,{root});return;
    }
    if(!rec.failure&&handshakeMissing(p.capabilities,rec,now))this.fail(rec,handshakeReason(p.capabilities,p.descriptor.label),now);
    if(!checkDue(rec,row.hooks_checked,containers,now,force)){this.tables.setDelivery(mapId,rec);return;}
    // registeredAt, containers, failure and failures are this check's; they are written onto the record as it is
    // after the call, because a handshake can arrive while the provider is still registering (handshakeAt, failures).
    let owned:(r:DeliveryRecord)=>void;
    try {
      // After a failure the webhooks are made again, not just checked.
      const state=await session.ensureWebhooks(root,containers,this.target(p,mapId),row.secret,hooks,force||Boolean(rec.failure));
      const renew=Boolean(rec.failure)||!rec.registeredAt||JSON.stringify(state??null)!==JSON.stringify(hooks);
      owned=r=>{if(renew)r.registeredAt=iso(now);r.containers=[...containers];delete r.failure;if(!p.capabilities.webhooks||!p.capabilities.webhooks.handshakeTimeoutMs)r.failures=0;};
      this.tables.set(mapId,{hooks:JSON.stringify(state??null),hooks_checked:iso(now)});
    }catch(error){
      if(error instanceof RateLimited||error instanceof RemoteAuthError)throw error;
      owned=r=>this.fail(r,message(error),now);
      this.tables.set(mapId,{hooks_checked:iso(now)});
    }
    const fresh=this.tables.delivery(mapId),answered=fresh.handshakeAt!==undefined&&Date.parse(fresh.handshakeAt)>=now;
    fresh.root=root;fresh.failures=answered?0:rec.failures;
    owned(fresh);
    this.tables.setDelivery(mapId,fresh);
  }
  private fail(rec:ReturnType<SyncTables['delivery']>,reason:string,now:number):void {
    rec.failures=(rec.failures??0)+1;rec.failure={reason,count:rec.failures,retryAt:iso(now+retryDelay(rec.failures))};
  }
  /** A delivery to the provider's hook: checked by the provider with the map's secret. */
  webhook(provider:string,mapId:string,headers:Headers,body:string):WebhookResult {
    const p=this.registry.get(provider);if(!p?.receiveWebhook)return {status:404,trigger:false};
    const row=this.tables.row(mapId);if(!row||row.provider!==provider||!this.maps.get(mapId))return {status:401,trigger:false};
    const result=p.receiveWebhook(headers,body,row.secret,this.tables.state(mapId));
    if(result.status>=300)return result;
    const now=iso(this.now()),rec=this.tables.delivery(mapId);
    rec.handshakeAt=now;rec.failures=0;delete rec.failure;this.tables.setDelivery(mapId,rec);
    if(result.store!==undefined)this.tables.set(mapId,{state:JSON.stringify(result.store)});
    if(result.trigger){this.tables.set(mapId,{last_delivery:now});this.schedule(mapId,500);}
    return result;
  }
  /** Unbound or deleted: remove its webhooks and sync state. Tasks stay in the service. */
  private async release(mapId:string):Promise<void> {
    const row=this.tables.row(mapId);if(!row)return;
    const p=this.registry.get(row.provider),session=p&&this.credentials.session(row.owner??undefined,p.descriptor.id),hooks=this.tables.hooks(mapId);
    if(session?.removeWebhooks&&hooks!==null)await session.removeWebhooks(this.tables.delivery(mapId).root??{id:'',title:''},hooks).catch(()=>undefined);
    this.tables.release(mapId);
  }

  // ---------- one sync cycle ----------
  /** The fields this map syncs: what the provider declares, less the ones the map switched off (D21). */
  private effectiveFields(p:TaskProvider,doc:Doc):ReadonlySet<Field> {const off=this.switchedOff(doc);return new Set(FIELDS.filter(k=>p.capabilities.fields.has(FIELD_KEY[k])&&!off.has(k)));}
  private switchedOff(doc:Doc):ReadonlySet<Field> {return new Set((doc.settings.taskSync?.off??[]).map(f=>SWITCHED[f]));}
  /** The agreed values as stored, with the fields that were off when they were agreed. */
  private record(c:Cycle,f:Fields,idPushed:boolean):Base {return {...f,...(c.off.size?{off:FIELDS.filter(k=>c.off.has(k))}:{}),idPushed};}
  private system(mapId:string,p:TaskProvider,args:Record<string,unknown>):Op {
    const cmd:Command={verb:'tasks',args};
    return this.hub(mapId).internal(SYSTEM,'system',cmd,p.descriptor.id);
  }
  private async cycle(mapId:string,force=false):Promise<string> {
    const stats:Stats={pushed:0,pulled:0,created:0,added:0},info=this.infoOf(mapId);
    info.lastAttempt=this.now();
    let label='Task';
    try {
      const binding=this.hub(mapId).doc.settings.taskSync;
      if(!binding){await this.release(mapId);return 'not bound';}
      label=binding.label;
      const p=this.registry.get(binding.provider);if(!p)throw new Error(`${binding.label} is not configured on this server`);
      const row=this.tables.row(mapId),owner=row?.provider===binding.provider?row.owner??undefined:undefined;
      if(!owner||(binding.by!==undefined&&binding.by!==owner))throw new Error('This map was not bound on this server: /tasks unbind, then /tasks bind');
      const session=this.sessionFor(owner,p);
      await this.reachability();
      const first=this.hub(mapId).doc,tz=first.settings.tz??DEFAULT_TZ,root:RemoteRoot={id:binding.root,title:binding.title};
      const c:Cycle={mapId,provider:p,session,root,tz,limits:{maxTitle:p.capabilities.maxTitle,maxNote:Math.min(p.capabilities.maxNote,NOTE_LIMIT)},declared:this.effectiveFields(p,first),off:this.switchedOff(first),stats};
      // Sectors without a container (added since, or the container was deleted) get one.
      const known=Object.fromEntries(first.sectors.filter(s=>s.remote!==undefined).map(s=>[s.id,s.remote!]));
      const containers=await session.ensureContainers(root,first.sectors.map(s=>({sectorId:s.id,name:s.name})),known);
      const missing=Object.fromEntries(Object.entries(containers).filter(([id,x])=>known[id]!==x&&this.hub(mapId).doc.sectors.some(s=>s.id===id)));
      if(Object.keys(missing).length)this.system(mapId,p,{action:'containers',containers:missing});
      const doc0=this.hub(mapId).doc,mapping=Object.fromEntries(doc0.sectors.filter(s=>s.remote!==undefined).map(s=>[s.id,s.remote!]));
      const snap=await session.snapshot(root,mapping,tz),mine=new Set(Object.values(mapping));
      // A sector whose container is archived remotely is read-only there: it is left out until it is unarchived.
      const frozen=new Set(snap.unmatched.filter(u=>u.container.archived&&mine.has(u.container.id)).map(u=>u.container.id));
      info.archived=doc0.sectors.filter(s=>s.remote!==undefined&&frozen.has(s.remote)).map(s=>s.name);
      info.unmatched=snap.unmatched.filter(u=>!u.container.archived&&!mine.has(u.container.id)).map(u=>({name:u.container.name,open:u.open}));
      await this.webhooks(c,[...mine].filter(x=>!frozen.has(x)),force);
      const tasks=new Map(snap.tasks.map(t=>[t.id,t]));
      // Every task read this cycle, for the relations pass (the loops below take tasks out of `tasks`).
      const fetched=new Map(tasks);
      // One unit or task that fails (a service error, a rejected value) does not hold up the rest; a rate limit or a
      // refused token stops the cycle.
      const problems:string[]=[];
      const guard:Guard=async(what,fn)=>{try{await fn();}catch(error){if(error instanceof RateLimited||error instanceof RemoteAuthError)throw error;problems.push(`${what}: ${message(error)}`);}};
      await this.linked(c,tasks,fetched,frozen,guard);
      await this.create(c,tasks,fetched,frozen,guard);
      await this.added(c,tasks,guard);
      await this.relations(c,fetched,guard);
      info.lastSync=iso(this.now());
      for(const k of ['pushed','pulled','created','added'] as const)info[k]+=stats[k];
      const summary=`${stats.pushed} pushed, ${stats.pulled} pulled, ${stats.created} tasks created, ${stats.added} new units`;
      if(problems.length) {
        info.lastError=problems.slice(0,3).join('; ')+(problems.length>3?` (+${problems.length-3} more)`:'');
        console.error(`Task sync (${label}): some items failed`,mapId,info.lastError);
        return `${summary} · ${problems.length} failed: ${info.lastError}`;
      }
      delete info.lastError;
      return summary;
    }catch(error){
      info.lastError=message(error);
      if(error instanceof RateLimited)this.schedule(mapId,error.retryAfterS*1000,true);
      console.error(`Task sync (${label}) failed`,mapId,info.lastError);
      throw error;
    }
  }
  /** Linked units: merge field by field; a task gone remotely drops its unit. */
  private async linked(c:Cycle,tasks:Map<string,RemoteTask>,fetched:Map<string,RemoteTask>,frozen:Set<string>,guard:Guard):Promise<void> {
    const {mapId,session,root,tz}=c;
    for(const snapshot of this.hub(mapId).doc.units.filter(u=>u.remote!==undefined)) {
      const doc=this.hub(mapId).doc,u=doc.units.find(x=>x.id===snapshot.id);
      if(!u||u.remote===undefined)continue;
      const id=u.remote,sector=doc.sectors.find(s=>s.id===u.sectorId)?.remote;
      if(sector!==undefined&&frozen.has(sector))continue;
      await guard(u.designation,async()=>{
        let t=tasks.get(id);tasks.delete(id);
        if(!t) {
          const remote=await session.getTask(root,id,tz);
          if(!remote) {
            // Deleted remotely: the unit is dropped and lets go of it.
            this.system(mapId,c.provider,{action:'gone',unit:u.id});c.stats.pulled++;
            this.tables.setBase(mapId,u.id,id,null);return;
          }
          // Still there, outside this A/O's containers (a removed sector, or moved away): a task is never treated as
          // deleted while it exists; it goes back to its unit's sector. In an archived container it waits.
          if(remote.container!==null&&frozen.has(remote.container))return;
          t=remote;fetched.set(id,remote);
        }
        c.stats.pushed+=await this.merge(c,u,t);
      });
    }
  }
  /** Units without a task get one (not ones already finished: their history stays on the map). An open, unlinked
   *  task with the same title in the same container is the same item (a rebind, or one typed on both sides): it is
   *  linked instead of duplicated, but only when that title is unique on both sides. Links are recorded even when a
   *  later call fails. A task force's task is made before its members', and a member is made under it (D13). */
  private async create(c:Cycle,tasks:Map<string,RemoteTask>,fetched:Map<string,RemoteTask>,frozen:Set<string>,guard:Guard):Promise<void> {
    const {mapId,session,root,tz,limits,declared}=c,links:Record<string,string>={};
    const key=(title:string)=>title.trim().toLowerCase();
    const pending=(doc:Doc)=>doc.units.filter(u=>u.remote===undefined&&syncable(u)&&u.lifecycle!=='done'&&u.lifecycle!=='dropped');
    const nesting=c.provider.capabilities.fields.has('parent'),start=this.hub(mapId).doc;
    const depth=(u:Unit)=>{let n=0;const seen=new Set<string>();for(let at=u.parentId;at&&!seen.has(at);at=start.units.find(x=>x.id===at)?.parentId){seen.add(at);n++;}return n;};
    try {
      for(const snapshot of pending(start).map(u=>({u,d:depth(u)})).sort((a,b)=>a.d-b.d).map(x=>x.u)) {
        await guard(snapshot.designation,async()=>{
          const doc=this.hub(mapId).doc,u=doc.units.find(x=>x.id===snapshot.id);
          if(!u||u.remote!==undefined||links[u.id]!==undefined)return;
          const container=doc.sectors.find(s=>s.id===u.sectorId)?.remote;
          if(!container||frozen.has(container))return;
          const f=unitFields(u,doc,limits),tf=nesting&&u.parentId?doc.units.find(x=>x.id===u.parentId):undefined,parent=tf?tf.remote??links[tf.id]:undefined;
          // A member's twin may be kept only under the task force's task, in no container.
          const candidates=[...tasks.values()].filter(t=>t.status!=='done'&&(t.container===container||parent!==undefined&&t.container===null&&t.parent===parent)&&key(t.title)===key(f.title));
          const namesakes=pending(doc).filter(x=>x.sectorId===u.sectorId&&key(x.title.slice(0,limits.maxTitle))===key(f.title));
          const twin=candidates.length===1&&namesakes.length===1?candidates[0]:undefined;
          if(twin){tasks.delete(twin.id);links[u.id]=twin.id;c.stats.pushed+=await this.merge(c,u,twin);return;}
          const has=(k:Field)=>declared.has(k);
          const made=await session.createTask(root,{title:f.title,container,...(parent!==undefined?{parent}:{}),...(has('note')?{note:f.note}:{}),...(has('due')?{due:f.due,dueAt:u.dueAt??null}:{}),
            ...(has('status')&&f.status?{status:f.status}:{}),...(has('progress')?{progress:(f.progress??0)/100}:{}),...(has('affiliation')?{affiliation:u.affiliation}:{})},tz);
          // The unit went away while the service answered (an undo of its capture): take the new task back.
          if(!this.hub(mapId).doc.units.some(x=>x.id===u.id)){await session.deleteTask?.(root,made.id).catch(()=>undefined);return;}
          links[u.id]=made.id;this.tables.setBase(mapId,u.id,made.id,this.record(c,f,has('affiliation')));c.stats.created++;fetched.set(made.id,{...made,parent:parent??null,parents:parent!==undefined?[parent]:[],relations:[]});
        });
      }
    }finally{
      // Only units that still exist: one undone meanwhile would make the whole batch fail.
      const units=new Set(this.hub(mapId).doc.units.map(u=>u.id));
      for(const id of Object.keys(links))if(!units.has(id)){await session.deleteTask?.(root,links[id]).catch(()=>undefined);delete links[id];}
      if(Object.keys(links).length)this.system(mapId,c.provider,{action:'links',links});
    }
  }
  /** Tasks made remotely: new pending units (open ones only; finished history stays in the service). A subtask kept
   *  under its parent rather than in a container arrives in its parent unit's sector, and only under a linked parent. */
  private async added(c:Cycle,tasks:Map<string,RemoteTask>,guard:Guard):Promise<void> {
    const {mapId,limits,declared,tz}=c;
    const nested=(t:RemoteTask)=>Number(t.container===null&&t.parent!==null);
    for(const t of [...tasks.values()].sort((a,b)=>nested(a)-nested(b))) {
      const doc=this.hub(mapId).doc;
      if(t.status==='done'||doc.units.some(u=>u.remote===t.id))continue;
      const sector=t.container===null?t.parent===null?null:doc.units.find(u=>u.remote===t.parent)?.sectorId??null:sectorOf(doc,t.container);
      if(!sector)continue;
      await guard(`task #${t.id}`,async()=>{
        const f=taskFields(t,undefined,doc,limits),has=(k:Field)=>declared.has(k);
        this.system(mapId,c.provider,{action:'add',task:t.id,title:t.title.slice(0,limits.maxTitle)||'Untitled task',sectorId:sector,
          ...(has('due')&&t.due!==null?{dueAt:t.dueAt??dayInstant(t.due,tz)}:{}),...(has('note')&&f.note?{note:f.note.slice(0,NOTE_LIMIT)}:{}),
          ...(has('status')&&f.status&&f.status!=='todo'?{status:f.status}:{}),...(has('affiliation')&&f.affiliation&&f.affiliation!=='pending'?{affiliation:f.affiliation}:{})});
        const now=this.hub(mapId).doc,u=now.units.find(x=>x.remote===t.id)!;
        this.tables.setBase(mapId,u.id,t.id,this.record(c,unitFields(u,now,limits),false));c.stats.added++;
      });
    }
  }

  /** Three-way merge of one linked unit and its task. Returns 1 when the task was updated. */
  private async merge(c:Cycle,u:Unit,t:RemoteTask):Promise<number> {
    const {mapId,session,root,tz,limits,declared,off}=c,doc=this.hub(mapId).doc;
    const U=unitFields(u,doc,limits),T=taskFields(t,u,doc,limits),saved=this.tables.base(mapId,u.id);
    // A field switched back on since the values were agreed is re-based (D21): the task's value counts as agreed, so
    // opsmap's value wins once and nothing old comes back from the service.
    const back=(saved?.off??[]).filter(k=>declared.has(k)),B:Fields|undefined=saved&&back.length?{...saved,...Object.fromEntries(back.map(k=>[k,T[k]]))}:saved;
    // Identity switched off since (or a task just linked while it is off): the identity tags or labels opsmap manages
    // come off the task, once; the base records it.
    // Only an identity opsmap wrote: not one on a task linked by its title or made in the service. A base from before
    // D21 counts as written when the task carries exactly the unit's identity (opsmap assigned every label then).
    const pushedBefore=saved===undefined?false:saved.idPushed??(t.affiliations.length===1&&t.affiliations[0]===u.affiliation);
    const clear=pushedBefore&&off.has('affiliation')&&c.provider.capabilities.fields.has('affiliation')&&!saved?.off?.includes('affiliation')&&t.affiliations.length>0;
    const {merged,pull,push:wanted}=mergeFields(U,T,B,Date.parse(u.updatedAt)>=Date.parse(t.updatedAt),t.progress,declared);
    let push=wanted;
    if(Object.keys(pull).length) {
      const changes:RemoteChanges={};
      if(pull.title!==undefined)changes.title=pull.title.slice(0,limits.maxTitle)||u.title;
      if(pull.due!==undefined)changes.dueAt=pull.due===null?null:t.dueAt??dayInstant(pull.due,tz);
      if(pull.note!==undefined)changes.note=pull.note.slice(0,NOTE_LIMIT);
      if(pull.progress!==undefined&&pull.progress!==null)changes.strength=Math.max(0,Math.min(100,100-pull.progress));
      if(pull.status!==undefined&&pull.status!==null)changes.status=pull.status;
      if(pull.sector!==undefined&&pull.sector!==null)changes.sectorId=pull.sector;
      if(pull.affiliation!==undefined&&pull.affiliation!==null)changes.affiliation=pull.affiliation;
      this.system(mapId,c.provider,{action:'pull',unit:u.id,changes});c.stats.pulled++;
      // A pull can change more than it copied (done destroys a hostile: strength 0, so progress 100%). The op ran
      // synchronously, so nothing else has touched the unit since: send those effects back now.
      const after=this.hub(mapId).doc.units.find(x=>x.id===u.id);
      if(after) {
        const now=unitFields(after,this.hub(mapId).doc,limits);
        // Title and note are copied as they are (or shortened by opsmap's limits): never written back.
        for(const key of FIELDS)if(key!=='title'&&key!=='note'&&now[key]!==merged[key]){(merged as unknown as Record<string,unknown>)[key]=now[key];if(key!=='affiliation'&&declared.has(key))push=true;}
      }
    }
    const write:TaskWrite=push?this.fieldsWrite(c,merged,this.hub(mapId).doc,u.id,t):{};
    // Identity: written when the task's identity is not exactly the merged one. Several are the user's ambiguity to
    // settle in the service: they are left alone.
    if(declared.has('affiliation')&&merged.affiliation&&t.affiliations.length<=1&&t.affiliations[0]!==merged.affiliation)write.affiliation=merged.affiliation;
    if(clear)write.affiliation=null;
    let pushed=0;
    if(Object.keys(write).length){await session.updateTask(root,t,write,tz);pushed=1;}
    // The agreed values are what was merged, not the unit read again: an edit made during the push must still count
    // as a change on the next cycle.
    // Cleared: nothing opsmap wrote is left; pushed: the identity on the task is opsmap's.
    this.tables.setBase(mapId,u.id,t.id,this.record(c,merged,clear?false:pushedBefore||typeof write.affiliation==='string'&&pushed===1));
    return pushed;
  }
  /** The declared fields of the task as opsmap wants it. */
  private fieldsWrite(c:Cycle,f:Fields,doc:Doc,unitId:string,t:RemoteTask):TaskWrite {
    const has=(k:Field)=>c.declared.has(k),u=doc.units.find(x=>x.id===unitId),container=doc.sectors.find(s=>s.id===f.sector)?.remote;
    return {title:f.title,...(has('note')?{note:f.note}:{}),...(has('due')?{due:f.due,dueAt:f.due===null?null:u?.dueAt??t.dueAt??null}:{}),
      ...(has('status')&&f.status?{status:f.status}:{}),...(has('progress')&&f.progress!==null?{progress:f.progress/100}:{}),...(has('sector')&&container?{container}:{})};
  }

  /** Relations between linked units whose tasks were read this cycle, merged against the agreed set: one added or
   *  removed on one side is copied across. A unit's parent task merges like a field (the newer change wins). */
  private async relations(c:Cycle,fetched:Map<string,RemoteTask>,guard:Guard):Promise<void> {
    const {mapId,session,root,tz,provider:p,stats}=c,base=this.tables.relations(mapId);
    const doc=()=>this.hub(mapId).doc;
    const byTask=()=>new Map(doc().units.filter(u=>u.remote!==undefined&&fetched.has(u.remote)).map(u=>[u.remote!,u]));
    const seen=(u:Unit|undefined):u is Unit=>u?.remote!==undefined&&fetched.has(u.remote);
    const unit=(id:string)=>doc().units.find(u=>u.id===id);
    // A parent task opsmap refused (a cycle) is tried again each cycle, but reported only the first time (D13).
    const parentKey=(unitId:string,task:string)=>JSON.stringify(['parent',unitId,task]),isParentKey=(k:string)=>k.startsWith('["parent",');
    const refusedParents=new Set(base.refused.filter(isParentKey)),stillRefusedParents=new Set<string>();
    // Parent task ↔ task force: a unit is attached to at most one, so a task with several parents has no opinion.
    const parents:Record<string,string|null>={};
    if(p.capabilities.fields.has('parent')) {
      for(const id of doc().units.map(u=>u.id)) {
        const units=byTask(),u=unit(id);
        if(!seen(u))continue;
        const t=fetched.get(u.remote!)!,parent=u.parentId?unit(u.parentId):undefined;
        const ours=!u.parentId?null:seen(parent)?parent.remote!:undefined;
        // Parents outside the A/O are not opsmap's.
        const named=(t.parents??(t.parent!==null?[t.parent]:[])).filter(x=>units.has(x)),theirs=named.length===0?null:named.length===1?named[0]:undefined;
        const agreed=base.parents[u.id];
        if(ours===undefined||theirs===undefined){if(agreed!==undefined)parents[u.id]=agreed;continue;}
        if(ours===theirs){parents[u.id]=ours;continue;}
        const newer=Date.parse(u.updatedAt)>=Date.parse(t.updatedAt)?'ours':'theirs';
        const take=agreed!==undefined?(ours===agreed?'theirs':theirs===agreed?'ours':newer):(ours===null)!==(theirs===null)?(ours===null?'theirs':'ours'):newer;
        // A task kept only under its parent goes back into its unit's sector's container when it is detached.
        const container=ours===null&&t.container===null&&p.capabilities.fields.has('container')?doc().sectors.find(s=>s.id===u.sectorId)?.remote:undefined;
        if(take==='ours'){await guard(u.designation,async()=>{await session.updateTask(root,{...t,parent:named[0]??null,parents:named},{parent:ours,...(container!==undefined?{container}:{})},tz);parents[u.id]=ours;stats.pushed++;});continue;}
        const key=theirs===null?undefined:parentKey(u.id,theirs);
        try{this.system(mapId,p,{action:'pull',unit:u.id,changes:{parentId:theirs===null?null:units.get(theirs)!.id}});parents[u.id]=theirs;stats.pulled++;}
        catch(error){
          // Left as it is in the service; the agreed parent stays (opsmap's, when none was agreed yet), so the next cycle
          // tries the service's again instead of pushing opsmap's over it.
          parents[u.id]=agreed!==undefined?agreed:ours;
          if(key===undefined)await guard(u.designation,async()=>{throw error;});
          else{stillRefusedParents.add(key);if(!refusedParents.has(key))await guard(u.designation,async()=>{throw error;});}
        }
      }
    }else Object.assign(parents,base.parents);
    const live=new Set(doc().units.map(u=>u.id));
    for(const [id,task] of Object.entries(base.parents))if(!(id in parents)&&live.has(id)&&!seen(unit(id)))parents[id]=task;
    // Link orders ↔ the relations the provider has, between open units only: /done ends a unit's orders, but its task
    // keeps its relations.
    const kinds=p.capabilities.relations;
    if(!kinds.size||!session.relate){this.tables.setRelations(mapId,{parents,edges:base.edges,refused:[...base.refused.filter(k=>!isParentKey(k)),...stillRefusedParents]});return;}
    const relate=session.relate.bind(session);
    const units=byTask(),open=(u:Unit|undefined):u is Unit=>seen(u)&&u.lifecycle!=='done'&&u.lifecycle!=='dropped';
    const ours=new Map<string,Order[]>();
    for(const o of doc().orders) {
      const kind=o.kind??'link';
      if(o.type!=='link'||!kinds.has(kind)||!open(unit(o.from))||!open(unit(o.to)))continue;
      const key=edgeKey(kind,o.from,o.to);ours.set(key,[...ours.get(key)??[],o]);
    }
    const theirs=new Map<string,{ kind:RelationKind; from:string; to:string }>();
    for(const [id,t] of fetched) {
      const u=units.get(id);if(!open(u))continue;
      for(const r of t.relations??[]){const other=units.get(r.to);if(kinds.has(r.kind)&&open(other)&&other.id!==u.id)theirs.set(edgeKey(r.kind,u.id,other.id),{kind:r.kind,from:u.id,to:other.id});}
    }
    const agreed=new Set(base.edges),refused=new Set(base.refused.filter(k=>!isParentKey(k))),edges=new Set<string>(),stillRefused=new Set<string>();
    for(const key of new Set([...ours.keys(),...theirs.keys()])) {
      const mine=ours.get(key),remote=theirs.get(key);
      if(mine&&remote){edges.add(key);continue;}
      const [kind,from,to]=JSON.parse(key) as [RelationKind,string,string];
      const a=unit(from)!,b=unit(to)!,what=`${a.designation} / ${b.designation}`;
      if(mine) {
        // Removed remotely: the link order goes. New in opsmap: the relation is made.
        await guard(what,async()=>{
          if(agreed.has(key)){for(const o of mine)this.system(mapId,p,{action:'unrelate',order:o.id});stats.pulled++;return;}
          await relate(root,a.remote!,b.remote!,kind,true);edges.add(key);stats.pushed++;
        });
      }else if(agreed.has(key)) {
        await guard(what,async()=>{await relate(root,a.remote!,b.remote!,kind,false);stats.pushed++;});
      }else if(refused.has(key))stillRefused.add(key);
      else {
        // New remotely: a link order. A plain link has no direction, so the other way round is tried too.
        const ends=kind==='link'?[[remote!.from,remote!.to],[remote!.to,remote!.from]]:[[remote!.from,remote!.to]];
        let error:unknown;
        for(const [x,y] of ends){try{this.system(mapId,p,{action:'relate',unit:x,target:y,...(kind==='link'?{}:{kind})});edges.add(key);stats.pulled++;error=undefined;break;}catch(e){error=e;}}
        if(error!==undefined){stillRefused.add(key);await guard(`relation ${what}`,async()=>{throw error;});}
      }
    }
    this.tables.setRelations(mapId,{parents,edges:[...edges],refused:[...stillRefused,...stillRefusedParents]});
  }
}
