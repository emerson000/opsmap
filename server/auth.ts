import { errorCode } from './errors';
import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { originAllowed, type Config } from './config';
import { Store, type User } from './db';
const lifetime=86400*1000;
const random=()=>randomBytes(32).toString('base64url');
export class Auth {
  readonly routes=new Hono();
  private discovery?:Promise<oidc.Configuration>;
  private pending=new Map<string,{state:string;nonce:string;verifier:string;expires:number}>();
  constructor(readonly store:Store,readonly config:Config) {
    this.routes.get('/login',async c=>{
      if(config.devUsers.length)return c.redirect('/');
      const client=await this.client();const verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce(),id=random();
      for(const [key,value]of this.pending)if(value.expires<Date.now())this.pending.delete(key);
      if(this.pending.size>=1000)this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(id,{state,nonce,verifier,expires:Date.now()+600000});
      setCookie(c,'opsmap_oidc',id,{httpOnly:true,secure:true,sameSite:'Lax',path:'/auth',maxAge:600});
      return c.redirect(oidc.buildAuthorizationUrl(client,{redirect_uri:`${config.publicUrl}/auth/callback`,scope:'openid email profile groups',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'}).href);
    });
    this.routes.get('/callback',async c=>{
      const id=getCookie(c,'opsmap_oidc')??'',pending=this.pending.get(id);this.pending.delete(id);
      deleteCookie(c,'opsmap_oidc',{path:'/auth',secure:true});
      if(!pending||pending.expires<Date.now())return c.text('Login expired',400);
      try {
        const client=await this.client();
        const tokens=await oidc.authorizationCodeGrant(client,new URL(`${config.publicUrl}/auth/callback${new URL(c.req.url).search}`),{expectedState:pending.state,expectedNonce:pending.nonce,pkceCodeVerifier:pending.verifier,idTokenExpected:true});
        const claims=tokens.claims();if(!claims)throw new Error('Missing identity');
        let info:Record<string,unknown>={};
        if(!Array.isArray(claims.groups)||!claims.groups.includes(config.group)||!claims.email)info=await oidc.fetchUserInfo(client,tokens.access_token,claims.sub);
        const groups=[...(Array.isArray(claims.groups)?claims.groups:[]),...(Array.isArray(info.groups)?info.groups:[])];
        if(!groups.includes(config.group))return c.text('Access denied',403);
        const email=claims.email??info.email,name=claims.name??info.name??email;
        if(typeof email!=='string'||typeof name!=='string')return c.text('Email and name required',403);
        const user=store.upsertUser(claims.sub,email,name,typeof claims.email==='string'&&claims.email_verified===true);this.login(c,user);return c.redirect('/');
      }catch(error){console.error('OIDC callback failed',errorCode(error));return c.text('Authentication failed',403);}
    });
    this.routes.get('/dev-login',c=>{
      const name=c.req.query('user')??'';
      if(!config.devUsers.length)return c.notFound();
      if(!config.devUsers.includes(name))return c.text('Unknown dev user',403);
      const email=`${name}@dev.local`;const user=store.upsertUser(`dev:${name}`,email,name[0].toUpperCase()+name.slice(1),true);this.login(c,user);return c.redirect('/');
    });
    this.routes.post('/logout',c=>{if(!originAllowed(config,c.req.header('origin')))return c.text('Invalid origin',403);const id=getCookie(c,'opsmap_sid');if(id)store.db.prepare('DELETE FROM sessions WHERE id=?').run(id);deleteCookie(c,'opsmap_sid',{path:'/',secure:!config.devUsers.length});return c.redirect('/');});
  }
  private client() {return this.discovery??=oidc.discovery(new URL(this.config.issuer!),this.config.clientId!,this.config.clientSecret!).catch(error=>{this.discovery=undefined;throw error;});}
  private login(c:Context,user:User) {
    const id=random(),now=new Date();
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,user.id,now.toISOString(),new Date(now.getTime()+lifetime).toISOString());
    this.cookie(c,id);
  }
  private cookie(c:Context,id:string) {setCookie(c,'opsmap_sid',id,{httpOnly:true,secure:!this.config.devUsers.length,sameSite:'Lax',path:'/',maxAge:lifetime/1000});}
  session(cookie:string|undefined):User|undefined {
    const id=cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('opsmap_sid='))?.slice(11);
    if(!id||!/^[A-Za-z0-9_-]{43}$/.test(id))return;
    const session=this.store.db.prepare('SELECT user_id FROM sessions WHERE id=? AND expires_at>? AND created_at>?').get(id,new Date().toISOString(),new Date(Date.now()-lifetime).toISOString()) as {user_id:string}|undefined;
    if(!session)return;
    return this.store.user(session.user_id);
  }
  current(c:Context):User|undefined {const user=this.session(c.req.header('cookie'));if(user)this.cookie(c,getCookie(c,'opsmap_sid')!);return user;}
  admin(user:User):boolean {return Boolean(this.config.adminSubs?.includes(user.id)||user.emailVerified&&this.config.adminEmails.includes(user.email.toLowerCase()));}
}
