import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { aliases, helpText, parse, SYNTAX, VERBS } from '../src/core/commands/grammar';
import { sitrepText } from '../src/core/commands/sitrep';
import { resolveUnit } from '../src/core/commands/resolve';
import { ringForRadius } from '../src/core/model/geometry';
import type { Unit } from '../src/core/model/types';
import type { Maps } from './maps';
import type { User } from './db';
import type { VikunjaSync } from './vikunja/sync';
import { VK_REQUESTS } from '../src/core/commands/apply';
/**
 * Verbs the browser shell answers itself instead of sending an op, and what opsmap_command does for each.
 * Every other verb is an op (MUTATION_VERBS in hub.ts) and runs exactly as the command bar sends it.
 * tests/server/mcp-parity.test.ts fails when a verb is in neither list.
 */
export const CLIENT_ONLY:Readonly<Record<string,string>>={
  find:'Returns the unit as opsmap_query lists it (unit), the control measure (measure: type, name, sector, ring, size, members, date) or the sector (sector: name, width, units), with the log LOCATE ‹name›. The bar selects it and opens its sidebar view, centering a unit or area.',
  sitrep:'Returns the SITREP as text; /sitrep copy returns the same text. The bar opens or copies it.',
  export:'Returns the map document as doc. The bar downloads it as JSON.',
  import:'Administrators use the opsmap_import tool with the document; others get the bar’s refusal. The bar opens a file picker.',
  help:'Returns the syntax (every verb, or the one named) as syntax, the log naming it. The bar opens the legend. opsmap_help is the same.',
  map:'Lists the maps (log MAPS: …) or names one (log MAP ‹name›). MCP has no open map: pass map to the other tools. The bar switches to it.',
  view:'Refused: the view is each browser’s display setting, not part of the shared map.',
  turn:'Refused with the bar’s error: the server runs each map’s morning turn.',
  undo:'Undoes this token’s own last change; each token has its own undo history.',
  redo:'Redoes this token’s last undo.',
};
const row=(u:Unit)=>({designation:u.designation,title:u.title,affiliation:u.affiliation,fn:u.fn,echelon:u.echelon,lifecycle:u.lifecycle,ring:ringForRadius(u.pos.r),due:u.dueAt,strength:u.strength,sector:u.sectorId});
export async function mcpRequest(request:Request,maps:Maps,user:User,agent?:{id:string;name:string},vikunja?:VikunjaSync,admin=false):Promise<Response> {
  const server=new McpServer({name:'opsmap',version:'2.1.0'},{instructions:'There can be several shared maps; opsmap_maps lists them. Every tool takes an optional map (id or name) and uses the default (first) map without one. opsmap_command takes the same text as the command bar; pass selected (a unit) where the bar would have one selected. Use unit designations in commands. Prefer /new pending when identity is uncertain. opsmap_map_create, opsmap_map_rename, opsmap_map_delete (administrator) and opsmap_import (administrator) manage maps as the map switcher does. All writes affect the shared maps and are attributed to your token user.'});
  const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
  const map=z.string().max(128).optional().describe('Map id or name; the default map when omitted');
  const failure=(error:unknown)=>result({ok:false,error:error instanceof Error?error.message:'Command failed',at:0});
  const refuse=(error:string)=>failure(new Error(error));
  const listed=()=>maps.list().map((m,i)=>({id:m.id,name:m.name,default:i===0,units:maps.get(m.id)?.doc.units.length??0}));
  const listing=(id:string)=>listed().find(m=>m.id===id)!;
  const document=z.record(z.string(),z.unknown());
  server.registerTool('opsmap_maps',{description:'List the shared maps. The first one is the default.',inputSchema:{}},async()=>result(listed()));
  server.registerTool('opsmap_command',{description:'Execute a slash command on a shared map, exactly as typed in the command bar.',inputSchema:{text:z.string().min(1).max(16384),map,
    selected:z.string().max(128).optional().describe('A unit (designation, title or id) to treat as selected, as in the command bar: an unclear unit name prefers its sector, and /new without in ‹sector› uses its sector')}},async({text,map,selected})=>{
    let hub;try{hub=maps.resolve(map);}catch(error){return failure(error);}
    let selectedId:string|undefined;
    if(selected){try{selectedId=resolveUnit(selected,hub.doc).id;}catch(error){return refuse(`Selected unit: ${error instanceof Error?error.message:'unknown'}`);}}
    const now=new Date(),parsed=parse(text,hub.doc,{now,selectedId,vikunja:Boolean(vikunja)});if(!parsed.ok)return result(parsed);
    const {verb,args}=parsed.cmd,log=parsed.preview;
    try {
      if(verb==='vk'&&vikunja&&(VK_REQUESTS as readonly string[]).includes(String(args.action)))return result({ok:true,log:await vikunja.request(hub.mapId,args,user,'mcp')});
      switch(verb) {
        case 'find': {
          const doc=hub.doc,des=(id:string)=>doc.units.find(u=>u.id===id)?.designation??id;
          if(args.measure!==undefined){const m=doc.measures.find(x=>x.id===args.measure)!;return result({ok:true,log,measure:{type:m.type,name:m.name,sector:m.sectorId,ring:m.pos?ringForRadius(m.pos.r):undefined,size:m.size,members:m.members?.map(des),date:m.date}});}
          if(args.sectorId!==undefined){const s=doc.sectors.find(x=>x.id===args.sectorId)!;return result({ok:true,log,sector:{name:s.name,width:s.widthDeg,units:doc.units.filter(u=>u.sectorId===s.id).map(u=>u.designation)}});}
          return result({ok:true,log,unit:row(doc.units.find(u=>u.id===args.unit)!)});
        }
        case 'sitrep':return result({ok:true,log,text:sitrepText(hub.doc,now)});
        case 'export':return result({ok:true,log,doc:hub.doc});
        case 'help':return result({ok:true,log,syntax:typeof args.verb==='string'?SYNTAX[args.verb]:SYNTAX});
        case 'map': {
          if(args.name===undefined){const all=listed();return result({ok:true,log:`MAPS: ${all.map(m=>m.name).join(', ')}`,maps:all});}
          const found=listing(maps.resolve(String(args.name)).mapId);return result({ok:true,log:`MAP ${found.name.toUpperCase()}`,map:found});
        }
        case 'view':return refuse('/view changes only the browser display: it has no effect over MCP');
        case 'turn':return refuse('/turn is not available here');
        case 'import':return refuse(admin?'Use opsmap_import with the document':'Only the administrator can import a map');
      }
      const op=verb==='undo'||verb==='redo'?hub.undo(user.id,randomUUID(),verb==='redo','mcp',agent):hub.submit(user.id,'mcp',randomUUID(),parsed.cmd,now,agent);
      return result({ok:true,log:op.log,preview:parsed.preview});
    }catch(error){return failure(error);}
  });
  server.registerTool('opsmap_query',{description:'Query units with optional filters.',inputSchema:{map,sector:z.string().optional(),affiliation:z.string().optional(),lifecycle:z.string().optional(),ring:z.string().optional(),text:z.string().optional()}},async q=>{let hub;try{hub=maps.resolve(q.map);}catch(error){return failure(error);}return result(hub.doc.units.filter(u=>(!q.sector||u.sectorId===q.sector||hub.doc.sectors.find(s=>s.id===u.sectorId)?.name.toLowerCase()===q.sector.toLowerCase())&&(!q.affiliation||u.affiliation===q.affiliation)&&(!q.lifecycle||u.lifecycle===q.lifecycle)&&(!q.ring||ringForRadius(u.pos.r)===q.ring)&&(!q.text||`${u.designation} ${u.title} ${u.note??''}`.toLowerCase().includes(q.text.toLowerCase()))).map(row));});
  server.registerTool('opsmap_sitrep',{description:'Current situation report.',inputSchema:{map}},async q=>{try{return result(sitrepText(maps.resolve(q.map).doc,new Date()));}catch(error){return failure(error);}});
  server.registerTool('opsmap_help',{description:'Strict command grammar: every verb, or one verb (aliases and a leading / are accepted).',inputSchema:{verb:z.string().optional()}},async({verb})=>{
    if(!verb)return result(SYNTAX);
    const typed=verb.trim().replace(/^\//,'').toLowerCase(),v=aliases[typed]??typed;
    return result((VERBS as readonly string[]).includes(v)?{verb:v,syntax:SYNTAX[v],help:helpText(v)}:{verb:typed,syntax:'Unknown verb'});
  });
  // Map management, with the HTTP API's rules (POST/PATCH/DELETE /api/maps, POST /api/import).
  server.registerTool('opsmap_map_create',{description:'Create a shared map: empty (five standard sectors), a copy of an existing map (from), or from an exported document (doc). Any user may, as in the map switcher.',inputSchema:{
    name:z.string().max(128).optional().describe('The new map’s name (1–60 characters); with from it defaults to “‹source› copy”'),
    from:z.string().max(128).optional().describe('Map id or name to duplicate (its Vikunja binding is not copied)'),
    doc:document.optional().describe('An exported map document to start from')}},async q=>{
    try {
      if(q.from!==undefined&&q.doc!==undefined)throw new Error('Pass from or doc, not both');
      const source=q.from===undefined?undefined:maps.resolve(q.from);
      const name=q.name??(source?maps.uniqueName(`${listing(source.mapId).name} copy`):undefined);
      const info=maps.create(user.id,name,source?source.doc:q.doc,new Date(),'mcp',agent);
      return result({ok:true,map:listing(info.id)});
    }catch(error){return failure(error);}
  });
  server.registerTool('opsmap_map_rename',{description:'Rename a shared map.',inputSchema:{map:z.string().max(128).describe('Map id or name'),name:z.string().max(128).describe('The new name (1–60 characters)')}},async q=>{
    try{const hub=maps.resolve(q.map);maps.rename(hub.mapId,q.name);return result({ok:true,map:listing(hub.mapId)});}catch(error){return failure(error);}
  });
  server.registerTool('opsmap_map_delete',{description:'Administrator only: delete a shared map, its units and its history, for everyone. The last map cannot be deleted.',inputSchema:{map:z.string().max(128).describe('Map id or name')}},async q=>{
    if(!admin)return refuse('Administrator required');
    try{const hub=maps.resolve(q.map),info=listing(hub.mapId);maps.remove(hub.mapId);return result({ok:true,deleted:{id:info.id,name:info.name}});}catch(error){return failure(error);}
  });
  server.registerTool('opsmap_import',{description:'Administrator only: replace a map with an exported document, for everyone (the bar’s /import). Undo reverses it.',inputSchema:{map,doc:document.describe('An exported map document')}},async q=>{
    if(!admin)return refuse('Only the administrator can import a map');
    try{const op=maps.resolve(q.map).import(user.id,q.doc,new Date(),'mcp',agent);return result({ok:true,log:op.log});}catch(error){return failure(error);}
  });
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try {return await transport.handleRequest(request);}finally{await transport.close();await server.close();}
}
