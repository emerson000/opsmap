import type { Echelon } from './types';
export const ECHELONS: readonly {key:Echelon; code:string; mark:string; range:string}[] = [
  {key:'tm',code:'11',mark:'Ø',range:'≤ 15 min'},
  {key:'sqd',code:'12',mark:'•',range:'15 min–1 h'},
  {key:'sec',code:'13',mark:'••',range:'1–3 h'},
  {key:'plt',code:'14',mark:'•••',range:'3–8 h'},
  {key:'coy',code:'15',mark:'I',range:'1–3 days'},
  {key:'bn',code:'16',mark:'II',range:'1–2 weeks'},
  {key:'rgt',code:'17',mark:'III',range:'2–6 weeks'},
  {key:'bde',code:'18',mark:'X',range:'1–3 months'},
  {key:'div',code:'21',mark:'XX',range:'3–12 months'},
  {key:'corps',code:'22',mark:'XXX',range:'1–3 years'},
  {key:'army',code:'23',mark:'XXXX',range:'multi-year'},
];
export function echelonIndex(e: Echelon): number { return ECHELONS.findIndex(entry=>entry.key===e); }
