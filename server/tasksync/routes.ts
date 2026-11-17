// The task sync's HTTP edges, the same for every provider: the signed-in user's account per service (whether a token
// is set, never the token), and webhook deliveries, which are server to server and checked by the sync service.
import type { Context, Hono } from 'hono';
import type { Auth } from '../auth';
import type { User } from '../db';
import { originAllowed, warnOrigin, type Config } from '../config';
import { Bucket, boundedText } from '../limit';
import { TASK_REQUESTS } from '../../src/core/commands/apply';
import type { Credentials } from './credentials';
import type { ProviderRegistry } from './registry';
import type { SyncService } from './service';
export interface TaskSyncDeps { config:Config; auth:Auth; registry:ProviderRegistry; credentials?:Credentials; sync?:SyncService; legacyRoutes?:{ provider:string; hook:string }[] }

/** A /tasks request from the browser (bind, sync, status), checked as MCP's parse would leave it. */
export function taskRequestArgs(args:unknown,registry:ProviderRegistry):Record<string,unknown> {
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Invalid /tasks request');
  const a=args as Record<string,unknown>;
  if(!(TASK_REQUESTS as readonly string[]).includes(String(a.action)))throw new Error('Invalid /tasks request');
  if(a.provider!==undefined&&(typeof a.provider!=='string'||!registry.get(a.provider)))throw new Error(`Unknown task service: ${String(a.provider).slice(0,64)}`);
  return {action:a.action,...(typeof a.provider==='string'?{provider:a.provider}:{}),...(typeof a.name==='string'?{name:a.name.slice(0,250)}:{}),...(Array.isArray(a.off)?{off:a.off.slice(0,8)}:{})};
}

export function taskSyncRoutes(app:Hono,{config,auth,registry,credentials,sync,legacyRoutes=[]}:TaskSyncDeps):void {
  const known=(c:Context)=>{const id=c.req.param('provider')??'';return registry.get(id)&&credentials?id:undefined;};
  const unknown=(c:Context)=>c.json({error:`Unknown task service: ${(c.req.param('provider')??'').slice(0,64)}`},404);
  app.get('/api/tasksync/:provider/account',c=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    const provider=known(c);if(!provider)return unknown(c);
    return c.json({provider,...credentials!.account(user.id,provider)});
  });
  const accountWrite=async(c:Context,run:(user:User,provider:string,body:Record<string,unknown>)=>Promise<object>)=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    const provider=known(c);if(!provider)return unknown(c);
    if(!originAllowed(config,c.req.header('origin'))){warnOrigin(config,c.req.header('origin'),'a task service account change');return c.json({error:'Invalid origin'},403);}
    try {
      const text=await boundedText(c.req.raw,8*1024),body=text?JSON.parse(text):{};
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid request');
      return c.json({ok:true,provider,...await run(user,provider,body)});
    }catch(error){return c.json({error:error instanceof Error?error.message:'Invalid request'},400);}
  };
  app.put('/api/tasksync/:provider/account',c=>accountWrite(c,(user,provider,body)=>credentials!.save(user.id,provider,body.token)));
  app.delete('/api/tasksync/:provider/account',c=>accountWrite(c,async(user,provider)=>{credentials!.remove(user.id,provider);return {connected:false};}));
  // Webhooks: authenticated by the provider's signature with the per-map secret, not by a session. Anyone can post, so
  // each map gets a bucket (a burst of 60, refilled at 5 a second), and so does each client address (200, 20 a second).
  const buckets=new Map<string,{ bucket:Bucket; at:number }>();let swept=Date.now();
  const allowed=(key:string,rate:number,burst:number)=>{
    const now=Date.now();
    if(now-swept>60_000||buckets.size>10_000){swept=now;for(const [k,v] of buckets)if(now-v.at>60_000)buckets.delete(k);}
    let b=buckets.get(key);if(!b){b={bucket:new Bucket(rate,burst),at:now};buckets.set(key,b);}
    b.at=now;return b.bucket.take();
  };
  const hook=async(c:Context,provider:string)=>{
    if(!sync||!registry.get(provider))return c.json({error:'Not found'},404);
    const map=(c.req.param('map')??'').slice(0,128),ip=(c.env as { incoming?:{ socket?:{ remoteAddress?:string } } }|undefined)?.incoming?.socket?.remoteAddress;
    if(ip&&!allowed(`ip ${ip}`,20,200)||!allowed(`map ${provider} ${map}`,5,60)){c.header('Retry-After','1');return c.json({error:'Too many requests'},429);}
    try {
      const text=await boundedText(c.req.raw,512*1024),result=sync.webhook(provider,c.req.param('map')??'',c.req.raw.headers,text,c.req.url);
      for(const [name,value] of Object.entries(result.headers??{}))c.header(name,value);
      return result.status<300?c.json({ok:true},result.status as 200):c.json({error:result.status===401?'Invalid signature':'Not found'},result.status as 401);
    }catch{return c.json({error:'Invalid request'},400);}
  };
  app.post('/api/tasksync/:provider/hook/:map',c=>hook(c,c.req.param('provider')));
  for(const route of legacyRoutes)app.post(route.hook,c=>hook(c,route.provider));
}
