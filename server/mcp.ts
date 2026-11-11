import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { parse, SYNTAX } from '../src/core/commands/grammar';
import { sitrepText } from '../src/core/commands/sitrep';
import { ringForRadius } from '../src/core/model/geometry';
import type { Maps } from './maps';
import type { User } from './db';
import type { VikunjaSync } from './vikunja/sync';
import { VK_REQUESTS } from '../src/core/commands/apply';
export async function mcpRequest(request:Request,maps:Maps,user:User,agent?:{id:string;name:string},vikunja?:VikunjaSync):Promise<Response> {
  const server=new McpServer({name:'opsmap',version:'2.0.0'},{instructions:'There can be several shared maps; opsmap_maps lists them. Every tool takes an optional map (id or name) and uses the default (first) map without one. Use unit designations in commands. Prefer /new pending when identity is uncertain. All writes affect the shared map and are attributed to your token user.'});
  const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
  const map=z.string().max(128).optional().describe('Map id or name; the default map when omitted');
  const failure=(error:unknown)=>result({ok:false,error:error instanceof Error?error.message:'Command failed',at:0});
  server.registerTool('opsmap_maps',{description:'List the shared maps. The first one is the default.',inputSchema:{}},async()=>result(maps.list().map((m,i)=>({id:m.id,name:m.name,default:i===0,units:maps.get(m.id)?.doc.units.length??0}))));
  server.registerTool('opsmap_command',{description:'Execute a strict slash command on a shared map.',inputSchema:{text:z.string().min(1).max(16384),map}},async({text,map})=>{
    let hub;try{hub=maps.resolve(map);}catch(error){return failure(error);}
    const now=new Date(),parsed=parse(text,hub.doc,{now,vikunja:Boolean(vikunja)});if(!parsed.ok)return result(parsed);
    try {
      if(parsed.cmd.verb==='vk'&&vikunja&&(VK_REQUESTS as readonly string[]).includes(String(parsed.cmd.args.action)))return result({ok:true,log:await vikunja.request(hub.mapId,parsed.cmd.args,user,'mcp')});
      if(['sitrep','help','find','export'].includes(parsed.cmd.verb)) {
        if(parsed.cmd.verb==='sitrep')return result({ok:true,text:sitrepText(hub.doc,now)});
        if(parsed.cmd.verb==='help')return result(SYNTAX);
        if(parsed.cmd.verb==='export')return result(hub.doc);
        return result({ok:true,preview:parsed.preview});
      }
      const op=parsed.cmd.verb==='undo'||parsed.cmd.verb==='redo'?hub.undo(user.id,randomUUID(),parsed.cmd.verb==='redo','mcp',agent):hub.submit(user.id,'mcp',randomUUID(),parsed.cmd,now,agent);
      return result({ok:true,log:op.log,preview:parsed.preview});
    }catch(error){return failure(error);}
  });
  server.registerTool('opsmap_query',{description:'Query units with optional filters.',inputSchema:{map,sector:z.string().optional(),affiliation:z.string().optional(),lifecycle:z.string().optional(),ring:z.string().optional(),text:z.string().optional()}},async q=>{let hub;try{hub=maps.resolve(q.map);}catch(error){return failure(error);}return result(hub.doc.units.filter(u=>(!q.sector||u.sectorId===q.sector||hub.doc.sectors.find(s=>s.id===u.sectorId)?.name.toLowerCase()===q.sector.toLowerCase())&&(!q.affiliation||u.affiliation===q.affiliation)&&(!q.lifecycle||u.lifecycle===q.lifecycle)&&(!q.ring||ringForRadius(u.pos.r)===q.ring)&&(!q.text||`${u.designation} ${u.title} ${u.note??''}`.toLowerCase().includes(q.text.toLowerCase()))).map(u=>({designation:u.designation,title:u.title,affiliation:u.affiliation,fn:u.fn,echelon:u.echelon,lifecycle:u.lifecycle,ring:ringForRadius(u.pos.r),due:u.dueAt,strength:u.strength,sector:u.sectorId})));});
  server.registerTool('opsmap_sitrep',{description:'Current situation report.',inputSchema:{map}},async q=>{try{return result(sitrepText(maps.resolve(q.map).doc,new Date()));}catch(error){return failure(error);}});
  server.registerTool('opsmap_help',{description:'Strict command grammar.',inputSchema:{verb:z.string().optional()}},async({verb})=>result(verb?{verb,syntax:SYNTAX[verb]??'Unknown verb'}:SYNTAX));
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try {return await transport.handleRequest(request);}finally{await transport.close();await server.close();}
}
