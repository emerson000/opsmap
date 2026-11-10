import {expect,it} from 'vitest';
import {labelSlot,type Box} from '../../src/lib/map/labels';
const intersects=(a:Box,b:Box)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
it('places four amplifier callouts without overlapping frames, HQ, or each other',()=>{
 const occupied:Box[]=[{x:-30,y:-30,width:60,height:60},...Array.from({length:4},(_,i)=>({x:80+i*45,y:40,width:40,height:40}))];
 for(let i=0;i<4;i++){
  const before=[...occupied];const box=labelSlot(100+i*45,60,115,60,occupied);
  expect(before.some(other=>intersects(box,other))).toBe(false);
 }
});
