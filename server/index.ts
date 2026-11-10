import { config } from './config';
import { startServer } from './app';
const runtime=startServer(config());
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;void runtime.close().then(()=>process.exit(0),()=>process.exit(1));});
