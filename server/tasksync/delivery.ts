// How a bound map learns about remote changes (D18–D20). Polling always runs; webhooks only bring a cycle forward.
// The mode is worked out from the configuration, PUBLIC_URL's reachability, the provider's requirements and what
// has been delivered: off (no webhooks), pending (registered, nothing delivered yet), live (a signed delivery in the
// last 15 minutes) or failed (refused, or no handshake in time; retried with backoff). Pure functions of their input.
import type { Capabilities, Delivery, RemoteRoot } from './contract';
import type { Reachability } from './reachability';
export type WebhookSetting='auto'|'on'|'off';
/** The engine's webhook bookkeeping for one map (ts_maps.delivery). */
export interface DeliveryRecord { containers?:string[]; registeredAt?:string; handshakeAt?:string; failure?:{ reason:string; count:number; retryAt:string }; /** Failures in a row, for the backoff. */ failures?:number; root?:RemoteRoot }
export const LIVE_MS=15*60_000, CHECK_MS=10*60_000, MAX_BACKOFF_MS=6*3_600_000, MIN_POLL_MS=15_000, NUDGE_DELAY_MS=1000, NUDGE_EVERY_MS=20_000, REACH_MS=3_600_000;
/** TASKSYNC_POLL_SECONDS as milliseconds (at least 15 s), or undefined when unset or not a number. */
export function pollOverride(env:NodeJS.ProcessEnv):number|undefined {
  const raw=env.TASKSYNC_POLL_SECONDS,n=Number(raw);
  return raw&&Number.isFinite(n)&&n>0?Math.max(MIN_POLL_MS,Math.round(n*1000)):undefined;
}
/** TASKSYNC_WEBHOOKS: auto (default), on or off. */
export function webhookSetting(value:string|undefined):WebhookSetting {
  if(value===undefined||value==='')return 'auto';
  if(value!=='auto'&&value!=='on'&&value!=='off')throw new Error('TASKSYNC_WEBHOOKS must be auto, on or off');
  return value;
}
export function pollIntervals(caps:Capabilities,override?:number):{ pollMs:number; idlePollMs:number } {
  const pollMs=override!==undefined?Math.max(MIN_POLL_MS,override):caps.pollMs;
  return {pollMs,idlePollMs:Math.max(caps.idlePollMs,pollMs)};
}
/** Why this map gets no webhooks, or undefined when it may have them, with a plain sentence for the sidebar's summary
 *  (the reason stays technical: it is the status text and the summary's tooltip). `reach` is undefined until
 *  PUBLIC_URL is checked. */
export function webhooksBlockedWhy(setting:WebhookSetting,publicUrl:string|undefined,reach:Reachability|undefined,caps:Capabilities,label:string):{ reason:string; note:string }|undefined {
  if(setting==='off')return {reason:'webhooks are off (TASKSYNC_WEBHOOKS=off)',note:'Instant updates are turned off on this server.'};
  if(!caps.webhooks)return {reason:`${label} has no webhooks`,note:`${label} does not send instant updates.`};
  const unreachable=`webhooks need PUBLIC_URL to be an address ${label} can reach`,reachable=`Instant updates need an address ${label} can reach.`;
  if(!publicUrl)return {reason:unreachable,note:'Instant updates need a public address for this server.'};
  if(setting==='on')return undefined;
  if(!reach)return {reason:'PUBLIC_URL is not checked yet',note:'Checking whether instant updates can work.'};
  if(reach.loopback)return {reason:unreachable,note:reachable};
  const needs=`${label} needs a public${caps.webhooks.https?' HTTPS':''} address`;
  if(caps.webhooks.publicAddress&&!reach.publicAddress)return {reason:`${reach.reason??'PUBLIC_URL is not public'}: ${needs}`,note:`Instant updates need a public${caps.webhooks.https?' HTTPS':''} address.`};
  if(caps.webhooks.https&&!reach.https)return {reason:`PUBLIC_URL is not HTTPS: ${needs}`,note:'Instant updates need an HTTPS address.'};
  return undefined;
}
export const webhooksBlocked=(setting:WebhookSetting,publicUrl:string|undefined,reach:Reachability|undefined,caps:Capabilities,label:string):string|undefined=>webhooksBlockedWhy(setting,publicUrl,reach,caps,label)?.reason;
/** Registered, but the provider's handshake did not come within its timeout. */
export function handshakeMissing(caps:Capabilities,rec:DeliveryRecord,now:number):boolean {
  const timeout=caps.webhooks?caps.webhooks.handshakeTimeoutMs:undefined;
  if(!timeout||!rec.registeredAt)return false;
  if(rec.handshakeAt&&Date.parse(rec.handshakeAt)>=Date.parse(rec.registeredAt))return false;
  return now-Date.parse(rec.registeredAt)>timeout;
}
export const handshakeReason=(caps:Capabilities,label:string)=>`no handshake from ${label} within ${Math.round((caps.webhooks?caps.webhooks.handshakeTimeoutMs??0:0)/1000)} s`;
/** 10 minutes after the first failure, doubling after each one, at most 6 hours. */
export const retryDelay=(count:number)=>Math.min(CHECK_MS*2**Math.max(0,count-1),MAX_BACKOFF_MS);
/** Whether the webhooks are due a check against the provider. */
export function checkDue(rec:DeliveryRecord,checkedAt:string|null|undefined,containers:string[],now:number,force:boolean):boolean {
  if(rec.failure)return force||now>=Date.parse(rec.failure.retryAt);
  const same=[...rec.containers??[]].sort().join()===[...containers].sort().join();
  return force||!checkedAt||now-Date.parse(checkedAt)>=CHECK_MS||!same;
}
export interface DeliveryInput { blocked?:string; caps:Capabilities; label:string; rec:DeliveryRecord; /** The last webhook check. */ checkedAt?:string|null; lastDelivery?:string|null; now:number; pollMs:number; idlePollMs:number; count:number }
export function deliveryMode(i:DeliveryInput):Delivery {
  const last=i.lastDelivery??undefined,lastDelivery=last?{lastDelivery:last}:{};
  if(i.blocked)return {mode:'off',reason:i.blocked,nextPollMs:i.pollMs};
  if(i.rec.failure)return {mode:'failed',reason:i.rec.failure.reason,nextPollMs:i.pollMs,retryAt:i.rec.failure.retryAt,...lastDelivery};
  // Not recorded yet: the next cycle records it, and the check after that (10 minutes on) registers again.
  if(handshakeMissing(i.caps,i.rec,i.now))return {mode:'failed',reason:handshakeReason(i.caps,i.label),nextPollMs:i.pollMs,retryAt:new Date(Math.max(i.now,Date.parse(i.checkedAt??i.rec.registeredAt!))+CHECK_MS).toISOString(),...lastDelivery};
  if(last&&i.now-Date.parse(last)<LIVE_MS)return {mode:'live',reason:`${i.label} delivers changes`,nextPollMs:i.idlePollMs,...lastDelivery};
  return {mode:'pending',reason:i.count?`${i.count} webhooks registered, none delivered in the last 15 minutes`:'no webhooks yet',nextPollMs:i.pollMs,...lastDelivery};
}
const clock=(iso:string)=>new Date(iso).toISOString().slice(11,19)+'Z';
/** "minute", "5 minutes", "15 seconds". */
export const every=(ms:number)=>ms===60_000?'minute':ms%60_000===0?`${ms/60_000} minutes`:`${Math.round(ms/1000)} seconds`;
/** The webhook part of /tasks status. */
export function deliveryStatus(d:Delivery,count:number,hint?:string):string {
  const polling=`polling every ${every(d.nextPollMs)}`;
  if(d.mode==='off')return `${polling} (${d.reason})`;
  if(d.mode==='failed')return `webhooks failed: ${d.reason}${d.retryAt?`, retrying at ${clock(d.retryAt)}`:''} · ${polling}`;
  if(d.mode==='live')return `${count} webhooks · last delivery ${clock(d.lastDelivery!)}`;
  if(!count)return `no webhooks yet (next sync registers them), ${polling}`;
  if(d.lastDelivery)return `${count} webhooks · last delivery ${clock(d.lastDelivery)} · ${polling}`;
  return `${count} webhooks, none delivered yet${hint?`: ${hint}`:''} · ${polling}`;
}
/** The delivery mode as the sidebar shows it: one line, with the full reason for its tooltip. */
export interface DeliverySummary { mode:Delivery['mode']; summary:string; reason:string }
/** "1 min", "2 min", "15 s". */
export const shortEvery=(ms:number)=>ms%60_000===0?`${ms/60_000} min`:`${Math.round(ms/1000)} s`;
/** "Live updates", "Checking every 2 min.", "Checking every 2 min. Instant updates need a public HTTPS address." `count`:
 *  webhooks registered; `note`: why webhooks are off, in plain words. */
export function deliverySummary(d:Delivery,count:number,note?:string):DeliverySummary {
  const checking=`Checking every ${shortEvery(d.nextPollMs)}.`;
  const why=d.mode==='off'?note:d.mode==='failed'?'Instant updates failed; trying again later.':d.mode==='pending'&&count?'Waiting for the first instant update.':undefined;
  return {mode:d.mode,summary:d.mode==='live'?'Live updates':why?`${checking} ${why}`:checking,reason:d.reason};
}
