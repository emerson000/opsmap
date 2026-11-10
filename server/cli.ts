import { join } from 'node:path';
import { Store } from './db';
const args=process.argv.slice(2),store=new Store(join(process.env.DATA_DIR??'/data','opsmap.db'));
try {
  if(args[0]!=='token')throw new Error('Usage: token create --name <agent> --user <email> | token list | token revoke <name>');
  if(args[1]==='create') {
    const name=args[args.indexOf('--name')+1],user=args[args.indexOf('--user')+1];
    if(!args.includes('--name')||!args.includes('--user')||!name||!user)throw new Error('Name and user email required');
    console.log(store.createToken(name,user));
  }else if(args[1]==='list')console.log(JSON.stringify(store.db.prepare('SELECT name,user_id,created_at,last_used,revoked_at FROM tokens ORDER BY name').all(),null,2));
  else if(args[1]==='revoke'&&args[2]) {
    const result=store.db.prepare('UPDATE tokens SET revoked_at=? WHERE name=? AND revoked_at IS NULL').run(new Date().toISOString(),args[2]);
    if(!result.changes)throw new Error('Active token not found');
  }else throw new Error('Unknown token command');
}catch(error){console.error(error instanceof Error?error.message:'Token command failed');process.exitCode=1;}finally{store.close();}
