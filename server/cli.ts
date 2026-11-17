import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './db';
import { SecretBox } from './secrets';
import { migrateTaskSync, migrateTokens, taskSyncSummary } from './tasksync/migrate';
const USAGE='Usage: token create --name <agent> --user <email> | token list | token revoke <name> | tasks migrate [--dry-run]';
const args=process.argv.slice(2),dataDir=process.env.DATA_DIR??'/data',store=new Store(join(dataDir,'opsmap.db'));
try {
  if(args[0]==='token') {
    if(args[1]==='create') {
      const name=args[args.indexOf('--name')+1],user=args[args.indexOf('--user')+1];
      if(!args.includes('--name')||!args.includes('--user')||!name||!user)throw new Error('Name and user email required');
      console.log(store.createToken(name,user));
    }else if(args[1]==='list')console.log(JSON.stringify(store.db.prepare('SELECT name,user_id,created_at,last_used,revoked_at FROM tokens ORDER BY name').all(),null,2));
    else if(args[1]==='revoke'&&args[2]) {
      store.revokeToken(args[2]);
    }else throw new Error('Unknown token command');
  }else if(args[0]==='tasks'&&args[1]==='migrate') {
    // The one-time move of task sync data (the server also runs it at start). --dry-run reports and changes nothing.
    for(const line of taskSyncSummary(store))console.log(line);
    if(!args.includes('--dry-run')) {
      const keyFile=process.env.OPSMAP_SECRET_KEY_FILE||join(dataDir,'secrets','master.key');
      if(existsSync(keyFile))migrateTokens(store,SecretBox.fromFile(keyFile));
      else console.log(`No secret key at ${keyFile}: tokens are copied when the server starts with it`);
      migrateTaskSync(store);
      console.log('migrated');
    }
  }else throw new Error(USAGE);
}catch(error){console.error(error instanceof Error?error.message:'Command failed');process.exitCode=1;}finally{store.close();}
