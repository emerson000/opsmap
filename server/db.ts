import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export interface User { id:string; email:string; name:string; initials:string; color:string; emailVerified?:boolean; }
/** One shared map. Every map has its own op journal, snapshots, undo history and daily turn. */
export interface MapInfo { id:string; name:string; createdAt:string; createdBy:string|null; position:number; }
/** An active bearer token as listed to its owner or an administrator: never the secret. */
export interface TokenInfo { id:string; name:string; userId:string; userName:string|null; userEmail:string|null; createdAt:string; lastUsed:string|null; }
export const DEFAULT_MAP='main';
export const hashToken=(token:string)=>createHash('sha256').update(token).digest('hex');
export class Store {
  readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT,name TEXT,initials TEXT,color TEXT,created_at TEXT,last_seen TEXT);
      CREATE TABLE IF NOT EXISTS ops(seq INTEGER PRIMARY KEY,op_id TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,source TEXT NOT NULL,at TEXT NOT NULL,cmd TEXT NOT NULL,log TEXT NOT NULL,inverse TEXT NOT NULL,undone_by INTEGER,reverts INTEGER);
      CREATE TABLE IF NOT EXISTS snapshots(seq INTEGER PRIMARY KEY,doc TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT,expires_at TEXT);
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,name TEXT UNIQUE,user_id TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT,last_used TEXT,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1');`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const columns=(table:string)=>(this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name);
    if(!columns('users').includes('email_verified'))this.db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    if(!columns('ops').includes('principal'))this.db.exec('ALTER TABLE ops ADD COLUMN principal TEXT; ALTER TABLE ops ADD COLUMN via TEXT');
    // Remove the original table-wide name constraint, retaining all token hashes and revocations.
    if(!this.meta('token_names_v2')) {
      this.db.exec(`ALTER TABLE tokens RENAME TO old_tokens;
        CREATE TABLE tokens(id TEXT PRIMARY KEY,name TEXT,user_id TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT,last_used TEXT,revoked_at TEXT);
        INSERT INTO tokens SELECT * FROM old_tokens; DROP TABLE old_tokens;
        CREATE UNIQUE INDEX tokens_active_name ON tokens(name) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX tokens_hash ON tokens(hash);`);
      this.setMeta('token_names_v2','1');
    }
    // Multiple maps: ops and snapshots are keyed by (map_id, seq); the existing journal becomes map "main".
    if(!this.meta('maps_v1')) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS maps(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT,last_turn TEXT,position INTEGER NOT NULL DEFAULT 0);
        ALTER TABLE ops RENAME TO old_ops;
        CREATE TABLE ops(map_id TEXT NOT NULL,seq INTEGER NOT NULL,op_id TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,source TEXT NOT NULL,at TEXT NOT NULL,cmd TEXT NOT NULL,log TEXT NOT NULL,inverse TEXT NOT NULL,undone_by INTEGER,reverts INTEGER,principal TEXT,via TEXT,PRIMARY KEY(map_id,seq));
        INSERT INTO ops(map_id,seq,op_id,user_id,source,at,cmd,log,inverse,undone_by,reverts,principal,via) SELECT '${DEFAULT_MAP}',seq,op_id,user_id,source,at,cmd,log,inverse,undone_by,reverts,principal,via FROM old_ops;
        DROP TABLE old_ops;
        ALTER TABLE snapshots RENAME TO old_snapshots;
        CREATE TABLE snapshots(map_id TEXT NOT NULL,seq INTEGER NOT NULL,doc TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(map_id,seq));
        INSERT INTO snapshots(map_id,seq,doc,at) SELECT '${DEFAULT_MAP}',seq,doc,at FROM old_snapshots;
        DROP TABLE old_snapshots;`);
      this.db.prepare('INSERT OR IGNORE INTO maps(id,name,created_at,created_by,last_turn,position) VALUES(?,?,?,NULL,?,0)').run(DEFAULT_MAP,'Main',new Date().toISOString(),this.meta('last_turn')??null);
      this.setMeta('maps_v1','1');
    }
    if(this.meta('schema_version')!=='1')throw new Error('Unsupported database schema');
    this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  meta(key:string):string|undefined {return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  setMeta(key:string,value:string) {this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  users():User[] {return this.db.prepare('SELECT id,email,name,initials,color,email_verified AS emailVerified FROM users ORDER BY created_at,id').all() as unknown as User[];}
  user(id:string):User|undefined {return this.db.prepare('SELECT id,email,name,initials,color,email_verified AS emailVerified FROM users WHERE id=?').get(id) as unknown as User|undefined;}
  upsertUser(id:string,email:string,name:string,emailVerified=false):User {
    const now=new Date().toISOString();
    const words=name.trim().split(/\s+/);const initials=(words.length>1?words[0][0]+words.at(-1)![0]:name.slice(0,2)).toUpperCase();
    const colors=['#2563eb','#c2410c','#7c3aed','#047857','#be185d'];
    const color=colors[parseInt(hashToken(id).slice(0,8),16)%colors.length];
    this.db.prepare('INSERT INTO users(id,email,name,initials,color,created_at,last_seen,email_verified) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,initials=excluded.initials,last_seen=excluded.last_seen,email_verified=excluded.email_verified').run(id,email,name,initials,color,now,now,Number(emailVerified));
    return this.user(id)!;
  }
  createToken(name:string,email:string):string {
    const user=this.db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email) as {id:string}|undefined;
    if(!user)throw new Error('User must sign in before a token can be created');
    return this.issueToken(user.id,name).token;
  }
  /** A new bearer token for MCP and the API, owned by userId. The secret is returned once; only its hash is kept. */
  issueToken(userId:string,name:unknown):{token:string;info:TokenInfo} {
    const clean=typeof name==='string'?name.trim().replace(/\s+/g,' '):'';
    if(!clean)throw new Error('Token name required');
    if(clean.length>60)throw new Error('Token name is too long (60 characters at most)');
    if(this.db.prepare('SELECT 1 FROM tokens WHERE lower(name)=lower(?) AND revoked_at IS NULL').get(clean))throw new Error(`A token named ${clean} is already in use`);
    const token=randomBytes(32).toString('base64url'),id=randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO tokens(id,name,user_id,hash,created_at) VALUES(?,?,?,?,?)').run(id,clean,userId,hashToken(token),new Date().toISOString());
    return {token,info:this.tokens().find(t=>t.id===id)!};
  }
  /** Active tokens, newest first; only userId's when given. Never the secrets. */
  tokens(userId?:string):TokenInfo[] {
    return this.db.prepare(`SELECT t.id,t.name,t.user_id AS userId,u.name AS userName,u.email AS userEmail,t.created_at AS createdAt,t.last_used AS lastUsed FROM tokens t LEFT JOIN users u ON u.id=t.user_id WHERE t.revoked_at IS NULL${userId?' AND t.user_id=?':''} ORDER BY t.created_at DESC,t.id`).all(...(userId?[userId]:[])) as unknown as TokenInfo[];
  }
  /** Revokes an active token by id or name (ignoring case); the token stops working at once. */
  revokeToken(ref:string,userId?:string):TokenInfo {
    const found=this.tokens(userId).find(t=>t.id===ref)??this.tokens(userId).find(t=>t.name.toLowerCase()===ref.trim().toLowerCase());
    if(!found)throw new Error('Active token not found');
    this.db.prepare('UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(),found.id);
    return found;
  }
  tokenIdentity(token:string):{user:User;id:string;name:string}|undefined {
    const row=this.db.prepare('SELECT id,user_id,name,last_used FROM tokens WHERE hash=? AND revoked_at IS NULL').get(hashToken(token)) as {id:string;user_id:string;name:string;last_used:string|null}|undefined;
    if(!row)return;
    if(!row.last_used||Date.now()-Date.parse(row.last_used)>=60000)this.db.prepare('UPDATE tokens SET last_used=? WHERE id=?').run(new Date().toISOString(),row.id);
    const user=this.user(row.user_id);return user?{user,id:row.id,name:row.name}:undefined;
  }
  tokenUser(token:string):User|undefined {return this.tokenIdentity(token)?.user;}
  maps():MapInfo[] {return this.db.prepare('SELECT id,name,created_at AS createdAt,created_by AS createdBy,position FROM maps ORDER BY position,created_at,id').all() as unknown as MapInfo[];}
  map(id:string):MapInfo|undefined {return this.maps().find(m=>m.id===id);}
  insertMap(map:MapInfo) {this.db.prepare('INSERT INTO maps(id,name,created_at,created_by,position) VALUES(?,?,?,?,?)').run(map.id,map.name,map.createdAt,map.createdBy,map.position);}
  renameMap(id:string,name:string) {this.db.prepare('UPDATE maps SET name=? WHERE id=?').run(name,id);}
  /** Removes a map and its journal. Nightly backups keep earlier copies. */
  deleteMap(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {for(const table of ['ops','snapshots'])this.db.prepare(`DELETE FROM ${table} WHERE map_id=?`).run(id);this.db.prepare('DELETE FROM maps WHERE id=?').run(id);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  lastTurn(mapId:string):string|undefined {return (this.db.prepare('SELECT last_turn FROM maps WHERE id=?').get(mapId) as {last_turn:string|null}|undefined)?.last_turn??undefined;}
  setLastTurn(mapId:string,day:string) {this.db.prepare('UPDATE maps SET last_turn=? WHERE id=?').run(day,mapId);}
  close() {this.db.close();}
}
