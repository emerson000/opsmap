// An in-memory task service for tests and the e2e server (registered only when NODE_ENV=test and
// OPSMAP_FAKE_PROVIDER=1). Roots hold containers; tasks sit in a container or under a parent task. Tokens are
// `fake-‹user name›`. `calls` records every session call, `failNext` makes the next call of a method throw, and
// `tick` moves the clock that stamps `updatedAt`. The remote* methods change things as a user of the service would.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Affiliation } from '../../../src/core/model/types';
import { RemoteAuthError, type Capabilities, type FieldKey, type ProviderDescriptor, type ProviderFactory, type ProviderSession, type RelationKind, type RemoteContainer, type RemoteRoot, type RemoteTask, type Snapshot, type TaskProvider, type TaskWrite, type WebhookResult } from '../../tasksync/contract';

export interface FakeOptions { id?:string; label?:string; aliases?:string[]; fields?:FieldKey[]; relations?:RelationKind[]; webhooks?:Capabilities['webhooks'] }
const ALL_FIELDS:FieldKey[]=['title','due','note','progress','status','container','affiliation','parent'];
type Stored=RemoteTask&{ root:string; deleted?:boolean };

export class FakeProvider implements TaskProvider {
  readonly descriptor:ProviderDescriptor;
  readonly capabilities:Capabilities;
  readonly calls:{ method:string; args:unknown[] }[]=[];
  readonly roots=new Map<string,RemoteRoot>();
  readonly containers=new Map<string,RemoteContainer&{ root:string }>();
  readonly tasks=new Map<string,Stored>();
  private readonly failures=new Map<string,Error[]>();
  private clock=Date.parse('2026-11-01T12:00:00Z');
  private next=1;
  constructor(options:FakeOptions={}) {
    const id=options.id??'fake',label=options.label??'Fake';
    this.descriptor={id,label,aliases:options.aliases??(id==='fake'?['fk']:[]),rootNoun:'project',containerNoun:'section',tokenHelp:`Paste a ${label} token: fake-‹your name›.`,
      urls:{root:`http://${id}.invalid/{root}`,container:`http://${id}.invalid/{root}/{container}`,task:`http://${id}.invalid/{root}/task/{id}`}};
    this.capabilities={fields:new Set(options.fields??ALL_FIELDS),relations:new Set(options.relations??['link','dependency','handoff']),maxTitle:250,maxNote:10000,
      webhooks:options.webhooks??{https:false,publicAddress:false},pollMs:60_000,idlePollMs:300_000};
  }
  /** The next call of `method` (verify or a session method) throws `error`. */
  failNext(method:string,error:Error):void {const list=this.failures.get(method)??[];list.push(error);this.failures.set(method,list);}
  tick(ms=1000):string {this.clock+=ms;return this.now();}
  now():string {return new Date(this.clock).toISOString();}
  private id(prefix:string):string {return `${prefix}${this.next++}`;}
  private record(method:string,args:unknown[]):void {this.calls.push({method,args});const error=this.failures.get(method)?.shift();if(error)throw error;}
  private user(token:string):string|undefined {return /^fake-[a-z0-9]+$/i.test(token)?token.slice(5):undefined;}

  async verify(token:string):Promise<{ username:string }> {
    this.record('verify',[]);
    const username=this.user(token);if(!username)throw new RemoteAuthError(`${this.descriptor.label} refused the token`);
    return {username};
  }
  connect(token:string):ProviderSession {
    const call=async<T>(method:string,args:unknown[],run:()=>T):Promise<T>=>{
      this.record(method,args);
      if(!this.user(token))throw new RemoteAuthError(`${this.descriptor.label} refused the token`);
      return structuredClone(run());
    };
    const has=(f:FieldKey)=>this.capabilities.fields.has(f);
    return {
      resolveRoot:nameOrUrl=>call('resolveRoot',[nameOrUrl],()=>{
        const key=nameOrUrl.trim(),found=this.roots.get(key)??[...this.roots.values()].filter(r=>r.title.toLowerCase()===key.toLowerCase());
        if(!Array.isArray(found))return found;
        if(found.length>1)throw new Error(`Several ${this.descriptor.label} projects named ${key}: ${found.map(r=>r.id).join(', ')}`);
        return found[0]??this.remoteRoot(key);
      }),
      ensureContainers:(root,names,known)=>call('ensureContainers',[root.id,names,known],()=>{
        const out:Record<string,string>={};
        for(const {sectorId,name} of names) {
          const mine=(id:string|undefined)=>id!==undefined&&this.containers.get(id)?.root===root.id?id:undefined;
          out[sectorId]=mine(known[sectorId])??[...this.containers.values()].find(c=>c.root===root.id&&c.name.toLowerCase()===name.toLowerCase())?.id??this.remoteContainer(root.id,name).id;
        }
        return out;
      }),
      renameContainer:(root,id,name)=>call('renameContainer',[root.id,id,name],()=>{const c=this.containers.get(id);if(c?.root===root.id)c.name=name;}),
      snapshot:(root,containers,_tz)=>call('snapshot',[root.id,containers],():Snapshot=>{
        const matched=new Set(Object.values(containers)),live=[...this.tasks.values()].filter(t=>t.root===root.id&&!t.deleted);
        const tasks=live.filter(t=>t.parent!==null||t.container!==null&&matched.has(t.container)).map(t=>this.view(t));
        const unmatched=[...this.containers.values()].filter(c=>c.root===root.id&&!matched.has(c.id)).map(c=>({container:{id:c.id,name:c.name},open:live.filter(t=>t.container===c.id&&t.status!=='done').length})).filter(u=>u.open>0);
        return {tasks,unmatched};
      }),
      getTask:(root,id,_tz)=>call('getTask',[root.id,id],()=>{const t=this.tasks.get(id);return t&&!t.deleted&&t.root===root.id?this.view(t):null;}),
      createTask:(root,fields,_tz)=>call('createTask',[root.id,fields],()=>{
        const t:Stored={id:this.id('T'),root:root.id,title:fields.title.slice(0,this.capabilities.maxTitle),note:'',due:null,status:null,progress:null,container:fields.container,parent:null,affiliations:[],updatedAt:this.now()};
        this.write(t,fields);if(!has('parent'))t.parent=null;
        this.tasks.set(t.id,t);return this.view(t);
      }),
      updateTask:(root,current,changes,_tz)=>call('updateTask',[root.id,current.id,changes],()=>{
        const t=this.tasks.get(current.id);if(!t||t.deleted||t.root!==root.id)throw new Error(`No ${this.descriptor.label} task ${current.id}`);
        this.write(t,changes);t.updatedAt=this.now();return this.view(t);
      }),
      deleteTask:(root,id)=>call('deleteTask',[root.id,id],()=>{const t=this.tasks.get(id);if(t?.root===root.id)this.tasks.delete(id);}),
      ...(this.capabilities.relations.size?{relate:(root:RemoteRoot,from:string,to:string,kind:RelationKind,add:boolean)=>call('relate',[root.id,from,to,kind,add],()=>{
        const t=this.tasks.get(from);if(!t)return;const rest=(t.relations??[]).filter(r=>!(r.kind===kind&&r.to===to));t.relations=add?[...rest,{kind,to}]:rest;
      })}:{}),
      ensureWebhooks:(root,containers,target,secret,_state,force)=>call('ensureWebhooks',[root.id,containers,target,force],()=>({hooks:containers.length,target,secret:secret.length})),
      removeWebhooks:(root,state)=>call('removeWebhooks',[root.id,state],()=>undefined),
    };
  }
  /** Signed like Vikunja: HMAC-SHA256 of the body, hex, in X-Fake-Signature. */
  receiveWebhook(headers:Headers,body:string,secret:string,_state:unknown):WebhookResult {
    const got=Buffer.from((headers.get('x-fake-signature')??'').trim().toLowerCase()),want=Buffer.from(createHmac('sha256',secret).update(body).digest('hex'));
    return got.length===want.length&&timingSafeEqual(got,want)?{status:200,trigger:true}:{status:401,trigger:false};
  }

  /** Apply the declared fields of a write; an undeclared one is ignored. Null affiliation clears the identity. */
  private write(t:Stored,w:TaskWrite):void {
    const has=(f:FieldKey)=>this.capabilities.fields.has(f);
    if(w.title!==undefined&&has('title'))t.title=w.title.slice(0,this.capabilities.maxTitle);
    if(w.note!==undefined&&has('note'))t.note=w.note.slice(0,this.capabilities.maxNote);
    if(w.due!==undefined&&has('due'))t.due=w.due;
    if(w.status!==undefined&&has('status'))t.status=w.status;
    if(w.progress!==undefined&&has('progress'))t.progress=w.progress;
    if(w.parent!==undefined&&has('parent')){t.parent=w.parent;if(w.parent!==null)t.container=null;}
    if(w.container!==undefined&&has('container')&&t.parent===null)t.container=w.container;
    if(w.affiliation!==undefined&&has('affiliation'))t.affiliations=w.affiliation===null?[]:[w.affiliation];
  }
  private view(t:Stored):RemoteTask {const {root:_root,deleted:_deleted,...task}=t;return structuredClone(task);}

  // ---- changes made in the service itself ----
  remoteRoot(title:string):RemoteRoot {const r={id:this.id('P'),title};this.roots.set(r.id,r);return {...r};}
  remoteContainer(root:string,name:string,archived?:boolean):RemoteContainer {const c={id:this.id('C'),name,...(archived?{archived}:{})};this.containers.set(c.id,{...c,root});return c;}
  remoteCreate(root:string,fields:Partial<Omit<RemoteTask,'id'|'updatedAt'>>&{ title:string },affiliation?:Affiliation):RemoteTask {
    const t:Stored={note:'',due:null,status:null,progress:null,container:null,parent:null,affiliations:affiliation?[affiliation]:[],...fields,id:this.id('T'),root,updatedAt:this.tick()};
    this.tasks.set(t.id,t);return this.view(t);
  }
  remoteUpdate(id:string,changes:Partial<Omit<RemoteTask,'id'|'updatedAt'>>):RemoteTask {const t=this.tasks.get(id)!;Object.assign(t,changes,{updatedAt:this.tick()});return this.view(t);}
  remoteDelete(id:string):void {const t=this.tasks.get(id);if(t)t.deleted=true;}
}
export const fakeProvider:ProviderFactory=env=>env.NODE_ENV==='test'&&env.OPSMAP_FAKE_PROVIDER==='1'?new FakeProvider():undefined;
