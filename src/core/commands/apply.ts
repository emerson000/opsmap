import ms from 'milsymbol';
import type { Affiliation, Command, ControlMeasure, Doc, Echelon, FunctionKey, Order, Ring, Unit, Touched } from '../model/types';
import { designationFrom, effectiveCondition } from '../model/derive';
import { ECHELONS, echelonIndex } from '../model/echelon';
import { FUNCTIONS } from '../model/functions';
import { RING_R, freeSpot, resolvePlacement, ringForRadius, normalizeDeg, radiusForDate, sectorAt, snap } from '../model/geometry';
import { importJson } from '../model/json';
import { cloneDoc } from '../model/clone';
import { advanceDay } from './turn';
import { CommandError, localDay } from './tokenize';
import { unresolved } from './resolve';
import { restoreInverse, touchedEntities } from '../model/patch';
export type ApplyResult = {doc:Doc;log:string;touched:Touched}|{error:string};
type MutationResult = {doc:Doc;log:string}|{error:string};
export const identities: Record<string,Affiliation>={pending:'pending',pen:'pending',unknown:'unknown',unk:'unknown',assumed:'assumed',afr:'assumed',friend:'friend',fr:'friend',neutral:'neutral',neu:'neutral',suspect:'suspect',sus:'suspect',hostile:'hostile',hos:'hostile'};
export const sizes:Record<string,Echelon>=Object.fromEntries(ECHELONS.flatMap(e=>[[e.key,e.key]]));
Object.assign(sizes,{team:'tm',crew:'tm',squad:'sqd',section:'sec',platoon:'plt',company:'coy',battalion:'bn',regiment:'rgt',group:'rgt',brigade:'bde',division:'div'});
export const functions:Record<string,FunctionKey>=Object.fromEntries(FUNCTIONS.flatMap(f=>[f.key,...f.aliases].map(k=>[k,f.key])));
const rings:Ring[]=['hq','near','mid','far','beyond'];
export function uniqueId(prefix:string,values:readonly {id:string}[]):string {
  const taken=new Set(values.map(v=>v.id));let n=1;while(taken.has(`${prefix}${n}`))n++;return `${prefix}${n}`;
}
function requireThat(value:unknown,message:string):asserts value {if(!value)throw new CommandError(message);}
function text(value:unknown,label:string):string {requireThat(typeof value==='string'&&value.trim().length>0,`Expected ${label}`);return value;}
function item<T extends {id:string}>(values:T[],value:unknown,label:string):T {const found=values.find(v=>v.id===value);requireThat(found,`Unknown ${label}: ${String(value)}`);return found;}
function finite(value:unknown,label:string):number {requireThat(typeof value==='number'&&Number.isFinite(value),`Invalid ${label}`);return value;}
function date(value:unknown):string {const result=text(value,'date');requireThat(Number.isFinite(Date.parse(result)),'Invalid date');return result;}
function checkPerson(u:Unit,identity:Affiliation,confirm:unknown):void {requireThat(u.kind!=='person'||identity!=='hostile'||confirm===true,'Mark a person hostile? The problem is usually the situation, not the person. Add confirm to proceed.');}
function attach(doc:Doc,child:Unit,parent:Unit):void {
  requireThat(child.id!==parent.id,'A unit cannot attach to itself');
  let ancestor:Unit|undefined=parent;
  const visited=new Set<string>();
  while(ancestor){requireThat(ancestor.id!==child.id&&!visited.has(ancestor.id),'Attachment would create a cycle');visited.add(ancestor.id);ancestor=doc.units.find(u=>u.id===ancestor?.parentId);}
  child.parentId=parent.id;parent.taskForce=true;
}
function adjustSectors(doc:Doc,old:Doc):void {
  let start=old.sectors[0]?.startDeg??270;
  for(const sector of doc.sectors){sector.startDeg=normalizeDeg(start);start+=sector.widthDeg;}
  const reposition=(value:{sectorId?:string;pos?:{r:number;theta:number}})=>{
    const sector=doc.sectors.find(s=>s.id===value.sectorId);if(!sector||!value.pos)return;
    const previous=old.sectors.find(s=>s.id===value.sectorId);
    const fraction=previous?Math.max(0.01,Math.min(0.99,normalizeDeg(value.pos.theta-previous.startDeg)/previous.widthDeg)):0.5;
    value.pos.theta=normalizeDeg(sector.startDeg+sector.widthDeg*fraction);
  };
  doc.units.forEach(reposition);doc.measures.forEach(reposition);
}
function validOrders(doc:Doc):void {
  const main=new Set<string>();
  for(const order of doc.orders){
    const source=doc.units.find(u=>u.id===order.from);if(!source)continue;
    const target=doc.units.find(u=>u.id===order.to)??doc.measures.find(m=>m.id===order.to);
    if(target?.sectorId&&target.sectorId!==source.sectorId&&!source.taskForce)throw new CommandError('Cross-sector orders require a task force');
    if(order.type==='attack'&&order.role==='main'){if(main.has(source.sectorId))order.role='support';else main.add(source.sectorId);}
  }
}
function mutate(original:Doc,cmd:Command,now:Date):MutationResult {
  try {
    requireThat(Number.isFinite(now.getTime()),'Invalid transaction time');
    const doc=cloneDoc(original),a=cmd.args,at=now.toISOString();let log='';
    const unit=()=>item(doc.units,a.unit,'unit');
    const changed=(u:Unit)=>{u.updatedAt=at;};
    const label=(u:Unit)=>`${u.designation} (${u.fn.toUpperCase()} ${u.echelon?.toUpperCase()??'UNK'})`;
    const setOrder=(source:Unit,target:Unit|ControlMeasure|'hq',type:Order['type'],role?:Order['role'])=>{
      requireThat(unresolved(source),'Archived or destroyed units cannot receive orders');
      requireThat(target==='hq'||target.id!==source.id,'An order cannot target its own unit');
      if(target!=='hq'){
        requireThat(!('lifecycle'in target)||unresolved(target),'Target is archived or destroyed');
        requireThat(!target.sectorId||target.sectorId===source.sectorId||source.taskForce,'Cross-sector orders require a task force');
      }
      if(type==='attack'){
        requireThat(source.affiliation==='friend'||source.affiliation==='assumed','Only friendly units can attack');
        requireThat(target!=='hq'&&('affiliation'in target?(target.affiliation==='hostile'||target.affiliation==='suspect'):target.type==='obj'),'Attack target must be a hostile, suspect, or objective');
        if(role==='main')for(const order of doc.orders)if(order.type==='attack'&&order.role==='main'&&doc.units.find(u=>u.id===order.from)?.sectorId===source.sectorId)order.role='support';
        if(a.planned!==true)source.lifecycle='active';
      }
      doc.orders=doc.orders.filter(o=>!(o.from===source.id&&o.type===type));
      const order:Order={id:uniqueId('o',doc.orders),type,from:source.id,to:target==='hq'?'hq':target.id,createdAt:at};
      if(role)order.role=role;if(a.planned===true)order.planned=true;
      if(type==='axis'){
        requireThat(target!=='hq'&&'type'in target&&target.type==='obj','Axis requires an objective');
        requireThat(source.affiliation==='friend'||source.affiliation==='assumed','Only friendly units can receive an axis');
        order.via=Array.isArray(a.via)?a.via.map(id=>item(doc.measures,id,'phase line')).map(m=>{requireThat(m.type==='pl','Axis via must be a phase line');return m.id;}):[];
        order.planned=true;
      }
      doc.orders.push(order);changed(source);
      const name=target==='hq'?'HQ':'designation'in target?label(target):`${target.type.toUpperCase()} ${target.name}`;
      log=`${label(source)} ${type==='attack'?'ATTACKS':type==='advance'?'ADVANCES ON':type==='axis'?'AXIS TO':'MOVES TO'} ${name}${role==='main'?' — MAIN EFFORT':role==='support'?' — SUPPORT':''}${order.planned?' — PLANNED':''}`;
    };
    switch(cmd.verb){
      case 'new': {
        const affiliation=identities[String(a.affiliation??'pending')],fn=functions[String(a.fn??'inf')],echelon=sizes[String(a.echelon??'sec')];
        requireThat(affiliation&&fn&&echelon,'Invalid identity, function, or echelon');
        const sector=item(doc.sectors,a.sectorId??doc.sectors.find(s=>s.name==='Household')?.id??doc.sectors[0]?.id,'sector');
        const title=text(a.title??'New unit','title');const designation=a.designation===undefined?designationFrom(a.title===undefined?'':title,new Set(doc.units.map(u=>u.designation))):text(a.designation,'designation').toUpperCase();
        requireThat(/^[A-Z0-9][A-Z0-9_-]*$/.test(designation)&&!doc.units.some(u=>u.designation===designation),'Designation must be unique and use letters, numbers, underscores, or hyphens');
        const ring=(a.ring??'far') as Ring;requireThat(rings.includes(ring),'Invalid ring');
        const kind=fn==='person'?'person':fn==='place'?'place':fn==='event'?'event':'unit';
        const u:Unit={id:uniqueId('u',doc.units),title,designation,kind,affiliation:a.affiliation===undefined&&kind==='person'?'neutral':affiliation,fn,echelon,lifecycle:'todo',presence:'present',condition:'none',sectorId:sector.id,pos:freeSpot(doc,sector.id,ring),createdAt:at,updatedAt:at};
        checkPerson(u,u.affiliation,a.confirm);
        if(a.dueAt){u.dueAt=date(a.dueAt);u.pos.r=radiusForDate(u.dueAt,now,doc.settings.tz);}
        u.pos=resolvePlacement(doc,u.sectorId,u.pos);doc.units.push(u);log=`CAPTURE ${u.designation} — ${u.affiliation.toUpperCase()} ${FUNCTIONS.find(f=>f.key===u.fn)!.label.toUpperCase()} ${ {tm:'TEAM',sqd:'SQUAD',sec:'SECTION',plt:'PLATOON',coy:'COMPANY',bn:'BATTALION',rgt:'REGIMENT',bde:'BRIGADE',div:'DIVISION',corps:'CORPS',army:'ARMY'}[echelon]} IN ${sector.name.toUpperCase()}`;
        if(echelonIndex(echelon)>=8)log+=' — Consider a task force with subordinate units';
        break;
      }
      case 'id': {const u=unit(),identity=identities[String(a.affiliation)];requireThat(identity,'Invalid identity');checkPerson(u,identity,a.confirm);u.affiliation=identity;changed(u);log=`${u.designation} ID ${identity.toUpperCase()}`;break;}
      case 'size': {const u=unit(),size=sizes[String(a.echelon)];requireThat(size,'Invalid echelon');if(u.echelon&&size!==u.echelon)u.reinforced=echelonIndex(size)>echelonIndex(u.echelon)?'+':'-';u.echelon=size;changed(u);log=`${u.designation} RESIZED ${size.toUpperCase()}${u.reinforced?` (${u.reinforced})`:''}`;if(echelonIndex(size)>=8&&!u.taskForce&&!doc.units.some(c=>c.parentId===u.id))log+=' — Consider a task force with subordinate units';break;}
      case 'fn': {const u=unit(),fn=functions[String(a.fn)];requireThat(fn,'Invalid function');const kind=fn==='person'?'person':fn==='place'?'place':fn==='event'?'event':'unit';requireThat(kind!=='person'||u.affiliation!=='hostile'||a.confirm===true,'Mark a person hostile? Add confirm to proceed.');u.fn=fn;u.kind=kind;changed(u);log=`${u.designation} FUNCTION ${fn.toUpperCase()}`;break;}
      case 'rename': {const u=unit();u.title=text(a.title,'title');if(a.designation!==undefined){const d=text(a.designation,'designation').toUpperCase();requireThat(/^[A-Z0-9][A-Z0-9_-]*$/.test(d)&&!doc.units.some(other=>other.id!==u.id&&other.designation===d),'Designation must be unique and uppercase');u.designation=d;}changed(u);log=`${u.designation} RENAMED ${u.title}`;break;}
      case 'move': {
        const u=unit();
        if(a.r!==undefined||a.theta!==undefined){const pos=snap({r:finite(a.r,'radius'),theta:finite(a.theta,'angle')},doc.sectors);if(a.sectorId!==undefined)requireThat(pos.sectorId===a.sectorId,'Position does not belong to the selected sector');u.pos={r:pos.r,theta:pos.theta};u.sectorId=pos.sectorId;}
        else if(a.nearUnit){const target=item(doc.units,a.nearUnit,'unit');u.sectorId=target.sectorId;const sector=item(doc.sectors,u.sectorId,'sector');const theta=normalizeDeg(target.pos.theta+Math.min(5,sector.widthDeg/10));const pos=snap({r:Math.min(4.45,target.pos.r+0.15),theta:sectorAt(theta,doc.sectors)?.id===sector.id?theta:target.pos.theta},doc.sectors);u.pos={r:pos.r,theta:pos.theta};}
        else {const ring=text(a.ring,'ring') as Ring;requireThat(rings.includes(ring),'Invalid ring');const sector=item(doc.sectors,a.sectorId??u.sectorId,'sector');u.sectorId=sector.id;u.pos=freeSpot(doc,sector.id,ring);}
        u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);
        if(u.dueAt)u.posOverride=true;
        changed(u);
        const cancelled=doc.orders.filter(o=>{
          if(o.from!==u.id&&o.to!==u.id)return false;
          const source=doc.units.find(x=>x.id===o.from);
          const target=doc.units.find(x=>x.id===o.to)??doc.measures.find(x=>x.id===o.to);
          return source&&!source.taskForce&&target?.sectorId&&source.sectorId!==target.sectorId;
        });
        doc.orders=doc.orders.filter(o=>!cancelled.some(c=>c.id===o.id));
        validOrders(doc);
        log=`MOVE ${u.designation} → ${doc.sectors.find(s=>s.id===u.sectorId)?.name.toUpperCase()} / ${ringForRadius(u.pos.r).toUpperCase()}${u.pos.r>4?' (OFF MAP)':''}${u.posOverride?' — OVERRIDE PIN':''}`;
        for(const order of cancelled){
          const target=doc.units.find(x=>x.id===order.to)?.designation??doc.measures.find(m=>m.id===order.to)?.name??'HQ';
          log+=`; ${order.type.toUpperCase()} ON ${target} CANCELLED (BOUNDARY)`;
        }
        break;
      }
      case 'attack': {const u=unit(),target=item([...doc.units,...doc.measures],a.target,'target');const role=a.role??'main';requireThat(role==='main'||role==='support','Invalid attack role');setOrder(u,target,'attack',role);break;}
      case 'moving': {const u=unit();const target=a.target==='hq'?'hq':item([...doc.units,...doc.measures],a.target,'target');if(target!=='hq'&&'affiliation'in target&&(target.affiliation==='hostile'||target.affiliation==='suspect')){const hasMain=doc.orders.some(o=>o.type==='attack'&&o.role==='main'&&doc.units.find(x=>x.id===o.from)?.sectorId===u.sectorId);setOrder(u,target,'attack',hasMain?'support':'main');}else setOrder(u,target,'move');break;}
      case 'axis':setOrder(unit(),item(doc.measures,a.target,'objective'),'axis');break;
      case 'advancing': {const u=unit();requireThat(u.affiliation==='hostile'||u.affiliation==='suspect','Only hostiles or suspects can advance');setOrder(u,a.target==='hq'?'hq':item(doc.units,a.target,'unit'),'advance');break;}
      case 'bda': {
        const u=unit();
        if(a.strength!==undefined){const strength=finite(a.strength,'strength');requireThat(strength>=0&&strength<=100,'Strength must be 0–100%');u.strength=strength;if(u.affiliation==='hostile'&&strength===0&&u.condition==='none'){u.condition='destroyed';u.lifecycle='done';}}
        else {const conditions=['none','fully-capable','damaged','destroyed','full'];requireThat(conditions.includes(String(a.condition)),'Invalid condition');u.condition=a.condition as Unit['condition'];if(u.condition==='destroyed')u.lifecycle='done';}
        if(effectiveCondition(u)==='destroyed')doc.orders=doc.orders.filter(o=>o.from!==u.id&&o.to!==u.id);
        changed(u);log=`BDA ${u.designation} ${a.strength!==undefined?`${u.strength}%`:u.condition.toUpperCase()}${effectiveCondition(u)==='destroyed'?' — DESTROYED':''}`;break;
      }
      case 'block': {const u=unit();requireThat(u.affiliation!=='hostile'&&u.affiliation!=='suspect','Use BDA to assess hostiles');u.lifecycle='blocked';if(a.note!==undefined)u.note=text(a.note,'reason');changed(u);log=`${u.designation} BLOCKED${u.note?` — ${u.note}`:''}`;break;}
      case 'unblock': {const u=unit();u.lifecycle=doc.orders.some(o=>o.from===u.id&&o.type==='attack'&&!o.planned)?'active':'todo';if(u.condition==='damaged')u.condition='none';delete u.note;changed(u);log=`${u.designation} UNBLOCKED`;break;}
      case 'done':case 'drop': {
        const u=unit(),targets=doc.orders.filter(o=>o.from===u.id&&o.type==='attack').map(o=>doc.units.find(x=>x.id===o.to)?.designation).filter(Boolean);
        u.lifecycle=cmd.verb==='done'?'done':'dropped';
        if(cmd.verb==='done'){u.condition=u.affiliation==='hostile'?'destroyed':'fully-capable';if(u.affiliation==='hostile')u.strength=0;}
        else if(u.affiliation==='hostile'||a.bypassed)u.note='BYPASSED';
        doc.orders=doc.orders.filter(o=>o.from!==u.id&&o.to!==u.id);changed(u);log=`${u.designation} ${cmd.verb==='done'?(u.affiliation==='hostile'?'DESTROYED':'COMPLETE — WITHDRAW AT NEXT TURN'):'WITHDRAWN'}${targets.length?` — Assess target: ${targets.join(', ')}`:''}`;break;
      }
      case 'reinforce':case 'reduce': {const u=unit();u.reinforced=cmd.verb==='reinforce'?'+':'-';if(a.with){const child=item(doc.units,a.with,'unit');attach(doc,child,u);changed(child);}if(a.note!==undefined)u.note=text(a.note,'scope note');changed(u);log=`${u.designation} ${cmd.verb==='reinforce'?'REINFORCED (+)':'REDUCED (-)'}`;break;}
      case 'attach': {const u=unit(),parent=item(doc.units,a.parent,'parent');attach(doc,u,parent);changed(u);changed(parent);log=`${u.designation} ATTACHED TO TF ${parent.designation}`;break;}
      case 'detach': {const u=unit();delete u.parentId;changed(u);log=`${u.designation} DETACHED`;break;}
      case 'link': {
        const u=unit(),other=item(doc.units,a.target,'unit');
        requireThat(u.id!==other.id,'Link requires two different units');
        requireThat(a.kind===undefined||a.kind==='dependency'||a.kind==='handoff','Invalid link kind');
        requireThat(unresolved(u)&&unresolved(other),'Link units must be unresolved');
        requireThat(u.sectorId===other.sectorId||u.taskForce,'Cross-sector orders require a task force');
        const order:Order={id:uniqueId('o',doc.orders),type:'link',from:u.id,to:other.id,createdAt:at};
        if(a.kind)order.kind=a.kind as Order['kind'];
        doc.orders.push(order);changed(u);
        log=`LINKUP ${u.designation} / ${other.designation}${a.kind?` — ${String(a.kind).toUpperCase()}`:''}`;break;
      }
      case 'due': {const u=unit();if(a.dueAt===null){delete u.dueAt;delete u.posOverride;}else {u.dueAt=date(a.dueAt);u.pos.r=radiusForDate(u.dueAt,now,doc.settings.tz);delete u.posOverride;u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);}changed(u);log=`${u.designation} DUE ${u.dueAt??'NONE'}`;break;}
      case 'note': {const u=unit();requireThat(typeof a.note==='string','Expected note');u.note=a.note;changed(u);log=`${u.designation} NOTE ${u.note}`;break;}
      case 'rate': {const u=unit();requireThat(typeof a.rating==='string'&&/^[A-F][1-6]$/i.test(a.rating),'Rating must be A–F followed by 1–6');u.rating=a.rating.toUpperCase();changed(u);log=`${u.designation} RATED ${u.rating}`;break;}
      case 'key': {const u=unit();u.keyTerrain=a.value===undefined?!u.keyTerrain:a.value===true;changed(u);log=`${u.designation} KEY TERRAIN ${u.keyTerrain?'MARKED':'CLEARED'}`;break;}
      case 'sector': {
        const action=text(a.action,'sector action');
        if(action==='add'){
          const name=text(a.name,'sector name');requireThat(!doc.sectors.some(s=>s.name.toLowerCase()===name.toLowerCase()),'Sector name already exists');const width=360/(doc.sectors.length+1);doc.sectors.forEach(s=>s.widthDeg*=(360-width)/360);const existing=doc.sectors.reduce((n,s)=>n+s.widthDeg,0);doc.sectors.push({id:uniqueId('sector',doc.sectors),name,startDeg:0,widthDeg:360-existing});
        }else{
          const sector=item(doc.sectors,a.sectorId,'sector');
          if(action==='rename'){const name=text(a.name,'name');requireThat(!doc.sectors.some(s=>s.id!==sector.id&&s.name.toLowerCase()===name.toLowerCase()),'Sector name already exists');sector.name=name;}
          else if(action==='remove'){
            requireThat(doc.sectors.length>1,'Cannot remove the last sector');const occupied=doc.units.some(u=>u.sectorId===sector.id)||doc.measures.some(m=>m.sectorId===sector.id);
            requireThat(!occupied||a.reassign,'Sector contains units or measures; use reassign <sector>');
            if(a.reassign){const target=item(doc.sectors,a.reassign,'reassignment sector');requireThat(target.id!==sector.id,'Reassignment must use another sector');for(const u of doc.units)if(u.sectorId===sector.id){u.sectorId=target.id;u.pos.theta=normalizeDeg(target.startDeg+target.widthDeg/2);changed(u);}for(const m of doc.measures)if(m.sectorId===sector.id){m.sectorId=target.id;if(m.pos)m.pos.theta=normalizeDeg(target.startDeg+target.widthDeg/2);}}
            doc.sectors=doc.sectors.filter(s=>s.id!==sector.id);const total=doc.sectors.reduce((n,s)=>n+s.widthDeg,0);doc.sectors.forEach(s=>s.widthDeg*=360/total);
          }else if(action==='width'){
            const width=finite(a.degrees,'sector width');requireThat(width>0&&width<=360&&(doc.sectors.length===1?width===360:width<360),'Sector width must leave space for every sector');const rest=360-sector.widthDeg;for(const s of doc.sectors)s.widthDeg=s.id===sector.id?width:s.widthDeg*(360-width)/rest;
          }else throw new CommandError('Unknown sector action');
        }
        adjustSectors(doc,original);for(const u of doc.units)u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);validOrders(doc);log=`SECTOR ${action.toUpperCase()} ${a.name??original.sectors.find(s=>s.id===a.sectorId)?.name??''}`;break;
      }
      case 'pl':case 'obj':case 'ea':case 'nai': {
        const type=cmd.verb;
        if(a.action==='move'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type,'Wrong control measure type');
          requireThat(type!=='pl','A phase line sits at its date: use /pl date ‹name› ‹date›');
          // Area measures stay on the map: hq through far (inside PL QUARTER).
          const maxR=RING_R.far[1]-0.05;
          if(a.r!==undefined||a.theta!==undefined){const pos=snap({r:Math.min(maxR,finite(a.r,'radius')),theta:finite(a.theta,'angle')},doc.sectors);if(a.sectorId!==undefined)requireThat(pos.sectorId===a.sectorId,'Position does not belong to the selected sector');m.pos={r:pos.r,theta:pos.theta};m.sectorId=pos.sectorId;}
          else if(a.nearUnit){const target=item(doc.units,a.nearUnit,'unit');const pos=snap({r:Math.min(maxR,target.pos.r+0.3),theta:target.pos.theta},doc.sectors);m.sectorId=pos.sectorId;m.pos={r:pos.r,theta:pos.theta};}
          else {const ring=text(a.ring,'ring') as Ring;requireThat(['hq','near','mid','far'].includes(ring),'Invalid ring');const sector=item(doc.sectors,a.sectorId??m.sectorId,'sector');m.sectorId=sector.id;m.pos=freeSpot(doc,sector.id,ring);}
          const sector=doc.sectors.find(x=>x.id===m.sectorId);
          log=`${type.toUpperCase()} ${m.name} MOVED → ${(sector?.name??m.sectorId??'').toUpperCase()} ${ringForRadius(m.pos!.r).toUpperCase()}`;
        }else if(a.action==='date'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type==='pl'&&type==='pl','Only phase lines have a date');
          m.date=date(a.date);log=`PL ${m.name} DATED ${m.date.slice(0,10)}`;
        }else if(a.action==='remove'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type,'Wrong control measure type');doc.measures=doc.measures.filter(x=>x.id!==m.id);doc.orders=doc.orders.filter(o=>o.to!==m.id).map(o=>o.via?{...o,via:o.via.filter(id=>id!==m.id)}:o);log=`${type.toUpperCase()} ${m.name} REMOVED`;
        }else{
          requireThat(a.action==='add','Expected add, move, date, or remove');const name=text(a.name,'name').toUpperCase();requireThat(!doc.measures.some(m=>m.type===type&&m.name.toUpperCase()===name),'Control measure already exists');
          const m:ControlMeasure={id:uniqueId(type,doc.measures),type,name};
          if(type==='pl')m.date=date(a.date);
          else {const sector=item(doc.sectors,a.sectorId,'sector'),ring=(a.ring??'mid') as Ring;requireThat(rings.includes(ring),'Invalid ring');m.sectorId=sector.id;m.pos=freeSpot(doc,sector.id,ring);m.size=0.35;}
          doc.measures.push(m);log=`${type.toUpperCase()} ${name} ESTABLISHED`;
        }break;
      }
      case 'intent': {doc.intent={date:localDay(now,doc.settings.tz),text:text(a.text,'intent')};log=`CDR'S INTENT: ${doc.intent.text}`;break;}
      case 'view': {requireThat(['commander','staff','detail'].includes(String(a.view)),'Invalid view');doc.settings.view=a.view as Doc['settings']['view'];log=`VIEW ${String(a.view).toUpperCase()}`;return {doc,log};}
      case 'turn': {const result=advanceDay(original,now);return {doc:result.doc,log:result.log};}
      case 'sidc': {const u=unit(),code=text(a.sidc,'20-digit SIDC');requireThat(/^130[0-6]\d{16}$/.test(code)&&new ms.Symbol(code,{simpleStatusModifier:true}).isValid(),'Invalid 20-digit SIDC');u.sidcOverride=code;changed(u);log=`${u.designation} SIDC OVERRIDE ${code}`;break;}
      case 'revert': {
        requireThat(Number.isSafeInteger(a.seq)&&Number(a.seq)>0,'Revert requires a positive operation seq');
        return {doc:restoreInverse(original,a.inverse),log:`REVERT OP ${a.seq}`};
      }
      case 'import': {if(a.doc!==undefined)return {doc:importJson(JSON.stringify(a.doc)),log:'DOCUMENT IMPORTED'};if(a.text!==undefined)return {doc:importJson(text(a.text,'JSON document')),log:'DOCUMENT IMPORTED'};return {doc:original,log:'IMPORT'};}
      case 'find': {const u=unit();return {doc:original,log:`LOCATE ${u.designation}`};}
      case 'sitrep':case 'export':case 'help':case 'undo':case 'redo':return {doc:original,log:cmd.verb.toUpperCase()};
      default:throw new CommandError(`Unknown command: ${cmd.verb}`);
    }
    doc.log.push({id:`log${1+Math.max(0,...doc.log.map(l=>Number(l.id.replace(/^log/,''))||0))}`,at,text:log,...(cmd.raw?{cmd:cmd.raw}:{})});
    return {doc,log};
  }catch(error){return {error:error instanceof Error?error.message:'Invalid command'};}
}

/** Apply an already parsed command using the authority's recorded time and actor. */
export function apply(original:Doc,cmd:Command,now:Date=new Date(),actor?:string,via?:string):ApplyResult {
  const result=mutate(original,cmd,now);
  if('error' in result)return result;
  if(actor!==undefined) {
    if(typeof actor!=='string'||!actor.trim())return {error:'Invalid actor'};
    const before=new Map(original.units.map(u=>[u.id,u]));
    for(const u of result.doc.units) {
      const previous=before.get(u.id);
      if(JSON.stringify(previous)===JSON.stringify(u))continue;
      if(!previous&&(cmd.verb!=='revert'||u.createdBy===undefined))u.createdBy=actor;
      u.updatedBy=actor;
    }
  }
  if(result.doc!==original) {
    const known=new Set(original.log.map(l=>l.id));
    if(cmd.verb!=='import')for(const entry of result.doc.log)if(!known.has(entry.id)){if(actor)entry.by=actor;if(via)entry.via=via;}
    result.doc.log=result.doc.log.slice(-2000);
  }
  const touched=touchedEntities(original,result.doc);
  // Import replaces the whole domain, including entity order and unchanged values.
  if(cmd.verb==='import'&&(cmd.args.text!==undefined||cmd.args.doc!==undefined)) {
    for(const key of ['units','orders','measures','sectors'] as const)
      touched[key]=[...new Set([...original[key],...result.doc[key]].map(value=>value.id))];
    touched.top=['version','intent','lastTurn','settings'];
  }
  return {...result,touched};
}
