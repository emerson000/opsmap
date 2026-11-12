import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startServer } from '../../server/app';
import type { Config } from '../../server/config';

// Token management in the browser works the same for dev users and OIDC users: it rests on the session only.
describe('access tokens',()=>{
  let dir:string,settings:Config,runtime:ReturnType<typeof startServer>,url:string;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'opsmap-tokens-'));
    const clientDir=join(dir,'client');mkdirSync(clientDir);writeFileSync(join(clientDir,'index.html'),'<!doctype html>');
    settings={port:0,host:'127.0.0.1',publicUrl:'http://localhost',dataDir:dir,clientDir,devUsers:['alice','bob'],adminEmails:['alice@dev.local'],group:'opsmap_users',tz:'UTC'};
    runtime=startServer(settings,{schedule:false});
    if(!runtime.server.listening)await once(runtime.server,'listening');
    url=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;
  });
  afterEach(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const login=async(name:string)=>(await fetch(`${url}/auth/dev-login?user=${name}`,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  const api=async(method:string,path:string,cookie:string,body?:unknown,origin=settings.publicUrl)=>{
    const response=await fetch(`${url}${path}`,{method,headers:{cookie,origin,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  const mcp=async(token:string,name:string,args:Record<string,unknown>={})=>{
    const response=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    if(response.status!==200)return {status:response.status};
    const text=(await response.json() as any).result.content[0].text as string;
    try{return {status:200,result:JSON.parse(text)};}catch{return {status:200,text};}
  };

  it('creates, lists and revokes tokens from the browser session, with origin and ownership checks',async()=>{
    const al=await login('alice'),bo=await login('bob');
    expect((await fetch(`${url}/api/tokens`)).status).toBe(401);
    expect((await api('POST','/api/tokens',bo,{name:'agent'},'https://evil.invalid')).status).toBe(403);
    expect((await api('POST','/api/tokens',bo,{name:'  '})).body.error).toBe('Token name required');
    expect((await api('POST','/api/tokens',bo,{name:'x'.repeat(61)})).body.error).toMatch(/too long/);
    const made=await api('POST','/api/tokens',bo,{name:'  bob   laptop '});
    expect(made.status).toBe(200);expect(made.body.created).toMatchObject({name:'bob laptop',userEmail:'bob@dev.local',mine:true,lastUsed:null});
    expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(made.body.tokens).toHaveLength(1);
    expect((await api('POST','/api/tokens',al,{name:'BOB LAPTOP'})).body.error).toBe('A token named BOB LAPTOP is already in use');
    // The token works on MCP and is listed without its secret.
    expect((await mcp(made.body.token,'opsmap_maps')).status).toBe(200);
    const listed=await api('GET','/api/tokens',bo);expect(JSON.stringify(listed.body)).not.toContain(made.body.token);expect(listed.body.tokens[0].lastUsed).not.toBeNull();
    // Alice (admin) sees Bob's token; Bob sees only his own and cannot revoke Alice's.
    const alices=(await api('POST','/api/tokens',al,{name:'alice agent'})).body.created;
    expect((await api('GET','/api/tokens',al)).body).toMatchObject({admin:true,tokens:[{name:'alice agent',mine:true},{name:'bob laptop',mine:false,userName:'Bob'}]});
    expect((await api('GET','/api/tokens',bo)).body.tokens.map((t:any)=>t.name)).toEqual(['bob laptop']);
    expect((await api('DELETE',`/api/tokens/${alices.id}`,bo)).body.error).toBe('Active token not found');
    expect((await api('DELETE',`/api/tokens/${made.body.created.id}`,bo,undefined,'https://evil.invalid')).status).toBe(403);
    const revoked=await api('DELETE',`/api/tokens/${made.body.created.id}`,al);
    expect(revoked.body).toMatchObject({ok:true,revoked:{name:'bob laptop'}});
    expect((await mcp(made.body.token,'opsmap_maps')).status).toBe(401);
    // The name is free again.
    expect((await api('POST','/api/tokens',bo,{name:'bob laptop'})).status).toBe(200);
  });

  it('lists and revokes tokens through MCP with the same rules, and does not create them',async()=>{
    const al=await login('alice'),bo=await login('bob');
    const a=(await api('POST','/api/tokens',al,{name:'alice agent'})).body,b=(await api('POST','/api/tokens',bo,{name:'bob agent'})).body,b2=(await api('POST','/api/tokens',bo,{name:'bob spare'})).body;
    expect((await mcp(b.token,'opsmap_tokens')).result.map((t:any)=>[t.name,t.current])).toEqual([['bob spare',false],['bob agent',true]]);
    expect((await mcp(a.token,'opsmap_tokens')).result).toHaveLength(3);
    expect((await mcp(b.token,'opsmap_token_revoke',{token:'alice agent'})).result).toEqual({ok:false,error:'Active token not found',at:0});
    expect((await mcp(b.token,'opsmap_token_revoke',{token:'Bob Spare'})).result).toMatchObject({ok:true,revoked:{id:b2.created.id,name:'bob spare'}});
    expect((await mcp(b2.token,'opsmap_maps')).status).toBe(401);
    expect((await mcp(a.token,'opsmap_token_revoke',{token:b.created.id})).result).toMatchObject({ok:true});
    expect((await mcp(b.token,'opsmap_maps')).status).toBe(401);
    expect((await mcp(a.token,'opsmap_token_create',{name:'x'})).text).toMatch(/not found/);
  });
});
