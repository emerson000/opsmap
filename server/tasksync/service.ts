// What the HTTP routes, the WebSocket and MCP need from the task sync. They depend on this interface only, never on
// a provider: the sync service picks the provider from the map's binding (or the bind request's `provider`).
import type { User } from '../db';
import type { Op } from '../hub';
import type { WebhookResult } from './contract';
import type { DeliverySummary } from './delivery';
export interface SyncService {
  /** /tasks bind, sync, status on a map: the log line to show, or throws with the user-facing reason. */
  request(mapId:string,args:Record<string,unknown>,user:User,source:Op['source']):Promise<string>;
  /** A delivery to POST /api/tasksync/:provider/hook/:map. */
  webhook(provider:string,mapId:string,headers:Headers,body:string):WebhookResult;
  /** Someone is looking at the map: pull soon when webhooks are not live. */
  nudge(mapId:string):void;
  /** How the map learns of remote changes, in one line for the sidebar; undefined when the map is not bound. */
  deliveryInfo?(mapId:string):Promise<DeliverySummary|undefined>;
  start():void;
  stop():Promise<void>;
}
