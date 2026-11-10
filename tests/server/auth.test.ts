import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Auth } from '../../server/auth';
import { Store } from '../../server/db';
import type { Config } from '../../server/config';
const mocks=vi.hoisted(()=>({
  discovery:vi.fn(),grant:vi.fn(),userinfo:vi.fn(),build:vi.fn(),
}));
vi.mock('openid-client',()=>({
  discovery:mocks.discovery,authorizationCodeGrant:mocks.grant,fetchUserInfo:mocks.userinfo,buildAuthorizationUrl:mocks.build,
  randomPKCECodeVerifier:()=> 'test-pkce',randomState:()=> 'test-state',randomNonce:()=> 'test-nonce',calculatePKCECodeChallenge:async()=> 'test-challenge',
}));
describe('OIDC boundary',()=>{
  let store:Store,auth:Auth,app:Hono;
  const settings:Config={port:8080,host:'127.0.0.1',publicUrl:'https://opsmap.example.invalid',dataDir:'/unused',clientDir:'/unused',devUsers:[],adminEmails:[],group:'opsmap_users',issuer:'https://id.example.invalid',clientId:'test-client',clientSecret:'not-a-real-secret'};
  beforeEach(()=>{
    vi.clearAllMocks();mocks.discovery.mockResolvedValue({});mocks.build.mockReturnValue(new URL('https://id.example.invalid/authorize'));mocks.userinfo.mockResolvedValue({});
    store=new Store(':memory:');auth=new Auth(store,settings);app=new Hono();app.route('/auth',auth.routes);
  });
  afterEach(()=>store.close());
  async function loginCookie() {
    const response=await app.request('/auth/login');expect(response.status).toBe(302);
    expect(mocks.build).toHaveBeenCalledWith({},expect.objectContaining({scope:'openid email profile groups',state:'test-state',nonce:'test-nonce',code_challenge:'test-challenge',code_challenge_method:'S256',redirect_uri:`${settings.publicUrl}/auth/callback`}));
    const cookie=response.headers.get('set-cookie')!;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');expect(cookie).toContain('SameSite=Lax');return cookie.split(';')[0];
  }
  const grant=(claims:Record<string,unknown>)=>mocks.grant.mockResolvedValue({claims:()=>claims,access_token:'not-a-real-access-token'});
  it('validates code, PKCE, state and nonce and accepts groups in the id_token',async()=>{
    grant({sub:'subject',email:'al@example.invalid',name:'Alice',groups:['opsmap_users']});
    const cookie=await loginCookie();const response=await app.request('/auth/callback?code=test-code&state=test-state',{headers:{cookie}});
    expect(response.status).toBe(302);expect(mocks.grant).toHaveBeenCalledWith({},new URL(`${settings.publicUrl}/auth/callback?code=test-code&state=test-state`),{expectedState:'test-state',expectedNonce:'test-nonce',pkceCodeVerifier:'test-pkce',idTokenExpected:true});
    const session=response.headers.get('set-cookie')!.split(',').find(x=>x.includes('opsmap_sid='))!.trim().split(';')[0];expect(auth.session(session)).toMatchObject({id:'subject',email:'al@example.invalid'});expect(mocks.userinfo).not.toHaveBeenCalled();
  });
  it('accepts required group from subject-checked userinfo',async()=>{
    grant({sub:'subject',email:'bo@example.invalid',name:'Bob'});mocks.userinfo.mockResolvedValue({sub:'subject',groups:['opsmap_users']});
    const cookie=await loginCookie();expect((await app.request('/auth/callback?code=code',{headers:{cookie}})).status).toBe(302);expect(mocks.userinfo).toHaveBeenCalledWith({},'not-a-real-access-token','subject');
  });
  it('denies missing groups and failed validation without creating a session',async()=>{
    grant({sub:'subject',email:'outsider@example.invalid',name:'Outsider',groups:['other']});
    let cookie=await loginCookie();expect((await app.request('/auth/callback?code=code',{headers:{cookie}})).status).toBe(403);expect(store.users()).toEqual([]);
    mocks.grant.mockRejectedValue(new Error('Invalid nonce'));cookie=await loginCookie();expect((await app.request('/auth/callback?code=code',{headers:{cookie}})).status).toBe(403);
    expect(store.db.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({n:0});
  });
  it('binds the callback to the initiating browser and makes it single use',async()=>{
    grant({sub:'subject',email:'al@example.invalid',name:'Alice',groups:['opsmap_users']});
    const cookie=await loginCookie();expect((await app.request('/auth/callback?code=code')).status).toBe(400);
    expect((await app.request('/auth/callback?code=code',{headers:{cookie}})).status).toBe(302);
    expect((await app.request('/auth/callback?code=code',{headers:{cookie}})).status).toBe(400);expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it('does not expose development logins in OIDC mode',async()=>expect((await app.request('/auth/dev-login?user=alice')).status).toBe(404));
});

describe('session and admin regressions',()=>{
 it('keys admin on subjects and requires explicit verified email for legacy configuration',()=>{
  const store=new Store(':memory:');try{
   const settings:Config={port:0,host:'127.0.0.1',publicUrl:'http://localhost',dataDir:'/unused',clientDir:'/unused',devUsers:['human'],adminSubs:['trusted-sub'],adminEmails:['admin@example.invalid'],group:'opsmap_users'};
   const auth=new Auth(store,settings);
   expect(auth.admin(store.upsertUser('impostor','admin@example.invalid','Impostor'))).toBe(false);
   expect(auth.admin(store.upsertUser('verified','admin@example.invalid','Verified',true))).toBe(true);
   expect(auth.admin(store.upsertUser('trusted-sub','new@example.invalid','Trusted'))).toBe(true);
  }finally{store.close();}
 });
 it('expires absolutely after 24 hours, does not write on use and protects logout',async()=>{
  const store=new Store(':memory:');try{
   const settings:Config={port:0,host:'127.0.0.1',publicUrl:'http://localhost',dataDir:'/unused',clientDir:'/unused',devUsers:['human'],adminEmails:[],group:'opsmap_users'};
   const auth=new Auth(store,settings),app=new Hono();app.route('/auth',auth.routes);
   const response=await app.request('/auth/dev-login?user=human');const cookie=response.headers.get('set-cookie')!.split(';')[0];
   const before=store.db.prepare('SELECT * FROM sessions').get();expect(auth.session(cookie)?.id).toBe('dev:human');expect(store.db.prepare('SELECT * FROM sessions').get()).toEqual(before);
   expect((await app.request('/auth/logout',{headers:{cookie}})).status).toBe(404);
   expect((await app.request('/auth/logout',{method:'POST',headers:{cookie,origin:'http://foreign'}})).status).toBe(403);expect(auth.session(cookie)).toBeDefined();
   store.db.prepare('UPDATE sessions SET created_at=?').run(new Date(Date.now()-86400001).toISOString());expect(auth.session(cookie)).toBeUndefined();
  }finally{store.close();}
 });
});

describe('origin checks',()=>{
 it('accepts only PUBLIC_URL in production and any loopback origin with dev users',async()=>{
  const {originAllowed}=await import('../../server/config');
  const base={port:8080,host:'127.0.0.1',publicUrl:'https://maps.example.invalid',dataDir:'/tmp',clientDir:'/tmp',adminEmails:[],group:'g'};
  const prod={...base,devUsers:[]},dev={...base,publicUrl:'http://127.0.0.1:8080',devUsers:['alice']};
  expect(originAllowed(prod,'https://maps.example.invalid')).toBe(true);
  for(const o of ['http://localhost:5173','http://127.0.0.1:8080',undefined])expect(originAllowed(prod,o)).toBe(false);
  for(const o of ['http://127.0.0.1:8080','http://localhost:8080','http://localhost:5173','http://[::1]:5173'])expect(originAllowed(dev,o)).toBe(true);
  for(const o of ['https://localhost:5173','http://evil.invalid','http://localhost.evil.invalid:5173','http://localhost:5173/x','null'])expect(originAllowed(dev,o)).toBe(false);
 });
});
