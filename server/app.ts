import { errorCode } from './errors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Maps } from './maps';
import { Auth } from './auth';
import { Store, type User } from './db';
import { originAllowed, warnOrigin, type Config } from './config';
import type { Command } from '../src/core/model/types';
import { schedulerTick } from './scheduler';
import { mcpRequest } from './mcp';
import { Bucket } from './limit';
import type { MapEvent } from './maps';
import { VkTokens } from './vikunja/tokens';
import { SecretBox } from './secrets';
import { VikunjaSync, isLoopback } from './vikunja/sync';
import { VK_REQUESTS } from '../src/core/commands/apply';
export function createApp(config:Config) {
  const store=new Store(join(config.dataDir,'opsmap.db')),maps=new Maps(store,config.tz),hub=maps.default,auth=new Auth(store,config),app=new Hono();
  // Vikunja sync when configured. Webhooks need a public (non-loopback) origin Vikunja can post to; else it polls.
  // Each user's token is sealed with the server's secret key; a map syncs with its binder's token.
  const vkTokens=config.vikunja?new VkTokens(store,SecretBox.fromFile(config.secretKeyFile??join(config.dataDir,'secrets','master.key')),config.vikunja.url):undefined;
  const vikunja=config.vikunja&&vkTokens?new VikunjaSync(maps,userId=>vkTokens.api(userId),config.vikunja.url,isLoopback(config.publicUrl)?undefined:config.publicUrl):undefined;
  app.use('*',async(c,next)=>{c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','same-origin');c.header('X-Frame-Options','DENY');await next();});
  app.onError((err,c)=>{console.error('Request failed',c.req.path,errorCode(err));return c.json({error:'Request failed'},500);});
  app.get('/healthz',c=>c.json({ok:true,maps:maps.hubs.size}));
  app.route('/auth',auth.routes);
  app.get('/api/me',c=>{const user=auth.current(c);return user?c.json({...user,admin:auth.admin(user),isAdmin:auth.admin(user)}):c.json({error:'Authentication required',devUsers:config.devUsers},401);});
  /** Map from ?map=<id or name>; the default map when absent. */
  const mapOf=(c:Context)=>maps.resolve(c.req.query('map'));
  app.get('/api/export',c=>{if(!auth.current(c))return c.json({error:'Authentication required'},401);try{return c.json(mapOf(c).doc);}catch(error){return c.json({error:error instanceof Error?error.message:'Unknown map'},404);}});
  app.get('/api/maps',c=>auth.current(c)?c.json({maps:maps.list()}):c.json({error:'Authentication required'},401));
  /** Map changes are same-origin JSON requests from a signed-in user; deletion is admin only. */
  const mapWrite=async(c:Context,admin:boolean,limit:number,run:(user:User,body:Record<string,unknown>)=>unknown)=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    if(admin&&!auth.admin(user))return c.json({error:'Administrator required'},403);
    if(!originAllowed(config,c.req.header('origin'))){warnOrigin(config,c.req.header('origin'),'a map change');return c.json({error:'Invalid origin'},403);}
    try {
      if(Number(c.req.header('content-length'))>limit)return c.json({error:'Request too large'},413);
      const text=await boundedText(c.req.raw,limit),body=text?JSON.parse(text):{};
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid request');
      return c.json({ok:true,...(run(user,body) as object)});
    }catch(error){return c.json({error:error instanceof Error?error.message:'Invalid request'},400);}
  };
  app.post('/api/maps',c=>mapWrite(c,false,5*1024*1024,(user,body)=>({map:maps.create(user.id,body.name,body.doc)})));
  app.patch('/api/maps/:id',c=>mapWrite(c,false,16*1024,(_user,body)=>({map:maps.rename(c.req.param('id'),body.name)})));
  app.delete('/api/maps/:id',c=>mapWrite(c,true,16*1024,()=>{maps.remove(c.req.param('id'));return {};}));
  app.post('/api/import',async c=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    if(!auth.admin(user))return c.json({error:'Administrator required'},403);
    if(!originAllowed(config,c.req.header('origin'))){warnOrigin(config,c.req.header('origin'),'an import');return c.json({error:'Invalid origin'},403);}
    try {
      if(Number(c.req.header('content-length'))>5*1024*1024)return c.json({error:'Document too large'},413);
      const text=await boundedText(c.req.raw,5*1024*1024);
      const op=mapOf(c).import(user.id,JSON.parse(text));return c.json({ok:true,op});
    }catch(error){return c.json({error:error instanceof Error?error.message:'Invalid document'},400);}
  });
  const tokenBuckets=new Map<string,{bucket:Bucket;at:number}>();
  app.post('/mcp',async c=>{
    const origin=c.req.header('origin');if(origin&&!originAllowed(config,origin))return c.json({error:'Invalid origin'},403);
    const header=c.req.header('authorization'),identity=header?.startsWith('Bearer ')?store.tokenIdentity(header.slice(7)):undefined;
    if(!identity)return c.json({error:'Valid bearer token required'},401);
    for(const [key,value] of tokenBuckets)if(Date.now()-value.at>60000)tokenBuckets.delete(key);
    let limit=tokenBuckets.get(identity.id);if(!limit){limit={bucket:new Bucket(20),at:Date.now()};tokenBuckets.set(identity.id,limit);}
    limit.at=Date.now();if(!limit.bucket.take())return c.json({error:'Rate limit exceeded'},429);
    try {
      const text=await boundedText(c.req.raw,128*1024);
      return await mcpRequest(new Request(c.req.url,{method:'POST',headers:c.req.raw.headers,body:text}),maps,identity.user,identity,vikunja,auth.admin(identity.user));
    }catch{return c.json({error:'Invalid MCP request'},400);}
  });
  app.all('/mcp',c=>c.text('Method not allowed',405));
  // The signed-in user's Vikunja account: whether a token is set (never the token itself), save, remove.
  app.get('/api/vikunja/account',c=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    if(!vkTokens)return c.json({configured:false});
    return c.json({configured:true,url:config.vikunja!.url,...vkTokens.account(user.id)});
  });
  const accountWrite=async(c:Context,run:(user:User,body:Record<string,unknown>)=>Promise<unknown>)=>{
    const user=auth.current(c);if(!user)return c.json({error:'Authentication required'},401);
    if(!vkTokens)return c.json({error:'Vikunja sync is not configured on this server'},404);
    if(!originAllowed(config,c.req.header('origin'))){warnOrigin(config,c.req.header('origin'),'a Vikunja account change');return c.json({error:'Invalid origin'},403);}
    try {
      const text=await boundedText(c.req.raw,8*1024),body=text?JSON.parse(text):{};
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid request');
      return c.json({ok:true,configured:true,url:config.vikunja!.url,...(await run(user,body) as object)});
    }catch(error){return c.json({error:error instanceof Error?error.message:'Invalid request'},400);}
  };
  app.put('/api/vikunja/account',c=>accountWrite(c,async(user,body)=>vkTokens!.save(user.id,body.token)));
  app.delete('/api/vikunja/account',c=>accountWrite(c,async user=>{vkTokens!.remove(user.id);return {connected:false};}));
  // Vikunja webhooks: server to server, authenticated by the per-map HMAC secret, not by a session.
  app.post('/api/vikunja/hook/:map',async c=>{
    if(!vikunja)return c.json({error:'Not found'},404);
    try {
      const text=await boundedText(c.req.raw,512*1024);
      return vikunja.webhook(c.req.param('map'),text,c.req.header('x-vikunja-signature'))?c.json({ok:true}):c.json({error:'Invalid signature'},401);
    }catch{return c.json({error:'Invalid request'},400);}
  });
  app.all('/api/*',c=>c.json({error:'Not found'},404));
  // Keep the SPA shell public so the client can render its login screen; APIs and sockets require auth.
  app.use('*',serveStatic({root:config.clientDir}));
  app.get('*',async(c,next)=>{if(!c.req.header('accept')?.includes('text/html'))return c.notFound();if(!existsSync(join(config.clientDir,'index.html')))return c.text('Client has not been built',503);return serveStatic({path:join(config.clientDir,'index.html')})(c,next);});
  return {app,hub,maps,store,auth,vikunja};
}
async function boundedText(request:Request,limit:number):Promise<string> {
  const reader=request.body?.getReader();if(!reader)return '';
  let size=0;const chunks:Uint8Array[]=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Request too large');}chunks.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
export function startServer(config:Config,options:{schedule?:boolean}={}) {
  const runtime=createApp(config),{app,maps,store,auth,vikunja}=runtime;
  const server=serve({fetch:app.fetch,port:config.port,hostname:config.host});
  const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
  const clients=new Map<WebSocket,{user:User;mapId:string;selectedId:string|null;ready:boolean;alive:boolean;cookie:string;frames:Bucket;presence:Bucket}>();
  const send=(ws:WebSocket,value:unknown)=>{if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>2*1024*1024)ws.close(1013,'Client too slow');else ws.send(JSON.stringify(value));}};
  // Presence is per map: a user sees who else is on the map they have open.
  const presence=(mapId:string)=>{const users=new Map<string,{userId:string;selectedId:string|null}>();for(const client of clients.values())if(client.ready&&client.mapId===mapId)users.set(client.user.id,{userId:client.user.id,selectedId:client.selectedId});for(const[ws,client]of clients)if(client.ready&&client.mapId===mapId)send(ws,{t:'presence',users:[...users.values()]});};
  const broadcast=(event:MapEvent)=>{
    if(event.kind==='op'){for(const[ws,client]of clients)if(client.ready&&client.mapId===event.mapId)send(ws,{t:'op',op:event.op});return;}
    for(const[ws,client]of clients) {
      if(!client.ready)continue;
      // Clients on a deleted map reconnect and land on the default map.
      if(client.mapId===event.deleted){client.ready=false;ws.close(4004,'Map deleted');continue;}
      send(ws,{t:'maps',maps:event.maps});
    }
  };maps.listeners.add(broadcast);
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/ws'||!originAllowed(config,req.headers.origin)){if(req.url==='/ws')warnOrigin(config,req.headers.origin,'a WebSocket');socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const user=auth.session(req.headers.cookie);if(!user){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      clients.set(ws,{user,mapId:maps.default.mapId,selectedId:null,ready:false,alive:true,cookie:req.headers.cookie??'',frames:new Bucket(30),presence:new Bucket(10,2)});
      ws.on('pong',()=>{const c=clients.get(ws);if(c)c.alive=true;});
      ws.on('error',()=>ws.close());
      ws.on('close',()=>{const mapId=clients.get(ws)?.mapId;clients.delete(ws);if(mapId)presence(mapId);});
      ws.on('message',raw=>{
        let opId='';
        try {
          const connection=clients.get(ws)!;if(!connection.frames.take()){ws.close(1008,'Rate limit exceeded');return;}
          const msg=JSON.parse(raw.toString());if(!msg||typeof msg!=='object')throw new Error('Invalid message');
          opId=typeof msg.opId==='string'?msg.opId:'';
          const client=clients.get(ws)!;
          if(!auth.session(client.cookie)){ws.close(1008,'Session expired');return;}
          if(msg.t==='hello') {
            if(msg.map!==undefined&&(typeof msg.map!=='string'||msg.map.length>128))throw new Error('Invalid map');
            // An unknown or deleted map falls back to the default map; the welcome names the map served.
            let hub=maps.default,fallback=false;
            if(typeof msg.map==='string'){try{hub=maps.resolve(msg.map);}catch{fallback=true;}}
            if(!Number.isSafeInteger(msg.since)||msg.since<0||hub.mapId===msg.map&&msg.since>hub.seq)throw new Error('Invalid sequence');
            const previous=client.ready?client.mapId:undefined;
            client.ready=true;client.mapId=hub.mapId;client.selectedId=null;
            const base={t:'welcome',me:{...user,admin:auth.admin(user)},users:store.users(),seq:hub.seq,map:hub.mapId,maps:maps.list(),vikunja:config.vikunja?{url:config.vikunja.url}:null,...(fallback?{fallback:true}:{})};
            // Always replace the cache on reconnect, including after a restored or forked database.
            send(ws,{...base,doc:hub.doc});presence(hub.mapId);if(previous&&previous!==hub.mapId)presence(previous);
          }else if(msg.t==='ping')send(ws,{t:'pong'});
          else if(!client.ready)throw new Error('Send hello first');
          else if(msg.t==='presence') {
            if(!client.presence.take())return;
            if(msg.selectedId!==null&&(typeof msg.selectedId!=='string'||msg.selectedId.length>128))throw new Error('Invalid selection');
            client.selectedId=msg.selectedId;presence(client.mapId);
          }else if(msg.t==='vk') {
            // /vk bind, sync, status: the server calls Vikunja, then answers this request (ops arrive as usual).
            if(!opId)throw new Error('Request id required');
            if(!vikunja)throw new Error('Vikunja sync is not configured on this server');
            const args=msg.args;if(!args||typeof args!=='object'||!(VK_REQUESTS as readonly string[]).includes(String(args.action)))throw new Error('Invalid /vk request');
            const mapId=client.mapId;
            vikunja.request(mapId,{action:args.action,...(typeof args.name==='string'?{name:args.name.slice(0,250)}:{})},user,'web')
              .then(log=>send(ws,{t:'vk',opId,ok:true,log}),error=>send(ws,{t:'vk',opId,ok:false,error:error instanceof Error?error.message:'Vikunja request failed'}));
          }else if(msg.t==='op'||msg.t==='undo'||msg.t==='redo') {
            if(!opId)throw new Error('Operation id required');
            const hub=maps.get(client.mapId);if(!hub)throw new Error('Map deleted');
            const old=hub.existing(opId,user.id);
            if(old)send(ws,{t:'op',op:old});
            else if(msg.t==='op')hub.submit(user.id,'web',opId,msg.cmd as Command);
            else hub.undo(user.id,opId,msg.t==='redo');
          }else throw new Error('Unknown message');
        }catch(error){send(ws,{t:'reject',opId,error:error instanceof Error?error.message:'Invalid message'});}
      });
    });
  });
  const heartbeat=setInterval(()=>{for(const[ws,c]of clients){if(!c.alive||!auth.session(c.cookie)){ws.terminate();continue;}c.alive=false;ws.ping();}},30000);heartbeat.unref();
  const tick=()=>{try{schedulerTick(maps,config.dataDir);}catch(error){console.error('Scheduled maintenance failed',errorCode(error));}};
  let scheduler:ReturnType<typeof setInterval>|undefined;
  if(options.schedule!==false){tick();scheduler=setInterval(tick,60000);scheduler.unref();vikunja?.start();}
  const close=async()=>{
    clearInterval(heartbeat);if(scheduler)clearInterval(scheduler);maps.listeners.delete(broadcast);await vikunja?.stop();
    for(const ws of clients.keys())ws.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    maps.snapshot();store.close();
  };
  return {...runtime,server,close};
}
