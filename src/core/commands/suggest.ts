import type { Doc, Unit } from '../model/types';
import { ECHELONS } from '../model/echelon';
import { FUNCTIONS } from '../model/functions';
import { aliases, SYNTAX, VERBS } from './grammar';
import { identities as identityTokens, sizes as sizeTokens, functions as functionTokens } from './apply';
import { unresolved } from './resolve';
import { tokenize } from './tokenize';
export interface Suggestion {insert:string;label:string;detail?:string;unitId?:string;kind:'verb'|'unit'|'sector'|'echelon'|'function'|'identity'|'keyword'|'date';}
const keyword=(insert:string,kind:Suggestion['kind']='keyword'):Suggestion=>({insert,label:insert,kind});
export interface SuggestOptions {
 /** Units this user commanded or selected recently, most recent first. They lead each unit list, so a chain of
  *  commands on one unit needs no typing; then units in that unit's sector, then the most recently changed. */
 recent?:readonly string[];
 /** The server has Vikunja sync: offer /vk. */
 vikunja?:boolean;
}
export function suggest(input:string,cursor:number,doc:Doc,opts:SuggestOptions={}):{items:Suggestion[];ghost:string} {
 const prefix=input.slice(0,Math.max(0,Math.min(input.length,cursor)));
 let tokens;
 try {tokens=tokenize(prefix);}catch{return {items:[],ghost:'Close the quoted text with "'};}
 const complete=/\s$/.test(prefix),last=tokens.at(-1),fragment=complete?'':last?.value??'';
 const previous=complete?tokens:tokens.slice(0,-1);
 const verbText=tokens[0]?.value.replace(/^\//,'').toLowerCase()??'';
 const verb=aliases[verbText]??verbText;
 let candidates:Suggestion[]=[];
 // Unit order: units already named in this command last; the verb's own groups (`group`, lower first), except
 // that the unit just used (clicked or commanded) beats a soft group; then recency, then the most recent unit's
 // sector, then the most recently changed, then creation order. `strict` groups (who may attack) always hold.
 const recentRank=new Map((opts.recent??[]).map((id,i)=>[id,i] as const));
 const anchor=(opts.recent??[]).map(id=>doc.units.find(u=>u.id===id)).find(Boolean);
 const named=new Set(tokens.slice(1,complete?undefined:-1).map(t=>t.value.toUpperCase()));
 const units=(values:Unit[]=doc.units.filter(unresolved),group:(u:Unit)=>number=()=>0,strict=false):Suggestion[]=>values
  .map((u,i)=>({u,key:[Number(named.has(u.designation.toUpperCase())),!strict&&recentRank.get(u.id)===0?-Infinity:group(u),recentRank.get(u.id)??Infinity,Number(u.sectorId!==anchor?.sectorId),-Date.parse(u.updatedAt)||0,i]}))
  .sort((a,b)=>{for(let k=0;k<a.key.length;k++)if(a.key[k]!==b.key[k])return a.key[k]<b.key[k]?-1:1;return 0;})
  .map(({u})=>({insert:u.designation,label:u.designation,detail:`${u.title} · ${doc.sectors.find(s=>s.id===u.sectorId)?.name??''}`,unitId:u.id,kind:'unit'}));
 const sectors=():Suggestion[]=>doc.sectors.map(s=>({insert:/\s/.test(s.name)?JSON.stringify(s.name):s.name,label:s.name,kind:'sector'}));
 const identities=()=>['friend','hostile','neutral','unknown','suspect','assumed','pending'].map(s=>keyword(s,'identity'));
 const sizes=():Suggestion[]=>ECHELONS.map(e=>({insert:e.key,label:`${e.key} · ${e.mark}`,detail:e.range,kind:'echelon'}));
 const functions=():Suggestion[]=>FUNCTIONS.map(f=>({insert:f.key,label:f.key,detail:f.label,kind:'function'}));
 const before=previous.at(-1)?.value.toLowerCase();
 const source=doc.units.find(u=>u.designation.toLowerCase()===previous[1]?.value.toLowerCase()||u.id===previous[1]?.value.replace(/^#/,''));
 const threats=()=>units(doc.units.filter(u=>unresolved(u)&&['hostile','suspect'].includes(u.affiliation)&&u.id!==source?.id),u=>Number(u.sectorId!==source?.sectorId));
 const dates=()=>['today','tmw','mon','tue','wed','thu','fri','sat','sun','eow','eom','+3d'].map(s=>keyword(s,'date'));
 let hint='';

 if(previous.length===0)candidates=VERBS.filter(v=>v!=='vk'||opts.vikunja).map(v=>({insert:v,label:`/${v}`,detail:SYNTAX[v],kind:'verb'}));
 else if(verb==='vk'&&previous.length===1)candidates=opts.vikunja?['bind','unbind','sync','status'].map(s=>keyword(s)):[];
 else if(verb==='vk')candidates=[];
 else if(before==='due'||(verb==='due'&&previous.length===2)||(verb==='pl'&&previous.length===3&&previous[1]?.value.toLowerCase()==='add'))candidates=dates();
 else if(before==='in'||before==='sector'||(before==='to'&&(verb==='move'||['obj','ea','nai'].includes(verb)))||before==='reassign')candidates=sectors();
 else if(verb==='size'&&previous.length===2)candidates=sizes();
 else if(verb==='id'&&previous.length===2)candidates=identities();
 else if(verb==='fn'&&previous.length===2)candidates=functions();
 else if(verb==='support'&&previous.length===2){const engaged=new Set(doc.orders.filter(o=>o.type==='attack').map(o=>o.from));candidates=units(doc.units.filter(u=>unresolved(u)&&(u.affiliation==='friend'||u.affiliation==='assumed')&&u.designation.toUpperCase()!==previous[1].value.toUpperCase()),u=>Number(!engaged.has(u.id)));}
 else if(verb==='halt'&&previous.length===2){const u=doc.units.find(x=>x.designation.toUpperCase()===previous[1].value.toUpperCase());candidates=[...new Set(doc.orders.filter(o=>o.from===u?.id).map(o=>o.type))].map(s=>keyword(s));}
 else if(verb==='cp'&&previous.length===2)candidates=['main','tac','alt','rear','none'].map(s=>keyword(s));
 else if(verb==='new'){
  let identity=false,size=false,fn=false,title=false,sector=false,ring=false,due=false,designation=false;
  for(let i=1;i<previous.length;i++){
   const t=previous[i],k=t.value.toLowerCase();
   if(t.quoted&&!title){title=true;continue;}
   if(k==='in'){if(previous[i+1]?.value==='sector')i++;if(previous[i+1]){sector=true;i++;}continue;}
   if(k==='due'){if(previous[i+1]){due=true;i++;}continue;}
   if(k==='as'){if(previous[i+1]){designation=true;i++;}continue;}
   if(['hq','near','mid','far','beyond'].includes(k)){ring=true;continue;}
   if(!identity&&identityTokens[k])identity=true;
   else if(!size&&sizeTokens[k])size=true;
   else if(!fn&&functionTokens[k])fn=true;
  }
  const optional=[...(!sector?[keyword('in')]:[]),...(!ring?['hq','near','mid','far','beyond'].map(x=>keyword(x)):[]),...(!due?[keyword('due')]:[]),...(!designation?[keyword('as')]:[])];
  if(before==='as') {candidates=[];hint='Type a unique designation';}
  else if(!title){
   // Optional slots remain discoverable by prefix, with the next slot first.
   candidates=[...(!identity&&!size&&!fn?identities():[]),...(!size&&!fn?sizes():[]),...(!fn?functions():[]),{insert:'"title"',label:'"title"',detail:'Replace title with your words',kind:'keyword'},...optional];
   if(size&&!fn&&previous.some(t=>t.value==='sec'))hint='sec read as size (section). For Security, add sec again or type security.';
  }else candidates=optional;
 }

 else if(verb==='view')candidates=['commander','staff','detail'].map(s=>keyword(s));
 else if(verb==='sector'&&previous.length===1)candidates=['add','rename','remove','width','size'].map(s=>keyword(s));
 else if(verb==='sector'&&previous.length===2&&previous[1].value.toLowerCase()==='size')candidates=['small','medium','large','xl'].map(s=>keyword(s));
 else if(verb==='sector'&&previous.length===2)candidates=sectors();
 else if(['obj','ea','nai','pl'].includes(verb)&&previous.length===1)candidates=(verb==='pl'?['add','date','remove']:['add','move','join','leave','size','remove']).map(s=>keyword(s));
 else if(['obj','ea','nai','pl'].includes(verb)&&previous.length===2&&['remove','move','date','join','leave','size'].includes(previous[1].value.toLowerCase()))
  candidates=doc.measures.filter(m=>m.type===verb).map(m=>({insert:/\s/.test(m.name)?JSON.stringify(m.name):m.name,label:`${verb.toUpperCase()} ${m.name}`,kind:'keyword' as const}));
 else if(['obj','ea','nai'].includes(verb)&&previous[1]?.value.toLowerCase()==='move'&&previous.length>=3&&before!=='near')candidates=[...(previous.length===3?[keyword('to')]:[]),...['hq','near','mid','far'].map(s=>keyword(s))];
 else if(['obj','ea','nai'].includes(verb)&&previous[1]?.value.toLowerCase()==='move'&&before==='near')candidates=units();
 else if(['obj','ea','nai'].includes(verb)&&previous[1]?.value.toLowerCase()==='size'&&previous.length===3)candidates=['small','medium','large','xl'].map(s=>keyword(s));
 else if(['obj','ea','nai'].includes(verb)&&['join','leave'].includes(previous[1]?.value.toLowerCase()??'')&&previous.length>=3){
  const area=doc.measures.find(m=>m.type===verb&&m.name.toUpperCase()===previous[2].value.toUpperCase().replace(/^"|"$/g,''));
  const leaving=previous[1].value.toLowerCase()==='leave',inside=new Set(area?.members??[]);
  candidates=units().filter(c=>!c.unitId||(leaving?inside.has(c.unitId):!inside.has(c.unitId)));
 }
 else if(verb==='pl'&&previous[1]?.value.toLowerCase()==='date'&&previous.length===3)candidates=dates();
 else if(verb==='bda'&&previous.length===2){
  const conditions:Record<string,string>={fc:'fully capable',dmg:'damaged (slash)',des:'destroyed (X)',full:'full to capacity'};
  candidates=['100%','75%','50%','25%','0%','fc','dmg','des','full'].map(s=>({...keyword(s),label:conditions[s]?`${s} · ${conditions[s]}`:s}));
  hint=`now ${source?.strength===undefined?'not assessed':`${source.strength}% (${source.strength>=85?'green':source.strength>=70?'amber':source.strength>=50?'red':'black'})`}`;
 }

 else if(verb==='axis'&&previous.length>=2){
  // /axis ‹unit› to [obj] ‹objective› [via [pl] ‹phase line›[, [pl] ‹phase line›…]]
  const words=previous.map(t=>t.value.toLowerCase());
  const named=(type:'obj'|'pl',prefix:string)=>doc.measures.filter(m=>m.type===type).map(m=>({insert:/\s/.test(m.name)?JSON.stringify(m.name):m.name,label:`${prefix} ${m.name}`,detail:m.date?.slice(0,10),kind:'keyword' as const}));
  if(words.includes('via'))candidates=before==='via'||before===','||before==='pl'?named('pl','PL'):[keyword(',')];
  else if(previous.length===2)candidates=[keyword('to')];
  else if(before==='to'||before==='obj')candidates=named('obj','OBJ');
  else candidates=[keyword('via')];
 }
 else if(verb==='sitrep')candidates=[keyword('copy')];
 else if(verb==='attack'&&previous.length>=3)candidates=['main','support','planned'].map(s=>keyword(s));
 else if(['note','rename','intent'].includes(verb)&&((verb==='intent')||previous.length>=2))candidates=[];
 else if(['turn','undo','redo','export','import','help'].includes(verb))candidates=[];
 else {
  candidates=units();
  if(previous.length===1){
   if(verb==='unblock')candidates=units(doc.units.filter(u=>u.lifecycle==='blocked'));
   if(verb==='unpin')candidates=units(doc.units.filter(u=>u.posOverride));
   if(verb==='reopen')candidates=units(doc.units.filter(u=>u.lifecycle==='done'||u.lifecycle==='dropped'));
   // The attacker slot: own units first (friend, then assumed), unresolved only.
   if(verb==='attack'||verb==='moving'){const rank=(a:string)=>a==='friend'?0:a==='assumed'?1:2;candidates=units(doc.units.filter(unresolved),u=>rank(u.affiliation),true);}
   if(verb==='bda')candidates=units(doc.units.filter(unresolved),u=>-(Number(['hostile','suspect'].includes(u.affiliation))*2+Number(doc.orders.some(o=>o.to===u.id&&o.type==='attack'))));
   if(verb==='id')candidates=units(doc.units.filter(unresolved),u=>Number(!['pending','unknown'].includes(u.affiliation)));
  }
  if(['attack','moving'].includes(verb)&&previous.length>=2)candidates=threats();
  if(verb==='attach'&&before==='to')candidates=units(doc.units.filter(u=>u.taskForce&&u.id!==source?.id&&unresolved(u)));

  if(['attack','axis','moving'].includes(verb)&&previous.length>=2)candidates.push(...doc.measures.filter(m=>m.type==='obj').map(m=>({insert:JSON.stringify(m.name),label:`${m.type.toUpperCase()} ${m.name}`,kind:'keyword' as const})));
  if(verb==='moving'&&before==='to')candidates.push(keyword('hq'));
  if(verb==='move'&&previous.length===2)candidates.push(...['to','hq','near','mid','far','beyond'].map(s=>keyword(s)));
  if(verb==='moving'&&previous.length===2)candidates=[keyword('to')];
  if(verb==='moving'&&before==='to')candidates.push(keyword('nearest hostile'));
  if(verb==='attach'&&previous.length===2)candidates=[keyword('to')];
  if(verb==='advancing'&&previous.length===2)candidates=[keyword('on')];
  if((verb==='advancing'&&before==='on')||(verb==='moving'&&before==='to'))candidates.unshift(keyword('sector hq'),...doc.sectors.map(s=>({insert:`${/\s/.test(s.name)?JSON.stringify(s.name):s.name} hq`,label:`${s.name} HQ`,kind:'keyword' as const})));
 }
 const query=(previous.length===0?fragment.replace(/^\//,''):fragment).toLowerCase();
 const ranked=candidates.filter(c=>c.insert.toLowerCase().includes(query)||c.label.toLowerCase().includes(query)).sort((a,b)=>Number(!a.insert.toLowerCase().startsWith(query))-Number(!b.insert.toLowerCase().startsWith(query)));
 return {items:ranked,ghost:hint||SYNTAX[verb]||'Type / for commands'};
}
