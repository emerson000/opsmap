import { getDoc } from '../model/store.svelte';
import { dispatch } from './dispatch';
import { advanceDay, type Trail, type Crossing } from '../../core/commands/turn';
import { localDay } from '../../core/commands/tokenize';
export * from '../../core/commands/turn';
export const turnState:{trails:Trail[];crossings:Crossing[];date?:string}={trails:[],crossings:[]};
export function runTurnIfDue(now:Date=new Date()):{ran:boolean;advanced:number;crossings:Crossing[]} {
 const result=advanceDay(getDoc(),now);
 if(result.doc===getDoc())return {ran:false,advanced:0,crossings:[]};
 const dispatched=dispatch({verb:'turn',args:{now:now.toISOString()}});
 if(!dispatched.ok)return {ran:false,advanced:0,crossings:[]};
 turnState.trails=result.trails;turnState.crossings=result.crossings;turnState.date=localDay(now);
 return {ran:true,advanced:result.advanced,crossings:result.crossings};
}
