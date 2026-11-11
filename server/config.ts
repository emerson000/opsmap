import { resolve } from 'node:path';
import { join } from 'node:path';
export interface Config {port:number;host:string;publicUrl:string;dataDir:string;clientDir:string;devUsers:string[];adminEmails:string[];adminSubs?:string[];issuer?:string;clientId?:string;clientSecret?:string;group:string;tz?:string;
  /** Vikunja sync: on when VIKUNJA_URL is set. Each user connects their own API token in the app. */
  vikunja?:{url:string};
  /** The 32-byte key that seals stored secrets (users' Vikunja tokens); created there when missing. */
  secretKeyFile?:string;}
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
  let vikunja:Config['vikunja'];
  if(env.VIKUNJA_URL){const u=new URL(env.VIKUNJA_URL);if(!['https:','http:'].includes(u.protocol))throw new Error('VIKUNJA_URL must be http(s)');vikunja={url:u.origin};}
  const dataDir=env.DATA_DIR??'/data';
  return {vikunja,secretKeyFile:env.OPSMAP_SECRET_KEY_FILE||join(dataDir,'secrets','master.key'),tz,port:Number(env.PORT??8080),host:env.HOST??'127.0.0.1',publicUrl,dataDir:env.DATA_DIR??'/data',clientDir:resolve(env.CLIENT_DIR??'dist/client'),devUsers,adminSubs:(env.OPSMAP_ADMIN_SUBS??'').split(',').map(x=>x.trim()).filter(Boolean),adminEmails:(env.OPSMAP_ADMIN_EMAILS??'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),issuer:env.OIDC_ISSUER,clientId:env.OIDC_CLIENT_ID,clientSecret:env.OIDC_CLIENT_SECRET,group:env.OIDC_GROUP??'opsmap_users'};
}

/** Production accepts only PUBLIC_URL. Development (dev users, loopback listener only) also accepts any loopback
 *  origin, so http://localhost:8080 and the Vite dev server on another port work too. */
export function originAllowed(config:Config,origin:string|undefined):boolean {
  if(!origin)return false;
  if(origin===config.publicUrl)return true;
  if(!config.devUsers.length)return false;
  try {const url=new URL(origin);return url.origin===origin&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{return false;}
}
const warned=new Set<string>();
/** One log line per refused origin, so a mismatched PUBLIC_URL is visible instead of a silent 403. */
export function warnOrigin(config:Config,origin:string|undefined,what:string) {
  const key=`${what}:${origin}`;if(warned.has(key)||warned.size>100)return;warned.add(key);
  console.warn(`Refused ${what} from origin ${origin??'(none)'}: open the app at ${config.publicUrl} or set PUBLIC_URL to the address in the browser`);
}
