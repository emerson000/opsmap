import { randomBytes } from 'node:crypto';
import { Hub, type Op } from './hub';
import { DEFAULT_MAP, type MapInfo, type Store } from './db';
import { importJson } from '../src/core/model/json';
import { zonedDay } from './scheduler';
import { DEFAULT_TZ } from '../src/core/model/time';
import { resolveMap } from '../src/core/commands/resolve';

export const MAX_MAPS=50, MAX_MAP_NAME=60;
export type MapEvent={kind:'op';mapId:string;op:Op}|{kind:'maps';maps:MapInfo[];deleted?:string};

/** Normalizes a map name: trimmed, single spaces, 1..60 printable characters. */
export function mapName(value:unknown):string {
  if(typeof value!=='string')throw new Error('Map name required');
  const name=value.replace(/\s+/g,' ').trim();
  if(!name)throw new Error('Map name required');
  if(name.length>MAX_MAP_NAME)throw new Error(`Map name exceeds ${MAX_MAP_NAME} characters`);
  if(/[\u0000-\u001f\u007f]/.test(name))throw new Error('Map name contains control characters');
  return name;
}

/** Every map's hub, loaded at start. Maps are listed in creation order; the first one is the default. */
export class Maps {
  readonly hubs=new Map<string,Hub>();
  readonly listeners=new Set<(event:MapEvent)=>void>();
  constructor(readonly store:Store,readonly tz:string=DEFAULT_TZ) {
    for(const info of store.maps())this.attach(new Hub(store,info.id,tz));
  }
  private attach(hub:Hub):Hub {
    hub.listeners.add(op=>this.emit({kind:'op',mapId:hub.mapId,op}));
    this.hubs.set(hub.mapId,hub);return hub;
  }
  private emit(event:MapEvent) {for(const listener of this.listeners)listener(event);}
  list():MapInfo[] {return this.store.maps();}
  get default():Hub {return this.hubs.get(this.list()[0]?.id??DEFAULT_MAP)!;}
  get(id:string):Hub|undefined {return this.hubs.get(id);}
  /** A map by id, or by name ignoring case. Without a reference, the default map. */
  resolve(ref?:string):Hub {
    if(ref===undefined||ref==='')return this.default;
    return this.hubs.get(resolveMap(ref,this.list()).id)!;
  }
  /** `base`, or `base 2`, `base 3`… when a map already has that name (as the map switcher names a duplicate). */
  uniqueName(base:string):string {
    const taken=new Set(this.list().map(m=>m.name.toLowerCase()));
    if(!taken.has(base.toLowerCase()))return base;
    for(let n=2;;n++)if(!taken.has(`${base} ${n}`.toLowerCase()))return `${base} ${n}`;
  }
  private assertUnique(name:string,except?:string) {
    if(this.list().some(m=>m.id!==except&&m.name.toLowerCase()===name.toLowerCase()))throw new Error(`A map named ${name} already exists`);
  }
  /** Creates an empty map (five standard sectors) or one that starts from an imported document. */
  create(userId:string,rawName:unknown,doc?:unknown,now=new Date(),source:Op['source']='web',agent?:{id:string;name:string}):MapInfo {
    const name=mapName(rawName);this.assertUnique(name);
    const maps=this.list();if(maps.length>=MAX_MAPS)throw new Error(`At most ${MAX_MAPS} maps`);
    const validated=doc===undefined?undefined:importJson(JSON.stringify(doc));
    let id:string;do id=randomBytes(6).toString('base64url');while(this.hubs.has(id));
    const info:MapInfo={id,name,createdAt:now.toISOString(),createdBy:userId,position:Math.max(0,...maps.map(m=>m.position))+1};
    this.store.insertMap(info);
    // A new map takes its first morning turn tomorrow, not on the next scheduler tick.
    this.store.setLastTurn(id,zonedDay(now,this.tz).day);
    const hub=this.attach(new Hub(this.store,id,this.tz));
    if(validated){try{hub.import(userId,validated,now,source,agent);}catch(error){this.hubs.delete(id);this.store.deleteMap(id);throw error;}}
    this.emit({kind:'maps',maps:this.list()});
    return info;
  }
  rename(id:string,rawName:unknown):MapInfo {
    if(!this.hubs.has(id))throw new Error('Unknown map');
    const name=mapName(rawName);this.assertUnique(name,id);
    this.store.renameMap(id,name);this.emit({kind:'maps',maps:this.list()});
    return this.store.map(id)!;
  }
  remove(id:string) {
    if(!this.hubs.has(id))throw new Error('Unknown map');
    if(this.hubs.size<=1)throw new Error('The last map cannot be deleted');
    this.store.deleteMap(id);this.hubs.get(id)!.listeners.clear();this.hubs.delete(id);
    this.emit({kind:'maps',maps:this.list(),deleted:id});
  }
  snapshot() {for(const hub of this.hubs.values())hub.snapshot();}
}
