import type { Doc } from './types';
import { echelonIndex } from './echelon';
export function forceRatio(doc:Doc,hostileId:string):{text:string;under:boolean}|null {
  const hostile=doc.units.find(u=>u.id===hostileId && (u.affiliation==='hostile'||u.affiliation==='suspect'));
  if(!hostile?.echelon) return null;
  const ids=new Set(doc.orders.filter(o=>o.type==='attack' && o.to===hostileId).map(o=>o.from));
  // Units supporting an attacker add their weight, wherever they are.
  for(const o of doc.orders)if(o.type==='support'&&ids.has(o.to))ids.add(o.from);
  const attackers=doc.units.filter(u=>ids.has(u.id) && u.affiliation==='friend' && u.lifecycle!=='done' && u.lifecycle!=='dropped');
  if(!attackers.length || attackers.some(u=>!u.echelon)) return null;
  const friendly=attackers.reduce((sum,u)=>sum+3**echelonIndex(u.echelon!),0);
  const enemy=3**echelonIndex(hostile.echelon);
  const format=(n:number)=>Number(n.toFixed(2)).toString();
  return {text:friendly<=enemy?`1:${format(enemy/friendly)}`:`${format(friendly/enemy)}:1`,under:friendly<enemy/3};
}
