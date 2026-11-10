import { resolve } from 'node:path';
export interface Config {port:number;host:string;publicUrl:string;dataDir:string;clientDir:string;devUsers:string[];adminEmails:string[];adminSubs?:string[];issuer?:string;clientId?:string;clientSecret?:string;group:string;tz?:string;}
export function config(env:NodeJS.ProcessEnv=process.env):Config {
  const devUsers=(env.OPSMAP_DEV_USERS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(devUsers.length&&env.NODE_ENV==='production')throw new Error('Dev users are forbidden in production');
  if(devUsers.length&&env.HOST&&!['127.0.0.1','::1','localhost'].includes(env.HOST))throw new Error('Dev users require a loopback HOST');
  const publicUrl=env.PUBLIC_URL??'http://127.0.0.1:8080';
  const url=new URL(publicUrl);if(url.origin!==publicUrl)throw new Error('PUBLIC_URL must be an origin without a trailing slash');
  if(!devUsers.length&&(!env.OIDC_ISSUER||!env.OIDC_CLIENT_ID||!env.OIDC_CLIENT_SECRET))throw new Error('OIDC configuration is required');
  if(!devUsers.length&&url.protocol!=='https:')throw new Error('PUBLIC_URL must use HTTPS');
  // Calendar zone for maps without settings.tz: OPSMAP_TZ, else the process TZ, else UTC.
  const tz=env.OPSMAP_TZ||env.TZ||'UTC';
  try{new Intl.DateTimeFormat('en',{timeZone:tz});}catch{throw new Error(`Invalid time zone: ${tz}`);}
  return {tz,port:Number(env.PORT??8080),host:env.HOST??'127.0.0.1',publicUrl,dataDir:env.DATA_DIR??'/data',clientDir:resolve(env.CLIENT_DIR??'dist/client'),devUsers,adminSubs:(env.OPSMAP_ADMIN_SUBS??'').split(',').map(x=>x.trim()).filter(Boolean),adminEmails:(env.OPSMAP_ADMIN_EMAILS??'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),issuer:env.OIDC_ISSUER,clientId:env.OIDC_CLIENT_ID,clientSecret:env.OIDC_CLIENT_SECRET,group:env.OIDC_GROUP??'opsmap_users'};
}
