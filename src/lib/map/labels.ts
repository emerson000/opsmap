export interface Box {x:number;y:number;width:number;height:number;}
type Pt = {x:number;y:number};
const overlaps=(a:Box,b:Box)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const inside=(a:Box,b:Box)=>a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;
/** Distance from a point to the nearest point of a box (0 inside). */
export const boxDistance=(p:Pt,b:Box)=>Math.hypot(Math.max(b.x-p.x,0,p.x-(b.x+b.width)),Math.max(b.y-p.y,0,p.y-(b.y+b.height)));
const OFFSETS=[28,48,72,104,144,192];

export interface SlotOptions {
  /** Symbol centers of every other unit: a box nearer to one of them than to its own symbol reads as theirs. */
  others?: Pt[];
  /** Keep the box inside this rectangle (the visible map, in world units). */
  bounds?: Box;
  /** Largest leader offset, before scaling (phones: 48). */
  maxOffset?: number;
  /** Return null when no candidate is fair (near its own symbol, in bounds): the label is dropped. */
  allowDrop?: boolean;
  /** Boxes a label may never cover (other labels, on phones): such candidates are not fair. */
  hard?: Box[];
}

/**
 * Try the side away from HQ, then the other three sides, then wider leader offsets. A candidate must stay
 * nearer its own symbol than any other symbol, and inside `bounds`. The first free one wins, then the least
 * crowded fair one. With no fair candidate: null when `allowDrop`, else the old right-hand fallback.
 */
export function labelSlot(x:number,y:number,width:number,height:number,occupied:Box[],scale?:number,opts?:SlotOptions&{allowDrop?:false}):Box;
export function labelSlot(x:number,y:number,width:number,height:number,occupied:Box[],scale:number,opts:SlotOptions&{allowDrop:true}):Box|null;
export function labelSlot(x:number,y:number,width:number,height:number,occupied:Box[],scale=1,opts:SlotOptions={}):Box|null {
 const own={x,y},others=opts.others??[];
 // In the outer ring, labels pushed outward run off the map; try inward first there.
 const outward=(x>=0?1:-1)*(opts.bounds&&Math.abs(x)>opts.bounds.width*0.3?-1:1);
 const fair=(box:Box)=>{
  const d=boxDistance(own,box);
  return others.every(o=>boxDistance(o,box)>d+2*scale)&&(!opts.bounds||inside(box,opts.bounds))&&!(opts.hard??[]).some(h=>overlaps(box,h));
 };
 let best:Box|null=null,score=Infinity,fallback:Box={x:x+30*scale,y:y-height/2,width,height};
 const offsets=opts.maxOffset===undefined?OFFSETS:[14,...OFFSETS].filter(o=>o<=opts.maxOffset!);
 for(const offset of offsets){
  const gap=offset*scale,d=gap*0.7;
  const candidates=[{x:outward>0?x+gap:x-gap-width,y:y-height/2,width,height},{x:outward<0?x+gap:x-gap-width,y:y-height/2,width,height},{x:x-width/2,y:y-gap-height,width,height},{x:x-width/2,y:y+gap,width,height}];
  // Phones also try the four diagonals, which often fit between crowded neighbours.
  if(opts.maxOffset!==undefined)candidates.push({x:x+d,y:y-d-height,width,height},{x:x-d-width,y:y-d-height,width,height},{x:x+d,y:y+d,width,height},{x:x-d-width,y:y+d,width,height});
  for(const box of candidates){
   if(!fair(box))continue;
   const count=occupied.filter(o=>overlaps(box,o)).length;
   if(count===0){occupied.push(box);return box;}
   if(count<score){score=count;best=box;}
  }
 }
 if(!best&&opts.allowDrop)return null;
 const chosen=best??fallback;
 occupied.push(chosen);return chosen;
}

export interface LabelInput { id:string; x:number; y:number; lines:string[]; strength?:number; selected:boolean }
export interface PlacedLabel { box:Box; lines:string[]; strength?:number }
/**
 * Place every unit label. Selected labels go first and are never dropped; on phones (`maxOffset`) the others
 * are dropped rather than drawn far from, or nearer another unit than, their own symbol.
 */
export function placeLabels(units:LabelInput[],occupied:Box[],o:{s:number;ls:number;bounds?:Box;maxOffset?:number;symbols?:{id:string;x:number;y:number}[];hard?:Box[]}):Map<string,PlacedLabel> {
 const hard=o.hard?[...o.hard]:undefined;
 const out=new Map<string,PlacedLabel>();
 const ordered=[...units].sort((a,b)=>Number(b.selected)-Number(a.selected));
 for(const u of ordered){
  const width=Math.max(...u.lines.map(l=>l.length),u.strength!==undefined?9:0)*6.6*o.s*o.ls+8*o.s;
  const height=(u.lines.length+(u.strength!==undefined?1:0))*13*o.s*o.ls+6*o.s;
  const others=(o.symbols??units).filter(x=>x.id!==u.id).map(x=>({x:x.x,y:x.y}));
  const box=labelSlot(u.x,u.y,width,height,occupied,o.s,{others,bounds:o.bounds,maxOffset:u.selected?undefined:o.maxOffset,allowDrop:true,hard})
   ??(u.selected?labelSlot(u.x,u.y,width,height,occupied,o.s,{bounds:o.bounds}):null);
  if(box){out.set(u.id,{box,lines:u.lines,strength:u.strength});hard?.push(box);}
 }
 return out;
}
