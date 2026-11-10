import type { Doc, FunctionKey, Unit } from './types';
import { radiusForDate, resolvePlacement } from './geometry';
import { parseDate, localDay } from '../commands/tokenize';
export function seedDoc(now:Date=new Date()):Doc {
  const at=now.toISOString();
  const due=(days:number)=>{const wall=new Date(localDay(now)+'T00:00:00Z');wall.setUTCDate(wall.getUTCDate()+days);return parseDate(wall.toISOString().slice(0,10),now);};
  const sectors=['Work','Household','Family','Wellness','Productivity'].map((name,i)=>({id:name.toLowerCase(),name,startDeg:270+i*72,widthDeg:72}));
  const make=(id:string,title:string,sectorId:string,affiliation:Unit['affiliation'],fn:FunctionKey,echelon:Unit['echelon'],r:number,theta:number,extra:Partial<Unit>={}):Unit=>({
    id:id.toLowerCase(),designation:id,title,sectorId,affiliation,fn,echelon,kind:fn==='person'?'person':fn==='place'?'place':fn==='event'?'event':'unit',
    lifecycle:'todo',presence:'present',condition:'none',pos:{r,theta:((theta%360)+360)%360},createdAt:at,updatedAt:at,...extra,
  });
  const units:Unit[]=[
    make('IRS','Tax notice response deadline','household','hostile','fin','coy',radiusForDate(due(11),now),18,{strength:70,dueAt:due(11)}),
    make('IRSRSP','Draft tax response','household','friend','inf','plt',1.35,12,{lifecycle:'active',strength:90}),
    make('RECORDS','Gather supporting records','household','friend','recon','plt',1.45,40,{lifecycle:'active',reinforced:'+'}),
    make('LEAK','Roof leak','household','hostile','eng','plt',radiusForDate(due(3),now),345,{strength:100,dueAt:due(3)}),
    make('PASSPORT','Renew passport','family','friend','trans','sec',2.65,70,{lifecycle:'blocked',note:'Waiting on photo',dueAt:due(24)}),
    make('KNEE','Knee pain after running','wellness','suspect','med','sqd',2.4,154,{rating:'C3',strength:100,dueAt:due(18)}),
    make('LANDLORD','Landlord lease renewal','household','neutral','person',undefined,3.75,24,{dueAt:due(70)}),
    make('HOME','Home','family','friend','place',undefined,1.45,100),
    make('MOVE','Move house','household','friend','trans','div',3.45,48,{taskForce:true,presence:'planned'}),
    make('PACKING','Pack the storage room','household','friend','sup','coy',3.3,356,{parentId:'move',presence:'planned'}),
    make('MOVERS','Moving help offered','household','assumed','trans','coy',3.75,12,{parentId:'move'}),
    make('Q4RPT','Finish quarterly report','work','friend','inf','coy',1.65,314,{lifecycle:'active',strength:85,dueAt:due(4)}),
    make('ESCALATION','Unresolved service escalation','work','hostile','armor','bn',radiusForDate(due(-1),now),280,{strength:100,dueAt:due(-1)}),
    make('BACKLOG','Old inbox backlog','productivity','hostile','inf','sec',1.6,242,{strength:0,condition:'destroyed',lifecycle:'done'}),
    make('SLEEP','Protect sleep schedule','wellness','friend','sec','sqd',1.3,142,{keyTerrain:true,strength:80}),
    make('SCHOOL','School planning meeting','family','neutral','event',undefined,2.9,116,{dueAt:due(29)}),
    make('RUN','Morning walk','wellness','friend','sec','sqd',1.7,179,{lifecycle:'active'}),
    make('TOOLS','Review new tool','work','pending','inf','sec',3.5,333),
    make('FILES','Sort downloaded files','productivity','pending','inf','sec',3.5,231),
    make('WEEKEND','Plan weekend outing','family','pending','inf','sec',3.5,93),
  ];
  for (const unit of units) if (unit.dueAt) unit.pos.r=radiusForDate(unit.dueAt,now);
  for (const unit of units) unit.pos=resolvePlacement({sectors,units} as Doc,unit.sectorId,unit.pos,unit.id);
  return {
    version:1,sectors,units,
    orders:[
      {id:'o-tax-main',type:'attack',from:'irsrsp',to:'irs',role:'main',createdAt:at},
      {id:'o-tax-support',type:'attack',from:'records',to:'irs',role:'support',createdAt:at},
      {id:'o-work-main',type:'attack',from:'q4rpt',to:'escalation',role:'main',createdAt:at},
      {id:'o-escalation',type:'advance',from:'escalation',to:'hq',createdAt:at},
      {id:'o-move-axis',type:'axis',from:'move',to:'obj-settled',via:['pl-launch'],planned:true,createdAt:at},
    ],
    measures:[
      {id:'obj-settled',type:'obj',name:'SETTLED IN',sectorId:'household',pos:{r:2.6,theta:36},size:0.3},
      {id:'ea-saturday',type:'ea',name:'SATURDAY',sectorId:'household',pos:{r:2.45,theta:50},size:0.3},
      {id:'nai-benefits',type:'nai',name:'BENEFITS ENROLLMENT',sectorId:'work',pos:{r:3,theta:295},size:0.35},
      {id:'pl-launch',type:'pl',name:'LAUNCH',date:due(45)},
    ],
    log:[{id:'log-seed',at,text:'DEMO LOADED — 5 SECTORS, 20 UNITS'}],
    settings:{view:'commander',theme:'light',autoAdvance:true},
  };
}

/** The shared map starts empty with the five standard sectors, optionally in a calendar zone. */
export function emptyDoc(tz?:string):Doc {
  return {
    version:1,
    sectors:['Work','Household','Family','Wellness','Productivity'].map((name,i)=>({id:name.toLowerCase(),name,startDeg:270+i*72,widthDeg:72})),
    units:[],orders:[],measures:[],log:[],
    settings:{view:'commander',theme:'light',autoAdvance:true,...(tz?{tz}:{})},
  };
}
