import type { FunctionKey } from './types';
export interface FunctionDefinition { key: FunctionKey; label: string; aliases: string[]; entity: string; symbolSet: string; }
export const FUNCTIONS: readonly FunctionDefinition[] = [
  {key:'inf',label:'Infantry',aliases:['infantry','work','backlog'],entity:'121100',symbolSet:'10'},
  {key:'armor',label:'Armor',aliases:['armour','deadline'],entity:'120500',symbolSet:'10'},
  {key:'ca',label:'Combined arms',aliases:['combined','combined-arms'],entity:'121000',symbolSet:'10'},
  {key:'recon',label:'Reconnaissance',aliases:['reconnaissance','research'],entity:'121300',symbolSet:'10'},
  {key:'mi',label:'Military intelligence',aliases:['intelligence','analysis','uncertainty'],entity:'151000',symbolSet:'10'},
  {key:'eng',label:'Engineer',aliases:['engineer','engineering','obstacle'],entity:'140700',symbolSet:'10'},
  {key:'sig',label:'Signal',aliases:['signal','communications'],entity:'111000',symbolSet:'10'},
  {key:'liaison',label:'Liaison',aliases:['relationship'],entity:'110500',symbolSet:'10'},
  {key:'civ',label:'Civil affairs',aliases:['civil','civil-affairs','conflict'],entity:'110200',symbolSet:'10'},
  {key:'med',label:'Medical',aliases:['medical','health','cbrn'],entity:'161300',symbolSet:'10'},
  {key:'mtf',label:'Medical treatment facility',aliases:['treatment','care'],entity:'161400',symbolSet:'10'},
  {key:'fin',label:'Finance',aliases:['finance','money','tax'],entity:'160700',symbolSet:'10'},
  {key:'sup',label:'Supply',aliases:['supply','errands'],entity:'163400',symbolSet:'10'},
  {key:'trans',label:'Transportation',aliases:['transport','transportation','logistics'],entity:'163600',symbolSet:'10'},
  {key:'maint',label:'Maintenance',aliases:['maintenance','upkeep'],entity:'161100',symbolSet:'10'},
  {key:'sec',label:'Security',aliases:['security','routine','habit'],entity:'141700',symbolSet:'10'},
  {key:'ad',label:'Air defense',aliases:['air-defense','defense','insurance'],entity:'130100',symbolSet:'10'},
  {key:'mp',label:'Military police',aliases:['police','legal','compliance'],entity:'141200',symbolSet:'10'},
  {key:'eod',label:'Explosive ordnance disposal',aliases:['hazard','ordnance'],entity:'140800',symbolSet:'10'},
  {key:'sf',label:'Special forces',aliases:['special-forces','side-project'],entity:'121700',symbolSet:'10'},
  {key:'rel',label:'Religious support',aliases:['religious','spiritual','volunteer'],entity:'163100',symbolSet:'10'},
  {key:'learn',label:'Information operations / learning',aliases:['learning','course','information-operations'],entity:'110400',symbolSet:'10'},
  {key:'hq',label:'Headquarters',aliases:['headquarters','command'],entity:'110000',symbolSet:'10'},
  {key:'place',label:'Installation / place',aliases:['installation','house','office'],entity:'120000',symbolSet:'20'},
  {key:'person',label:'Civilian / person',aliases:['civilian','people'],entity:'110000',symbolSet:'11'},
  {key:'event',label:'Activity / event',aliases:['activity','meeting'],entity:'110000',symbolSet:'40'},
];
export const FUNCTION_BY_KEY = Object.fromEntries(FUNCTIONS.map(f=>[f.key,f])) as Record<FunctionKey,FunctionDefinition>;
// The hostile health vocabulary uses contamination rather than a treatment unit.
export const HOSTILE_ENTITIES: Partial<Record<FunctionKey,string>> = {med:'140100'};
