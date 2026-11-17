// The task provider contract: what a task service adapter (server/providers/*) gives the task sync, and the
// neutral shapes both sides use. The sync never asks which provider it is talking to; it reads `capabilities`.
import type { Affiliation } from '../../src/core/model/types';
export type FieldKey='title'|'due'|'note'|'progress'|'status'|'container'|'affiliation'|'parent';
export type RemoteStatus='todo'|'active'|'blocked'|'done';
export type RelationKind='link'|'dependency'|'handoff';
export interface ProviderDescriptor { id:string; label:string; aliases:string[]; rootNoun:string; containerNoun:string; tokenHelp:string; tokenUrl?:string;
  urls:{ root:string; container?:string; task:string } /* templates with {root} {container} {id} */ }
export interface Capabilities { fields:ReadonlySet<FieldKey>; relations:ReadonlySet<RelationKind>; maxTitle:number; maxNote:number;
  webhooks:false|{ https:boolean; publicAddress:boolean; handshakeTimeoutMs?:number }  /* D19 requirements; false = provider has none */;
  pollMs:number; idlePollMs:number; webhookHint?:string /* shown in status when deliveries do not arrive */ }
export type DeliveryMode='off'|'pending'|'live'|'failed';
export interface Delivery { mode:DeliveryMode; reason:string /* user-facing, e.g. "webhooks off: ‹Label› needs a public HTTPS address; PUBLIC_URL is a private address (100.x)" */; nextPollMs:number; lastDelivery?:string; retryAt?:string }
export interface RemoteRoot { id:string; title:string }
export interface RemoteContainer { id:string; name:string; archived?:boolean }
export interface RemoteTask { id:string; title:string; note:string; due:string|null /* YYYY-MM-DD in the map zone */; status:RemoteStatus|null /* null: a state opsmap does not track */;
  progress:number|null; container:string|null; parent:string|null; affiliations:Affiliation[] /* identity tags/labels found, possibly several */; updatedAt:string;
  relations?:{ kind:RelationKind; to:string }[] /* from this task's side: link, this task depends on `to`, this task hands off to `to` */;
  dueAt?:string|null /* the due instant (ISO), when the service keeps a time of day */;
  parents?:string[] /* every parent task, when the service allows several; `parent` is then the first */ }
export interface Snapshot { tasks:RemoteTask[]; unmatched:{ container:RemoteContainer; open:number }[] }
export type TaskWrite=Partial<Pick<RemoteTask,'title'|'note'|'due'|'dueAt'|'status'|'progress'|'container'|'parent'>>&{ affiliation?:Affiliation|null /* null: remove the identity tags or labels opsmap manages */ };
export interface WebhookResult { status:number; headers?:Record<string,string>; store?:unknown; trigger:boolean; /** A signed delivery that starts no cycle (a heartbeat) but shows the webhooks work: counts as live. `trigger` implies it. */ live?:boolean }
export class RateLimited extends Error { constructor(readonly retryAfterS:number){ super(`rate limited, retrying in ${retryAfterS}s`); } }
export class RemoteAuthError extends Error {}

/** One user's authenticated connection. Every method may throw RateLimited or RemoteAuthError. */
export interface ProviderSession {
  resolveRoot(nameOrUrl:string):Promise<RemoteRoot>;                       // find or create; throws Error with user-facing text when ambiguous
  ensureContainers(root:RemoteRoot, names:{ sectorId:string; name:string }[], known:Record<string,string>):Promise<Record<string,string>>; // sectorId → container id
  renameContainer(root:RemoteRoot, id:string, name:string):Promise<void>;
  snapshot(root:RemoteRoot, containers:Record<string,string>, tz:string):Promise<Snapshot>;
  getTask(root:RemoteRoot, id:string, tz:string):Promise<RemoteTask|null>; // null = deleted or no longer visible
  createTask(root:RemoteRoot, fields:TaskWrite&{ title:string; container:string }, tz:string):Promise<RemoteTask>;
  updateTask(root:RemoteRoot, current:RemoteTask, changes:TaskWrite, tz:string):Promise<RemoteTask>; // a parent change replaces current.parents
  deleteTask?(root:RemoteRoot, id:string):Promise<void>;                     // takes back a task made for a unit that was undone meanwhile
  relate?(root:RemoteRoot, from:string, to:string, kind:RelationKind, add:boolean):Promise<void>;
  ensureWebhooks?(root:RemoteRoot, containers:string[], target:string, secret:string, state:unknown, force:boolean):Promise<unknown /* new state */>;
  removeWebhooks?(root:RemoteRoot, state:unknown):Promise<void>;
}
export interface TaskProvider {
  descriptor:ProviderDescriptor; capabilities:Capabilities;
  verify(token:string):Promise<{ username:string }>;                        // RemoteAuthError when refused
  connect(token:string):ProviderSession;
  receiveWebhook?(headers:Headers, body:string, secret:string, state:unknown):WebhookResult;
  hookCount?(hooks:unknown):number;                                          // webhooks in ensureWebhooks' state, for status; else one per container
}
export type ProviderFactory=(env:NodeJS.ProcessEnv)=>TaskProvider|undefined;
