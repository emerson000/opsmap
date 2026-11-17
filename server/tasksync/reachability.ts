// D19: can a task service reach PUBLIC_URL? Its host counts as private when any address it resolves to is loopback,
// RFC 1918, CGNAT 100.64.0.0/10 (Tailscale), link-local or IPv6 ULA/link-local, or when its name is a local one.
// A tailnet name such as opsmap.example.ts.net resolves to 100.x, so the name alone would not tell.
import { isIP } from 'node:net';
export interface Reachability { https:boolean; publicAddress:boolean; reason?:string; /** Only the host itself can reach it. */ loopback?:boolean; /** The name did not resolve: try again later. */ failed?:boolean }
const PRIVATE_NAMES=['.local','.lan','.internal','.home.arpa','.ts.net'];
const v4=(ip:string)=>ip.split('.').map(Number);
/** True for addresses no other network can reach: loopback, unspecified, private, CGNAT, link-local, ULA. */
export function isPrivateAddress(ip:string):boolean {
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);if(mapped)return isPrivateAddress(mapped[1]);
  if(isIP(ip)===4){const [a,b]=v4(ip);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127;}
  const x=ip.toLowerCase();if(x==='::'||x==='::1')return true;
  const head=parseInt(x.split(':')[0]||'0',16);
  return (head&0xfe00)===0xfc00||(head&0xffc0)===0xfe80;
}
const isLoopback=(ip:string)=>ip==='::1'||/^(::ffff:)?127\./i.test(ip);
/** How a task service would see PUBLIC_URL: https or not, and whether its address is public (with the reason when not). */
export async function classifyPublicUrl(url:string|undefined,resolve:(host:string)=>Promise<string[]>):Promise<Reachability> {
  if(!url)return {https:false,publicAddress:false,reason:'PUBLIC_URL is not set'};
  let u:URL;try{u=new URL(url);}catch{return {https:false,publicAddress:false,reason:'PUBLIC_URL is not a URL'};}
  const https=u.protocol==='https:',host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost'))return {https,publicAddress:false,loopback:true,reason:'PUBLIC_URL is a loopback address'};
  const suffix=PRIVATE_NAMES.find(s=>host.endsWith(s));
  if(suffix)return {https,publicAddress:false,reason:`PUBLIC_URL is a private name (${suffix})`};
  let addresses:string[];
  if(isIP(host))addresses=[host];
  else{try{addresses=await resolve(host);}catch{addresses=[];}if(!addresses.length)return {https,publicAddress:false,failed:true,reason:`PUBLIC_URL ${host} does not resolve`};}
  if(addresses.every(isLoopback))return {https,publicAddress:false,loopback:true,reason:'PUBLIC_URL is a loopback address'};
  const inside=addresses.find(isPrivateAddress);
  return inside?{https,publicAddress:false,reason:`PUBLIC_URL is a private address (${inside})`}:{https,publicAddress:true};
}
/** The system resolver, every address. */
export const lookupAll=async(host:string):Promise<string[]>=>(await (await import('node:dns/promises')).lookup(host,{all:true})).map(a=>a.address);
