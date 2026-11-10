import { calendarDay, DEFAULT_TZ } from './time';
import type { Doc, Ring, Sector } from './types';
export type Polar = {r:number;theta:number};
export type XY = {x:number;y:number};
export const RING_R = {hq:[0,1],near:[1,2],mid:[2,3],far:[3,4],beyond:[4,4.45]} as const;
export const normalizeDeg = (theta:number):number => ((theta%360)+360)%360;
// Polar angles increase clockwise from the positive x axis, matching SVG coordinates.
export function polarToXY(pos:Polar):XY;
export function polarToXY(r:number,theta:number):XY;
export function polarToXY(pos:Polar|number,theta?:number):XY {
  const p=typeof pos==='number'?{r:pos,theta:theta??0}:pos;
  return {x:p.r*Math.cos(p.theta*Math.PI/180),y:p.r*Math.sin(p.theta*Math.PI/180)};
}
export function xyToPolar(pos:XY):Polar;
export function xyToPolar(x:number,y:number):Polar;
export function xyToPolar(pos:XY|number,y?:number):Polar {
  const p=typeof pos==='number'?{x:pos,y:y??0}:pos;
  return {r:Math.hypot(p.x,p.y),theta:normalizeDeg(Math.atan2(p.y,p.x)*180/Math.PI)};
}
function daysUntil(due:string|Date,now:Date,tz:string):number {
 const day=typeof due==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(due)?Date.parse(due+'T00:00:00Z'):calendarDay(new Date(due),tz);
 if(!Number.isFinite(day)||!Number.isFinite(now.getTime()))throw new Error('Invalid date');
 return (day-calendarDay(now,tz))/86400000;
}
export function ringForDate(due:string|Date|undefined,now:Date=new Date(),tz=DEFAULT_TZ):Ring {
  if(!due) return 'far';
  const d=daysUntil(due,now,tz);
  return d<=0?'hq':d<=7?'near':d<=30?'mid':d<=90?'far':'beyond';
}
export function radiusForDate(due:string|Date|undefined,now:Date=new Date(),tz=DEFAULT_TZ):number {
  if(!due) return 3.5;
  const d=daysUntil(due,now,tz);
  if(d<=0) return Math.max(0.25,0.75+d*0.025);
  if(d<=7) return 1+d/7;
  if(d<=30) return 2+(d-7)/23;
  if(d<=90) return 3+(d-30)/60;
  return 4+Math.min(0.45,(d-90)/90);
}
export function sectorAt(theta:number,sectors:readonly Sector[]):Sector|undefined {
  return sectors.find(s=>s.widthDeg>0 && normalizeDeg(theta-s.startDeg)<s.widthDeg);
}
const angularDistance=(a:number,b:number)=>Math.abs(((a-b+540)%360)-180);
export function snap(pos:Polar,sectors:readonly Sector[]):Polar & {sectorId:string} {
  if(!Number.isFinite(pos.r)||!Number.isFinite(pos.theta)) throw new Error('Position must be finite');
  const valid=sectors.filter(s=>s.widthDeg>0 && Number.isFinite(s.startDeg) && Number.isFinite(s.widthDeg));
  if(!valid.length) throw new Error('No valid sector');
  let theta=normalizeDeg(pos.theta);
  let sector=sectorAt(theta,valid);
  if(!sector) {
    const edges=valid.flatMap(s=>[s.startDeg+0.001,s.startDeg+s.widthDeg-0.001].map(t=>({sector:s,theta:normalizeDeg(t)})));
    edges.sort((a,b)=>angularDistance(a.theta,theta)-angularDistance(b.theta,theta));
    sector=edges[0].sector;theta=edges[0].theta;
  }
  return {r:Math.max(0.15,Math.min(RING_R.beyond[1],pos.r)),theta,sectorId:sector.id};
}
/** Ring boundaries match the map: a phase line belongs to the inner band. */
export function ringForRadius(r:number):Ring {return r<=1?'hq':r<=2?'near':r<=3?'mid':r<=4?'far':'beyond';}

/** Resolve one footprint, preserving its sector and time band. Prefer its dated radius,
 * then search radial offsets in 0.05 steps. HQ penetrators use the outer perimeter arc.
 * The maximum-clearance fallback keeps an overfull wedge usable without changing its time meaning.
 */
export function resolvePlacement(doc:Doc,sectorId:string,requested:Polar,ignoreId?:string,footprint?:number):Polar {
  return placement(doc,sectorId,requested,ignoreId,footprint).pos;
}
/** Whether a unit at `pos` keeps the full spacing from its neighbors (false: its band is overfull at this AO size). */
export function placementFits(doc:Doc,sectorId:string,pos:Polar,ignoreId?:string):boolean {
  return placement(doc,sectorId,pos,ignoreId).fits;
}
function placement(doc:Doc,sectorId:string,requested:Polar,ignoreId?:string,footprint?:number):{pos:Polar;fits:boolean} {
  const sector=doc.sectors.find(s=>s.id===sectorId);
  if(!sector) throw new Error(`Unknown sector: ${sectorId}`);
  // Bigger AO: symbols draw smaller against the rings, so every clearance shrinks by the same factor.
  const k=aoScale(doc);footprint??=0.74/k;
  const ring=ringForRadius(requested.r),[lo,hi]=RING_R[ring];
  const hqMin=Math.max(0.4,0.62/k),hqGap=0.29/k;
  const min=ring==='hq'?hqMin:lo+0.025,max=hi-0.025;
  const radius=ring==='hq'&&requested.r<min?max:Math.max(min,Math.min(max,requested.r));
  const offset=Math.max(2,Math.min(6,sector.widthDeg/12));
  const start=sector.startDeg+offset,end=sector.startDeg+sector.widthDeg-offset;
  const center=sector.startDeg+sector.widthDeg/2;
  const wanted=sector.startDeg+normalizeDeg(requested.theta-sector.startDeg);
  const preferred=ring==='hq'&&requested.r<min?start:wanted<=end?Math.max(start,wanted):center;
  const occupied=doc.units.filter(u=>u.id!==ignoreId&&u.lifecycle!=='dropped').map(u=>({...polarToXY(u.pos),r:u.pos.r}));
  const hqs=doc.sectors.map(s=>polarToXY(1,s.startDeg+s.widthDeg/2));
  const gap=ring==='hq'?Math.min(footprint,0.43/k):footprint;
  const clearance=(p:Polar)=>{
    const xy=polarToXY(p);
    return Math.min(p.r/hqMin,...occupied.map(o=>Math.hypot(xy.x-o.x,xy.y-o.y)/(ring==='hq'&&o.r>1?footprint:gap)),...hqs.map(o=>Math.hypot(xy.x-o.x,xy.y-o.y)/hqGap));
  };
  let best={r:radius,theta:normalizeDeg(preferred)},score=-Infinity;
  const radii=[radius];
  for(let step=1;step<=Math.ceil((max-min)/0.05);step++)for(const sign of [1,-1]){
    const r=radius+step*0.05*sign;if(r>=min&&r<=max)radii.push(r);
  }
  const angles=[preferred];
  for(let a=start;a<=end;a+=2)angles.push(a);
  angles.push(end);angles.sort((a,b)=>Math.abs(a-preferred)-Math.abs(b-preferred));
  for(const r of radii)for(const theta of angles){
    const p={r,theta:normalizeDeg(theta)},value=clearance(p);
    if(value>=1)return {pos:p,fits:true};
    if(value>score){score=value;best=p;}
  }
  return {pos:best,fits:false};
}
export function freeSpot(doc:Doc,sectorId:string,ring:Ring):Polar {
  const sector=doc.sectors.find(s=>s.id===sectorId);
  if(!sector)throw new Error(`Unknown sector: ${sectorId}`);
  const [,hi]=RING_R[ring];
  return resolvePlacement(doc,sectorId,{r:hi-0.05,theta:sector.startDeg+Math.min(6,sector.widthDeg/12)});
}

/** AO sizes for `/ao size`: how much room the rings give each symbol. Medium (1) is the default;
 *  large and xl draw symbols smaller against the rings and pack them closer, small does the reverse. */
export const AO_SIZES={small:0.8,medium:1,large:1.35,xl:1.75} as const;
export type AoSize=keyof typeof AO_SIZES;
export const aoScale=(doc:{settings?:{aoSize?:number}}):number=>doc.settings?.aoSize??1;
/** The preset closest to a scale. */
export function aoSizeName(scale:number|undefined):AoSize {
  const value=scale??1;let best:AoSize='medium';
  for(const key of Object.keys(AO_SIZES) as AoSize[])if(Math.abs(AO_SIZES[key]-value)<Math.abs(AO_SIZES[best]-value))best=key;
  return best;
}

/** Area sizes for `/obj|/ea|/nai size`: the minimum radius in map units. Medium is the default. */
export const AREA_SIZES={small:0.25,medium:0.35,large:0.5,xl:0.7} as const;
export type AreaSize=keyof typeof AREA_SIZES;
export const DEFAULT_AREA_SIZE=AREA_SIZES.medium;
/** Room around a member's center, so the outline encloses its symbol (the renderer widens it when zoomed out). */
export const AREA_MARGIN=0.4;
/** The size preset closest to a radius. */
export function areaSizeName(size:number|undefined):AreaSize {
  const value=size??DEFAULT_AREA_SIZE;
  let best:AreaSize='medium';
  for(const key of Object.keys(AREA_SIZES) as AreaSize[])if(Math.abs(AREA_SIZES[key]-value)<Math.abs(AREA_SIZES[best]-value))best=key;
  return best;
}
/** The units an area holds, in order. `include` filters (e.g. to visible units); dropped units never count. */
export function areaMembers(doc:Pick<Doc,'units'>,m:{members?:string[]},include?:(u:Doc['units'][number])=>boolean) {
  const byId=new Map(doc.units.map(u=>[u.id,u]));
  return (m.members??[]).map(id=>byId.get(id)).filter((u):u is Doc['units'][number]=>Boolean(u&&u.lifecycle!=='dropped'&&(!include||include(u))));
}
/** Drawn center and radius of an area in map units: centered on its members and enclosing them with a margin,
 *  never smaller than its size; without members, its own position and size. */
export function areaShape(doc:Pick<Doc,'units'|'sectors'>,m:Pick<import('./types').ControlMeasure,'pos'|'size'|'members'|'sectorId'>,include?:(u:Doc['units'][number])=>boolean,margin=AREA_MARGIN):{center:XY;radius:number;members:number} {
  const size=m.size??DEFAULT_AREA_SIZE;
  const sector=doc.sectors.find(s=>s.id===m.sectorId);
  const own=polarToXY(m.pos??{r:2.5,theta:sector?sector.startDeg+sector.widthDeg/2:0});
  const members=areaMembers(doc,m,include).map(u=>polarToXY(u.pos));
  if(!members.length)return {center:own,radius:size,members:0};
  const center={x:members.reduce((n,p)=>n+p.x,0)/members.length,y:members.reduce((n,p)=>n+p.y,0)/members.length};
  const reach=Math.max(...members.map(p=>Math.hypot(p.x-center.x,p.y-center.y)));
  return {center,radius:Math.max(size,reach+Math.max(AREA_MARGIN,margin)),members:members.length};
}
