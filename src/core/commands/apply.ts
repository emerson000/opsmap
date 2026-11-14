import ms from 'milsymbol';
import type { Affiliation, Command, CommandPost, ControlMeasure, Sector, Doc, Echelon, FunctionKey, Order, Ring, Unit, Touched } from '../model/types';
import { designationFrom, effectiveCondition } from '../model/derive';
import { ECHELONS, echelonIndex } from '../model/echelon';
import { FUNCTIONS } from '../model/functions';
import { AO_SIZES, AREA_SIZES, RING_R, RING_ORDER, orderRing, ringIndex, ringName, aoScale, aoSizeName, placementFits, areaShape, freeSpot, polarToXY, resolvePlacement, ringForRadius, normalizeDeg, radiusForDate, sectorAt, snap, xyToPolar, type AreaSize } from '../model/geometry';
import { importJson } from '../model/json';
import { cloneDoc } from '../model/clone';
import { advanceDay, completeRingOrders } from './turn';
import { CommandError, localDay } from './tokenize';
import { unresolved } from './resolve';
import { helpText } from './syntax';
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
/** Attach `child` to `parent`, which becomes a task force. Attached replaces support: a support order from the child
 *  to its new task force is removed. Returns the log suffix for that, and for joining a collapsed task force. */
function attach(doc:Doc,child:Unit,parent:Unit):string {
  requireThat(child.id!==parent.id,'A unit cannot attach to itself');
  let ancestor:Unit|undefined=parent;
  const visited=new Set<string>();
  while(ancestor){requireThat(ancestor.id!==child.id&&!visited.has(ancestor.id),'Attachment would create a cycle');visited.add(ancestor.id);ancestor=doc.units.find(u=>u.id===ancestor?.parentId);}
  const moved=child.parentId!==parent.id;child.parentId=parent.id;parent.taskForce=true;
  const support=doc.orders.some(o=>o.type==='support'&&o.from===child.id&&o.to===parent.id);
  if(support)doc.orders=doc.orders.filter(o=>!(o.type==='support'&&o.from===child.id&&o.to===parent.id));
  const hidden=moved?collapsedOver(doc,child):undefined;
  return `${support?' — SUPPORT ENDED':''}${hidden?` — HIDDEN IN COLLAPSED TF ${hidden.designation}`:''}`;
}
/** The outermost collapsed task force above a unit (the symbol that stands for it on the map), if any. */
export function collapsedOver(doc:Doc,u:Unit):Unit|undefined {
  let found:Unit|undefined,at=u.parentId?doc.units.find(x=>x.id===u.parentId):undefined;const seen=new Set<string>();
  while(at&&!seen.has(at.id)){seen.add(at.id);if(at.collapsed)found=at;at=at.parentId?doc.units.find(x=>x.id===at!.parentId):undefined;}
  return found;
}
/** Every unit attached under a task force, at any depth. */
export function attachedUnder(doc:Doc,tf:Unit):Unit[] {
  const out=new Set<string>([tf.id]);
  for(let grew=true;grew;){grew=false;for(const u of doc.units)if(u.parentId&&out.has(u.parentId)&&!out.has(u.id)){out.add(u.id);grew=true;}}
  out.delete(tf.id);return doc.units.filter(u=>out.has(u.id));
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
    const source=doc.units.find(u=>u.id===order.from);if(!source||order.type==='support')continue;
    const target=order.to.startsWith('hq:')?{sectorId:order.to.slice(3)}:doc.units.find(u=>u.id===order.to)??doc.measures.find(m=>m.id===order.to);
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
    /** A unit that could not get full spacing: suggest the next AO size up. */
    const crowded=(u:Unit)=>{
      if(placementFits(doc,u.sectorId,u.pos,u.id))return '';
      const next=(['large','xl'] as const).find(k=>AO_SIZES[k]>aoScale(doc));
      return next?` — BAND FULL: TRY /ao size ${next}`:' — BAND FULL';
    };
    /** Orders that a sector change leaves crossing a boundary are cancelled; returns their log suffix. */
    const cancelBoundary=(moved:Unit[],measureIds:string[]=[]):string=>{
      const ids=new Set([...moved.map(u=>u.id),...measureIds]);
      const cancelled=doc.orders.filter(o=>{
        if(o.type==='support'||!ids.has(o.from)&&!ids.has(o.to))return false;
        const source=doc.units.find(x=>x.id===o.from);
        const target=o.to.startsWith('hq:')?{sectorId:o.to.slice(3)}:doc.units.find(x=>x.id===o.to)??doc.measures.find(x=>x.id===o.to);
        return source&&!source.taskForce&&target?.sectorId&&source.sectorId!==target.sectorId;
      });
      doc.orders=doc.orders.filter(o=>!cancelled.some(c=>c.id===o.id));
      return cancelled.map(order=>`; ${order.type.toUpperCase()} ON ${doc.units.find(x=>x.id===order.to)?.designation??doc.measures.find(m=>m.id===order.to)?.name??(order.to.startsWith('hq:')?`${doc.sectors.find(x=>x.id===order.to.slice(3))?.name.toUpperCase()??''} HQ`:'HQ')} CANCELLED (BOUNDARY)`).join('');
    };
    /** A task force left with no attached unit is a regular unit again; orders it held across a sector
     *  boundary are no longer allowed, so they are cancelled. Returns the log suffix. */
    const dissolve=(parentId:string|undefined):string=>{
      const p=parentId===undefined?undefined:doc.units.find(x=>x.id===parentId);
      if(!p||!p.taskForce||doc.units.some(c=>c.parentId===p.id))return '';
      delete p.taskForce;delete p.collapsed;changed(p);
      return ` — TF ${p.designation} DISSOLVED${cancelBoundary([p])}`;
    };
    /** Place a unit by hand: free spot near the requested position, pinned against auto-advance unless `pin` is false. */
    const relocate=(u:Unit,sectorId:string,pos:{r:number;theta:number},pin=true)=>{u.sectorId=sectorId;u.pos=resolvePlacement(doc,sectorId,pos,u.id);if(pin&&u.dueAt)u.posOverride=true;changed(u);};
    const areaOf=(u:Unit)=>doc.measures.find(m=>m.members?.includes(u.id));
    const release=(m:ControlMeasure,id:string)=>{m.members=(m.members??[]).filter(x=>x!==id);if(!m.members.length)delete m.members;};
    const label=(u:Unit)=>`${u.designation} (${u.fn.toUpperCase()} ${u.echelon?.toUpperCase()??'UNK'})`;
    /** The center HQ ('hq'), a sector HQ ('hq:<sector id>'), a ring ('ring:<ring>'), a unit or a control measure. */
    type Target=Unit|ControlMeasure|'hq'|{sectorHq:Sector}|{ring:Ring};
    const hqTarget=(value:unknown):Target|undefined=>{
      if(value==='hq')return 'hq';
      if(typeof value==='string'&&value.startsWith('ring:')){const ring=orderRing(value);requireThat(ring,'Invalid ring');return {ring:ring!};}
      if(typeof value==='string'&&value.startsWith('hq:'))return {sectorHq:item(doc.sectors,value.slice(3),'sector')};
    };
    const setOrder=(source:Unit,target:Target,type:Order['type'],role?:Order['role'])=>{
      requireThat(unresolved(source),'Archived or destroyed units cannot receive orders');
      requireThat(target==='hq'||'sectorHq'in target||'ring'in target||target.id!==source.id,'An order cannot target its own unit');
      if(typeof target==='object'&&'ring'in target){
        // A ring in the unit's own sector: a withdrawal goes out, a move or an advance comes in.
        requireThat(type==='withdraw'||type==='move'||type==='advance','Only moving, advancing and withdraw orders can target a ring');
        const here=ringForRadius(source.pos.r),from=ringIndex(here),to=ringIndex(target.ring);
        requireThat(from!==to,`${source.designation} is already in the ${target.ring} ring`);
        if(type==='withdraw')requireThat(to>from,`Withdraw target must be farther from HQ than ${source.designation}`);
        else requireThat(to<from,`Use /withdraw to move ${source.designation} away from HQ`);
      }else if(type==='withdraw')throw new CommandError('A withdrawal targets a ring: near, mid, far or beyond');
      else if(typeof target==='object'&&'sectorHq'in target){
        requireThat(type==='advance'||type==='move','Only advance and move orders can target a sector HQ');
        requireThat(target.sectorHq.id===source.sectorId||source.taskForce,'Cross-sector orders require a task force');
      }else if(target!=='hq'){
        requireThat(!('lifecycle'in target)||unresolved(target),'Target is archived or destroyed');
        requireThat(!target.sectorId||target.sectorId===source.sectorId||source.taskForce,'Cross-sector orders require a task force');
      }
      if(type==='attack'){
        requireThat(source.affiliation==='friend'||source.affiliation==='assumed','Only friendly units can attack');
        requireThat(target!=='hq'&&!('sectorHq'in target)&&!('ring'in target)&&('affiliation'in target?(target.affiliation==='hostile'||target.affiliation==='suspect'):target.type==='obj'),'Attack target must be a hostile, suspect, or objective');
        if(role==='main')for(const order of doc.orders)if(order.type==='attack'&&order.role==='main'&&doc.units.find(u=>u.id===order.from)?.sectorId===source.sectorId)order.role='support';
        if(a.planned!==true)source.lifecycle='active';
      }
      doc.orders=doc.orders.filter(o=>!(o.from===source.id&&o.type===type));
      // A withdrawal and a movement toward HQ cannot both stand: the new one cancels the other.
      const opposed=(o:Order)=>o.from===source.id&&(type==='withdraw'?o.type==='advance'||o.type==='move':(type==='advance'||type==='move')&&o.type==='withdraw');
      const replaced=doc.orders.filter(opposed);doc.orders=doc.orders.filter(o=>!opposed(o));
      const order:Order={id:uniqueId('o',doc.orders),type,from:source.id,to:target==='hq'?'hq':'sectorHq'in target?`hq:${target.sectorHq.id}`:'ring'in target?`ring:${target.ring}`:target.id,createdAt:at};
      if(role)order.role=role;if(a.planned===true)order.planned=true;
      if(type==='axis'){
        requireThat(target!=='hq'&&'type'in target&&target.type==='obj','Axis requires an objective');
        requireThat(source.affiliation==='friend'||source.affiliation==='assumed','Only friendly units can receive an axis');
        order.via=Array.isArray(a.via)?a.via.map(id=>item(doc.measures,id,'phase line')).map(m=>{requireThat(m.type==='pl','Axis via must be a phase line');return m.id;}):[];
        order.planned=true;
      }
      doc.orders.push(order);changed(source);
      const name=target==='hq'?'HQ':'sectorHq'in target?`${target.sectorHq.name.toUpperCase()} HQ`:'ring'in target?ringName(target.ring):'designation'in target?label(target):`${target.type.toUpperCase()} ${target.name}`;
      log=`${label(source)} ${type==='attack'?'ATTACKS':type==='advance'?'ADVANCES ON':type==='axis'?'AXIS TO':type==='withdraw'?'WITHDRAWS TO':'MOVES TO'} ${name}${role==='main'?' — MAIN EFFORT':role==='support'?' — SUPPORT':''}${order.planned?' — PLANNED':''}${replaced.map(o=>` — ${o.type.toUpperCase()} CANCELLED`).join('')}`;
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
        u.pos=resolvePlacement(doc,u.sectorId,u.pos);doc.units.push(u);const full=crowded(u);log=`CAPTURE ${u.designation} — ${u.affiliation.toUpperCase()} ${FUNCTIONS.find(f=>f.key===u.fn)!.label.toUpperCase()} ${ {tm:'TEAM',sqd:'SQUAD',sec:'SECTION',plt:'PLATOON',coy:'COMPANY',bn:'BATTALION',rgt:'REGIMENT',bde:'BRIGADE',div:'DIVISION',corps:'CORPS',army:'ARMY'}[echelon]} IN ${sector.name.toUpperCase()}`;
        log+=full;
        if(echelonIndex(echelon)>=8)log+=' — Consider a task force with subordinate units';
        break;
      }
      case 'id': {const u=unit(),identity=identities[String(a.affiliation)];requireThat(identity,'Invalid identity');checkPerson(u,identity,a.confirm);u.affiliation=identity;changed(u);log=`${u.designation} ID ${identity.toUpperCase()}`;break;}
      case 'size': {const u=unit(),size=sizes[String(a.echelon)];requireThat(size,'Invalid echelon');if(u.echelon&&size!==u.echelon)u.reinforced=echelonIndex(size)>echelonIndex(u.echelon)?'+':'-';u.echelon=size;changed(u);log=`${u.designation} RESIZED ${size.toUpperCase()}${u.reinforced?` (${u.reinforced})`:''}`;if(echelonIndex(size)>=8&&!u.taskForce&&!doc.units.some(c=>c.parentId===u.id))log+=' — Consider a task force with subordinate units';break;}
      case 'fn': {const u=unit(),fn=functions[String(a.fn)];requireThat(fn,'Invalid function');const kind=fn==='person'?'person':fn==='place'?'place':fn==='event'?'event':'unit';requireThat(kind!=='person'||u.affiliation!=='hostile'||a.confirm===true,'Mark a person hostile? Add confirm to proceed.');u.fn=fn;u.kind=kind;changed(u);log=`${u.designation} FUNCTION ${fn.toUpperCase()}`;break;}
      case 'rename': {const u=unit();u.title=text(a.title,'title');if(a.designation!==undefined){const d=text(a.designation,'designation').toUpperCase();requireThat(/^[A-Z0-9][A-Z0-9_-]*$/.test(d)&&!doc.units.some(other=>other.id!==u.id&&other.designation===d),'Designation must be unique and uppercase');u.designation=d;}changed(u);log=`${u.designation} RENAMED ${u.title}`;break;}
      case 'move': {
        const u=unit(),fromSector=u.sectorId;
        if(a.r!==undefined||a.theta!==undefined){const pos=snap({r:finite(a.r,'radius'),theta:finite(a.theta,'angle')},doc.sectors);if(a.sectorId!==undefined)requireThat(pos.sectorId===a.sectorId,'Position does not belong to the selected sector');u.pos={r:pos.r,theta:pos.theta};u.sectorId=pos.sectorId;}
        else if(a.nearUnit){const target=item(doc.units,a.nearUnit,'unit');u.sectorId=target.sectorId;const sector=item(doc.sectors,u.sectorId,'sector');const theta=normalizeDeg(target.pos.theta+Math.min(5,sector.widthDeg/10));const pos=snap({r:Math.min(4.45,target.pos.r+0.15),theta:sectorAt(theta,doc.sectors)?.id===sector.id?theta:target.pos.theta},doc.sectors);u.pos={r:pos.r,theta:pos.theta};}
        else {const ring=text(a.ring,'ring') as Ring;requireThat(rings.includes(ring),'Invalid ring');const sector=item(doc.sectors,a.sectorId??u.sectorId,'sector');u.sectorId=sector.id;u.pos=freeSpot(doc,sector.id,ring);}
        u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);
        if(u.dueAt)u.posOverride=true;
        changed(u);
        // A member moved to another sector leaves its area instead of stretching it across the map.
        const area=areaOf(u);let left='';
        if(area&&fromSector!==u.sectorId){release(area,u.id);left=`; LEFT ${area.type.toUpperCase()} ${area.name}`;}
        const cancelled=cancelBoundary([u]);
        validOrders(doc);
        log=`MOVE ${u.designation} → ${doc.sectors.find(s=>s.id===u.sectorId)?.name.toUpperCase()} / ${ringForRadius(u.pos.r).toUpperCase()}${u.pos.r>4?' (OFF MAP)':''}${u.posOverride?' — OVERRIDE PIN':''}${cancelled}${left}${crowded(u)}`;
        break;
      }
      case 'attack': {const u=unit(),target=item([...doc.units,...doc.measures],a.target,'target');const role=a.role??'main';requireThat(role==='main'||role==='support','Invalid attack role');setOrder(u,target,'attack',role);break;}
      case 'moving': {const u=unit();const target=hqTarget(a.target)??item([...doc.units,...doc.measures],a.target,'target');if(target!=='hq'&&'affiliation'in target&&(target.affiliation==='hostile'||target.affiliation==='suspect')){const hasMain=doc.orders.some(o=>o.type==='attack'&&o.role==='main'&&doc.units.find(x=>x.id===o.from)?.sectorId===u.sectorId);setOrder(u,target,'attack',hasMain?'support':'main');}else setOrder(u,target,'move');break;}
      case 'axis':setOrder(unit(),item(doc.measures,a.target,'objective'),'axis');break;
      case 'advancing': {const u=unit();requireThat(u.affiliation==='hostile'||u.affiliation==='suspect','Only hostiles or suspects can advance');setOrder(u,hqTarget(a.target)??item(doc.units,a.target,'unit'),'advance');break;}
      case 'withdraw': {
        // Away from HQ, to a ring (default: the next ring out). It shows a trend: the unit's place and due date do not change.
        const u=unit(),here=ringForRadius(u.pos.r);
        requireThat(a.target!==undefined||here!=='beyond',`${u.designation} is already beyond the map edge`);
        setOrder(u,hqTarget(a.target??`ring:${RING_ORDER[ringIndex(here)+1]}`)??item(doc.units,a.target,'ring'),'withdraw');break;
      }
      case 'bda': {
        const u=unit();
        // `clear`: no strength assessed. The condition stays; a destroyed unit stays destroyed.
        if(a.strength===null){requireThat(u.strength!==undefined,`${u.designation} has no strength to clear`);delete u.strength;changed(u);log=`BDA ${u.designation} STRENGTH CLEARED`;break;}
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
      case 'reopen': {
        const u=unit();requireThat(u.lifecycle==='done'||u.lifecycle==='dropped',`${u.designation} is not done or dropped`);
        u.lifecycle='todo';if(u.condition==='destroyed'||u.condition==='fully-capable')u.condition='none';
        if(u.strength===0)delete u.strength;if(u.note==='BYPASSED')delete u.note;
        u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);changed(u);log=`${u.designation} REOPENED`;break;
      }
      case 'vk': return vikunja(doc,cmd,now);
      case 'reinforce':case 'reduce': {const u=unit();u.reinforced=cmd.verb==='reinforce'?'+':'-';let left='';if(a.with){const child=item(doc.units,a.with,'unit'),was=child.parentId;left=attach(doc,child,u);changed(child);if(was!==u.id)left+=dissolve(was);}if(a.note!==undefined)u.note=text(a.note,'scope note');changed(u);log=`${u.designation} ${cmd.verb==='reinforce'?'REINFORCED (+)':'REDUCED (-)'}${left}`;break;}
      case 'attach': {const u=unit(),parent=item(doc.units,a.parent,'parent'),was=u.parentId;const ended=attach(doc,u,parent);changed(u);changed(parent);log=`${u.designation} ATTACHED TO TF ${parent.designation}${ended}${was!==parent.id?dissolve(was):''}`;break;}
      case 'collapse':case 'expand': {
        // Display state stored in the map: a collapsed task force stands for every unit attached under it.
        const fold=cmd.verb==='collapse',open=(x:Unit)=>attachedUnder(doc,x).filter(unresolved).length;
        if(a.all===true){
          const tfs=doc.units.filter(x=>x.taskForce&&Boolean(x.collapsed)!==fold&&doc.units.some(c=>c.parentId===x.id));
          requireThat(tfs.length,fold?'No expanded task force to collapse':'No collapsed task force to expand');
          for(const x of tfs){if(fold)x.collapsed=true;else delete x.collapsed;changed(x);}
          log=`${tfs.length===1?'TF':'TFS'} ${tfs.map(x=>x.designation).join(', ')} ${fold?'COLLAPSED':'EXPANDED'}`;break;
        }
        const u=unit();
        requireThat(u.taskForce&&doc.units.some(c=>c.parentId===u.id),`${u.designation} is not a task force: attach a unit to it first`);
        requireThat(Boolean(u.collapsed)!==fold,`TF ${u.designation} is already ${fold?'collapsed':'expanded'}`);
        if(fold)u.collapsed=true;else delete u.collapsed;changed(u);
        const n=open(u);log=`TF ${u.designation} ${fold?'COLLAPSED':'EXPANDED'} — ${n} ${n===1?'UNIT':'UNITS'}`;break;
      }
      case 'detach': {const u=unit(),was=u.parentId;requireThat(was,`${u.designation} is not attached`);delete u.parentId;changed(u);log=`${u.designation} DETACHED${dissolve(was)}`;break;}
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
      case 'unpin': {
        // Back to the ring its due date gives, keeping its sector and bearing; auto-advance moves it again.
        const u=unit();requireThat(u.posOverride,`${u.designation} is not pinned`);
        delete u.posOverride;
        if(u.dueAt)u.pos=resolvePlacement(doc,u.sectorId,{r:radiusForDate(u.dueAt,now,doc.settings.tz),theta:u.pos.theta},u.id);
        changed(u);log=`${u.designation} UNPINNED → ${ringForRadius(u.pos.r).toUpperCase()}${crowded(u)}`;break;
      }
      case 'due': {const u=unit();if(a.dueAt===null){delete u.dueAt;delete u.posOverride;}else {u.dueAt=date(a.dueAt);u.pos.r=radiusForDate(u.dueAt,now,doc.settings.tz);delete u.posOverride;u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);}changed(u);log=`${u.designation} DUE ${u.dueAt??'NONE'}`;break;}
      case 'note': {const u=unit();requireThat(typeof a.note==='string','Expected note');u.note=a.note;changed(u);log=`${u.designation} NOTE ${u.note}`;break;}
      case 'rate': {const u=unit();requireThat(typeof a.rating==='string'&&/^[A-F][1-6]$/i.test(a.rating),'Rating must be A–F followed by 1–6');u.rating=a.rating.toUpperCase();changed(u);log=`${u.designation} RATED ${u.rating}`;break;}
      case 'support': {
        // A friendly backs another friendly, typically one in contact; sector boundaries do not apply.
        const u=unit(),other=item(doc.units,a.target,'unit');
        const friendly=(x:Unit)=>x.affiliation==='friend'||x.affiliation==='assumed';
        requireThat(u.id!==other.id,'A unit cannot support itself');
        requireThat(friendly(u),'Only friendly units can support');
        requireThat(friendly(other),'Support a friendly unit; to act against a threat use /attack');
        requireThat(unresolved(u)&&unresolved(other),'Support needs two unresolved units');
        requireThat(!doc.orders.some(o=>o.type==='support'&&o.from===other.id&&o.to===u.id),`${other.designation} already supports ${u.designation}`);
        doc.orders=doc.orders.filter(o=>!(o.from===u.id&&o.type==='support'));
        doc.orders.push({id:uniqueId('o',doc.orders),type:'support',from:u.id,to:other.id,createdAt:at});changed(u);
        const sector=(x:Unit)=>doc.sectors.find(s=>s.id===x.sectorId)?.name.toUpperCase()??'';
        log=`${label(u)} SUPPORTS ${label(other)}${u.sectorId!==other.sectorId?` (${sector(u)} → ${sector(other)})`:''}`;break;
      }
      case 'halt': {
        // Cancel the unit's own orders: one by id (the inspector's ✕), one kind, or all of them.
        const u=unit();
        const kinds=['advance','move','attack','axis','link','support','withdraw'];
        requireThat(a.kind===undefined||kinds.includes(String(a.kind)),'Expected advance, move, attack, axis, link, support or withdraw');
        const mine=doc.orders.filter(o=>o.from===u.id&&(a.order===undefined||o.id===a.order)&&(a.kind===undefined||o.type===a.kind));
        requireThat(mine.length,a.order!==undefined?'Unknown order':`${u.designation} has no ${a.kind===undefined?'orders':`${a.kind} order`}`);
        const ids=new Set(mine.map(o=>o.id));
        doc.orders=doc.orders.filter(o=>!ids.has(o.id));
        const named=(o:Order)=>orderRing(o.to)?ringName(orderRing(o.to)!):o.to==='hq'?'HQ':o.to.startsWith('hq:')?`${doc.sectors.find(x=>x.id===o.to.slice(3))?.name.toUpperCase()??''} HQ`:doc.units.find(x=>x.id===o.to)?.designation??(()=>{const m=doc.measures.find(x=>x.id===o.to);return m?`${m.type.toUpperCase()} ${m.name}`:o.to;})();
        changed(u);log=`${u.designation} HALTED: ${mine.map(o=>`${o.type.toUpperCase()} ${o.type==='withdraw'?'TO':'ON'} ${named(o)}`).join('; ')} CANCELLED`;
        break;
      }
      case 'cp': {
        const u=unit();
        if(a.cp===null){requireThat(u.cp,`${u.designation} is not a command post`);delete u.cp;log=`${u.designation} CP REMOVED`;}
        else {requireThat(['main','tac','alt','rear'].includes(String(a.cp)),'Expected main, tac, alt, rear or none');requireThat(u.cp!==a.cp,`${u.designation} is already ${String(a.cp).toUpperCase()} CP`);u.cp=a.cp as CommandPost;log=`${u.designation} CP ${u.cp.toUpperCase()}`;}
        changed(u);break;
      }
      case 'key': {const u=unit();u.keyTerrain=a.value===undefined?!u.keyTerrain:a.value===true;changed(u);log=`${u.designation} KEY TERRAIN ${u.keyTerrain?'MARKED':'CLEARED'}`;break;}
      case 'sector': {
        const action=text(a.action,'sector action');
        if(action==='size'){
          const name=text(a.size,'AO size') as keyof typeof AO_SIZES;requireThat(name in AO_SIZES,'Expected small, medium, large or xl');
          requireThat(aoSizeName(aoScale(doc))!==name,`AO is already ${name.toUpperCase()}`);
          if(name==='medium')delete doc.settings.aoSize;else doc.settings.aoSize=AO_SIZES[name];
          for(const u of doc.units)u.pos=resolvePlacement(doc,u.sectorId,u.pos,u.id);
          log=`AO SIZE ${name.toUpperCase()}`;break;
        }
        if(action==='add'){
          const name=text(a.name,'sector name');requireThat(!doc.sectors.some(s=>s.name.toLowerCase()===name.toLowerCase()),'Sector name already exists');const width=360/(doc.sectors.length+1);doc.sectors.forEach(s=>s.widthDeg*=(360-width)/360);const existing=doc.sectors.reduce((n,s)=>n+s.widthDeg,0);doc.sectors.push({id:uniqueId('sector',doc.sectors),name,startDeg:0,widthDeg:360-existing});
        }else{
          const sector=item(doc.sectors,a.sectorId,'sector');
          if(action==='rename'){const name=text(a.name,'name');requireThat(!doc.sectors.some(s=>s.id!==sector.id&&s.name.toLowerCase()===name.toLowerCase()),'Sector name already exists');sector.name=name;}
          else if(action==='remove'){
            requireThat(doc.sectors.length>1,'Cannot remove the last sector');const occupied=doc.units.some(u=>u.sectorId===sector.id)||doc.measures.some(m=>m.sectorId===sector.id);
            requireThat(!occupied||a.reassign,'Sector contains units or measures; use reassign <sector>');
            if(a.reassign){const target=item(doc.sectors,a.reassign,'reassignment sector');requireThat(target.id!==sector.id,'Reassignment must use another sector');for(const u of doc.units)if(u.sectorId===sector.id){u.sectorId=target.id;u.pos.theta=normalizeDeg(target.startDeg+target.widthDeg/2);changed(u);}for(const m of doc.measures)if(m.sectorId===sector.id){m.sectorId=target.id;if(m.pos)m.pos.theta=normalizeDeg(target.startDeg+target.widthDeg/2);}for(const o of doc.orders)if(o.to===`hq:${sector.id}`)o.to=`hq:${target.id}`;}
            // Orders on the removed sector's HQ go with it (or to the receiving sector's HQ above).
            doc.orders=doc.orders.filter(o=>o.to!==`hq:${sector.id}`);
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
          // Where the area is drawn now: a drag or move shifts that center (members included).
          const from=areaShape(doc,m).center;
          // Area measures stay on the map: hq through far (inside PL QUARTER).
          const maxR=RING_R.far[1]-0.05;
          if(a.r!==undefined||a.theta!==undefined){const pos=snap({r:Math.min(maxR,finite(a.r,'radius')),theta:finite(a.theta,'angle')},doc.sectors);if(a.sectorId!==undefined)requireThat(pos.sectorId===a.sectorId,'Position does not belong to the selected sector');m.pos={r:pos.r,theta:pos.theta};m.sectorId=pos.sectorId;}
          else if(a.nearUnit){const target=item(doc.units,a.nearUnit,'unit');const pos=snap({r:Math.min(maxR,target.pos.r+0.3),theta:target.pos.theta},doc.sectors);m.sectorId=pos.sectorId;m.pos={r:pos.r,theta:pos.theta};}
          else {const ring=text(a.ring,'ring') as Ring;requireThat(['hq','near','mid','far'].includes(ring),'Invalid ring');const sector=item(doc.sectors,a.sectorId??m.sectorId,'sector');m.sectorId=sector.id;m.pos=freeSpot(doc,sector.id,ring);}
          // Members move with their area, keeping their spacing; then each settles into a free spot.
          const members=(m.members??[]).map(id=>doc.units.find(u=>u.id===id)).filter((u):u is Unit=>Boolean(u&&u.lifecycle!=='dropped'));
          if(members.length){
            const target=polarToXY(m.pos!),dx=target.x-from.x,dy=target.y-from.y;
            for(const u of members){const p=polarToXY(u.pos);const s=snap(xyToPolar(p.x+dx,p.y+dy),doc.sectors);u.sectorId=s.sectorId;u.pos={r:s.r,theta:s.theta};}
            for(const u of members)relocate(u,u.sectorId,u.pos);
          }
          // Orders on the area or its members that now cross a sector boundary are cancelled.
          const cancelled=cancelBoundary(members,[m.id]);validOrders(doc);
          const sector=doc.sectors.find(x=>x.id===m.sectorId);
          log=`${type.toUpperCase()} ${m.name} MOVED → ${(sector?.name??m.sectorId??'').toUpperCase()} ${ringForRadius(m.pos!.r).toUpperCase()}${members.length?` WITH ${members.length} UNIT${members.length===1?'':'S'}`:''}${cancelled}`;
        }else if(a.action==='join'||a.action==='leave'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type&&type!=='pl','Only OBJ, EA and NAI areas hold units');
          requireThat(Array.isArray(a.units)&&a.units.length>0&&a.units.length<=50,'Expected one or more units');
          const units=[...new Set(a.units as unknown[])].map(id=>item(doc.units,id,'unit'));
          const at=a.r!==undefined||a.theta!==undefined?snap({r:finite(a.r,'radius'),theta:finite(a.theta,'angle')},doc.sectors):undefined;
          requireThat(!at||units.length===1,'A position applies to one unit');
          const names=units.map(u=>u.designation).join(', ');
          if(a.action==='join'){
            requireThat(units.every(u=>u.lifecycle!=='dropped'),'Dropped units cannot join an area');
            requireThat(units.some(u=>!m.members?.includes(u.id))||at,`Already in ${type.toUpperCase()} ${m.name}`);
            const moved:Unit[]=[];let from='';
            for(const u of units){
              const previous=areaOf(u);
              if(previous&&previous.id!==m.id){release(previous,u.id);from+=`; ${u.designation} LEFT ${previous.type.toUpperCase()} ${previous.name}`;}
              // Joining places the unit but does not pin it: auto-advance still moves a dated unit.
              if(at)relocate(u,at.sectorId,at,false);
              else if(!m.members?.includes(u.id)){
                // Into the area: next to its center, in the sector under that center.
                const center=xyToPolar(areaShape(doc,m).center),sectorId=sectorAt(center.theta,doc.sectors)?.id??m.sectorId??u.sectorId;
                relocate(u,sectorId,center,false);
              }
              if(!m.members?.includes(u.id))m.members=[...(m.members??[]),u.id];
              changed(u);moved.push(u);
            }
            const cancelled=cancelBoundary(moved);validOrders(doc);
            log=`${names} JOINED ${type.toUpperCase()} ${m.name}${from}${cancelled}`;
          }else{
            requireThat(units.every(u=>m.members?.includes(u.id)),`Not in ${type.toUpperCase()} ${m.name}: ${units.filter(u=>!m.members?.includes(u.id)).map(u=>u.designation).join(', ')}`);
            for(const u of units){release(m,u.id);changed(u);}
            let cancelled='';
            if(at){relocate(units[0],at.sectorId,at);cancelled=cancelBoundary(units);validOrders(doc);}
            log=`${names} LEFT ${type.toUpperCase()} ${m.name}${cancelled}`;
          }
        }else if(a.action==='size'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type&&type!=='pl','Only OBJ, EA and NAI areas have a size');
          const key=text(a.size,'size').toLowerCase();requireThat(Object.hasOwn(AREA_SIZES,key),'Expected small, medium, large or xl');
          const size=AREA_SIZES[key as AreaSize];requireThat((m.size??AREA_SIZES.medium)!==size,`${type.toUpperCase()} ${m.name} is already ${key}`);
          m.size=size;log=`${type.toUpperCase()} ${m.name} SIZE ${key.toUpperCase()}`;
        }else if(a.action==='date'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type==='pl'&&type==='pl','Only phase lines have a date');
          m.date=date(a.date);log=`PL ${m.name} DATED ${m.date.slice(0,10)}`;
        }else if(a.action==='rename'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type,'Wrong control measure type');
          const name=text(a.name,'name').trim().toUpperCase(),old=m.name;
          requireThat(name!==old.toUpperCase(),`${type.toUpperCase()} ${old} is already named ${name}`);
          requireThat(!doc.measures.some(x=>x.id!==m.id&&x.type===type&&x.name.toUpperCase()===name),'Control measure already exists');
          m.name=name;log=`${type.toUpperCase()} ${old} RENAMED → ${name}`;
        }else if(a.action==='remove'){
          const m=item(doc.measures,a.measure,'control measure');requireThat(m.type===type,'Wrong control measure type');
          // Released members count as changed, so undoing the removal conflicts with their later moves.
          for(const id of m.members??[]){const u=doc.units.find(x=>x.id===id);if(u)changed(u);}
          doc.measures=doc.measures.filter(x=>x.id!==m.id);doc.orders=doc.orders.filter(o=>o.to!==m.id).map(o=>o.via?{...o,via:o.via.filter(id=>id!==m.id)}:o);log=`${type.toUpperCase()} ${m.name} REMOVED`;
        }else{
          requireThat(a.action==='add','Expected add, move, join, leave, size, date, rename, or remove');const name=text(a.name,'name').toUpperCase();requireThat(!doc.measures.some(m=>m.type===type&&m.name.toUpperCase()===name),'Control measure already exists');
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
      case 'find': {
        if(a.measure!==undefined){const m=item(doc.measures,a.measure,'control measure');return {doc:original,log:`LOCATE ${m.type.toUpperCase()} ${m.name}`};}
        if(a.sectorId!==undefined){const sector=item(doc.sectors,a.sectorId,'sector');return {doc:original,log:`LOCATE SECTOR ${sector.name.toUpperCase()}`};}
        const u=unit();return {doc:original,log:`LOCATE ${u.designation}`};
      }
      case 'help':return {doc:original,log:typeof a.verb==='string'?helpText(a.verb):'HELP'};
      // The map list lives on the server: the shell (browser) or the MCP server names the maps.
      case 'map':return {doc:original,log:a.name===undefined?'MAPS':`MAP ${String(a.name).toUpperCase()}`};
      case 'sitrep':case 'export':case 'undo':case 'redo':return {doc:original,log:cmd.verb.toUpperCase()};
      default:throw new CommandError(`Unknown command: ${cmd.verb}`);
    }
    log+=completeRingOrders(doc);
    doc.log.push({id:`log${1+Math.max(0,...doc.log.map(l=>Number(l.id.replace(/^log/,''))||0))}`,at,text:log,...(cmd.raw?{cmd:cmd.raw}:{})});
    return {doc,log};
  }catch(error){return {error:error instanceof Error?error.message:'Invalid command'};}
}

/** /vk actions the server carries out (they call Vikunja); parse checks only their form. */
export const VK_REQUESTS=['bind','sync','status'] as const;
const positiveId=(value:unknown,label:string):number=>{requireThat(Number.isSafeInteger(value)&&(value as number)>0,`Invalid ${label}`);return value as number;};
const threatOf=(u:Unit)=>u.affiliation==='hostile'||u.affiliation==='suspect';
/** Unit lifecycle as a Vikunja status: done and dropped are both "done". */
export type VkStatus='todo'|'active'|'blocked'|'done';
/** Changes pulled from a Vikunja task, already mapped to opsmap fields. */
export interface VkChanges {title?:string;dueAt?:string|null;note?:string;strength?:number;status?:VkStatus;sectorId?:string;affiliation?:Affiliation;}
function pushLog(doc:Doc,at:string,text:string,raw?:string):void {
  doc.log.push({id:`log${1+Math.max(0,...doc.log.map(l=>Number(l.id.replace(/^log/,''))||0))}`,at,text,...(raw?{cmd:raw}:{})});
}
/** `/vk`: the binding and the changes the sync service records. bind, sync and status are requests the server
 *  carries out; it then records `bound`. Pulled changes run as ordinary commands, one log line per task. */
function vikunja(doc:Doc,cmd:Command,now:Date):MutationResult {
  const a=cmd.args,at=now.toISOString(),action=text(a.action,'Vikunja action');
  requireThat(!(VK_REQUESTS as readonly string[]).includes(action),`/vk ${action} runs on the server`);
  const bound=doc.settings.vikunja;
  if(action==='bound'){
    const project=positiveId(a.project,'Vikunja project'),title=text(a.title,'Vikunja project title');
    const sectors=(a.sectors??{}) as Record<string,unknown>;requireThat(typeof sectors==='object'&&!Array.isArray(sectors),'Invalid sector projects');
    requireThat(!bound||bound.project===project,`Bound to ${bound?.title}: /vk unbind first`);
    doc.settings.vikunja={project,title,...(typeof a.by==='string'&&a.by?{by:a.by}:{})};
    for(const s of doc.sectors)if(sectors[s.id]!==undefined)s.vk=positiveId(sectors[s.id],'sector project');
    pushLog(doc,at,`VIKUNJA BOUND TO ${title.toUpperCase()}`,cmd.raw);return {doc,log:`VIKUNJA BOUND TO ${title.toUpperCase()}`};
  }
  requireThat(bound,'This map is not bound to Vikunja');
  let log='';
  if(action==='unbind'){
    delete doc.settings.vikunja;for(const s of doc.sectors)delete s.vk;for(const u of doc.units)delete u.vk;
    log=`VIKUNJA UNBOUND FROM ${bound.title.toUpperCase()}`;
  }else if(action==='sectors'){
    const sectors=a.sectors as Record<string,unknown>;requireThat(sectors&&typeof sectors==='object','Invalid sector projects');
    const names:string[]=[];
    for(const [id,project] of Object.entries(sectors)){const s=item(doc.sectors,id,'sector');if(project===null)delete s.vk;else s.vk=positiveId(project,'sector project');names.push(s.name.toUpperCase());}
    log=`VIKUNJA SECTORS ${names.join(', ')}`;
  }else if(action==='links'){
    // Bookkeeping only: linking a unit to its task does not count as changing the unit.
    const links=a.links as Record<string,unknown>;requireThat(links&&typeof links==='object','Invalid links');
    let n=0;for(const [id,task] of Object.entries(links)){const u=item(doc.units,id,'unit');if(task===null)delete u.vk;else u.vk=positiveId(task,'Vikunja task');n++;}
    const taken=new Set<number>();for(const u of doc.units)if(u.vk!==undefined){requireThat(!taken.has(u.vk),'A Vikunja task links to one unit');taken.add(u.vk);}
    log=`VIKUNJA LINKED ${n} UNIT${n===1?'':'S'}`;
  }else{
    // add, pull, gone: ordinary commands in sequence on one working copy, logged as one line.
    let cur=doc;const logs:string[]=[];
    const step=(verb:string,args:Record<string,unknown>)=>{const r=mutate(cur,{verb,args},now);if('error'in r)throw new CommandError(r.error);cur=r.doc;cur.log.pop();if(r.log)logs.push(r.log);};
    const get=(id:string)=>item(cur.units,id,'unit');
    const settle=(id:string,status:VkStatus|undefined)=>{
      if(!status)return;let u=get(id);const closed=u.lifecycle==='done'||u.lifecycle==='dropped';
      if(status==='done'){if(!closed)step('done',{unit:id});return;}
      if(closed){step('reopen',{unit:id});u=get(id);}
      if(status==='blocked'&&u.lifecycle!=='blocked'){if(threatOf(u)){u.lifecycle='blocked';u.updatedAt=at;logs.push(`${u.designation} BLOCKED`);}else step('block',{unit:id});return;}
      if(status!=='blocked'&&u.lifecycle!==status){u.lifecycle=status;u.updatedAt=at;logs.push(`${u.designation} ${status==='active'?'ACTIVE':'TO DO'}`);}
    };
    if(action==='add'){
      const task=positiveId(a.task,'Vikunja task');requireThat(!cur.units.some(u=>u.vk===task),'That Vikunja task is already linked');
      const sector=item(cur.sectors,a.sectorId,'sector');
      step('new',{title:text(a.title,'title'),sectorId:sector.id,...(typeof a.dueAt==='string'?{dueAt:a.dueAt}:{}),...(typeof a.affiliation==='string'?{affiliation:a.affiliation}:{})});
      const u=cur.units.at(-1)!;u.vk=task;
      if(typeof a.note==='string'&&a.note.trim())u.note=a.note;
      settle(u.id,a.status as VkStatus|undefined);
      log=`VIKUNJA NEW ${logs[0]?.replace(/^CAPTURE /,'')??u.designation}${logs.length>1?`; ${logs.slice(1).join('; ')}`:''}`;
    }else if(action==='pull'){
      const id=item(cur.units,a.unit,'unit').id,c=(a.changes??{}) as VkChanges;
      // Identity first: whether progress maps to BDA depends on it.
      if(c.affiliation!==undefined&&c.affiliation!==get(id).affiliation)step('id',{unit:id,affiliation:c.affiliation});
      if(c.sectorId!==undefined&&c.sectorId!==get(id).sectorId){
        step('move',{unit:id,sectorId:item(cur.sectors,c.sectorId,'sector').id,ring:ringForRadius(get(id).pos.r)});
        // A sector move pins a dated unit; the sync re-dates it so its ring keeps following the date.
        if(get(id).dueAt&&c.dueAt===undefined)step('due',{unit:id,dueAt:get(id).dueAt});
      }
      if(c.title!==undefined&&c.title!==get(id).title)step('rename',{unit:id,title:c.title});
      if(c.dueAt!==undefined&&c.dueAt!==(get(id).dueAt??null))step('due',{unit:id,dueAt:c.dueAt});
      if(c.note!==undefined&&c.note!==(get(id).note??'')){if(c.note)step('note',{unit:id,note:c.note});else{const u=get(id);delete u.note;u.updatedAt=at;logs.push(`${u.designation} NOTE CLEARED`);}}
      if(c.strength!==undefined&&c.strength!==get(id).strength&&c.status!=='done')step('bda',{unit:id,strength:c.strength});
      settle(id,c.status);
      log=`VIKUNJA: ${logs.join('; ')||`${get(id).designation} IN STEP`}`;
    }else if(action==='gone'){
      const u=item(cur.units,a.unit,'unit');
      if(u.lifecycle!=='done'&&u.lifecycle!=='dropped')step('drop',{unit:u.id});
      delete get(u.id).vk;
      log=`VIKUNJA: ${u.designation} TASK DELETED${logs.length?` — ${logs.join('; ')}`:''}`;
    }else throw new CommandError(`Unknown Vikunja action: ${action}`);
    pushLog(cur,at,log,cmd.raw);return {doc:cur,log};
  }
  pushLog(doc,at,log,cmd.raw);return {doc,log};
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
      // A revert or an import keeps the creator it carries; an import without one keeps the replaced unit's.
      const restores=cmd.verb==='revert'||cmd.verb==='import';
      if(!previous&&(!restores||u.createdBy===undefined))u.createdBy=actor;
      else if(previous&&u.createdBy===undefined&&previous.createdBy!==undefined)u.createdBy=previous.createdBy;
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
