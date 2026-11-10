import { Hub } from '../../server/hub';
import { Store } from '../../server/db';
import { SyncEngine } from '../../src/lib/sync/engine';
import { parse } from '../../src/core/commands/grammar';
import { emptyDoc } from '../../src/core/model/seed';
import { parseDate } from '../../src/core/commands/tokenize';
const store=new Store(':memory:'),hub=new Hub(store,'main','America/New_York');
const engine=new SyncEngine({connect:()=>{throw Error('unused');},setTimeout:()=>0,clearTimeout:()=>{}});
engine.receive(JSON.stringify({t:'welcome',me:{id:'human'},users:[],seq:0,doc:emptyDoc('America/New_York')}));
let n=0;
for(const [text,at] of [
 ['/new hostile "Dated item" as HOST due tmw','2026-11-10T02:30:00Z'],
 ['/intent "Zoned calendar"','2026-11-10T03:30:00Z'],
 ['/due HOST 2026-11-11','2026-11-10T07:40:00Z'],
 ['/turn','2026-11-10T09:30:00Z'],
] as const){
 const now=new Date(at),p=parse(text,hub.doc,{now});if(!p.ok)throw Error(p.error);
 const op=hub.submit(text==='/turn'?'system':'human',text==='/turn'?'system':'web',`op${++n}`,p.cmd,now);
 engine.receive(JSON.stringify({t:'op',op}));
}
if(JSON.stringify(engine.doc)!==JSON.stringify(hub.doc))throw Error('Client/server divergence');
const dates=['2026-03-08','2026-11-01','+3d','eom','091530JNOV26'].map(x=>parseDate(x,new Date('2026-03-07T23:30:00Z'),'America/New_York'));
console.log(JSON.stringify({doc:hub.doc,dates}));store.close();
