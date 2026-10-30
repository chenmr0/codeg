import { createIpcChannel } from './ipc.mjs';
const {send,close:closeIpc}=createIpcChannel();
import fs from 'node:fs';
import { publishObserved, reconcileSource, checkSource, watchSource, sourceState } from './source-reconciliation.mjs';
const [mode,root,encoded='{}']=process.argv.slice(2),options=JSON.parse(encoded),pause=new Int32Array(new SharedArrayBuffer(4));
let hookCount=0;const controller=new AbortController();
process.on('message',message=>{if(message==='stop')controller.abort();});
const hook=phase=>{
  send({event:'phase',phase});
  if(options.crashAt===phase)process.kill(process.pid,'SIGKILL');
  if(options.pauseAt===phase && hookCount++===0){
    fs.writeFileSync(options.pausedFile,phase);const limit=Date.now()+10000;
    while(!fs.existsSync(options.resumeFile)){if(Date.now()>limit)throw new Error('Source test pause exceeded deadline');Atomics.wait(pause,0,0,2);}
  }
  if(options.mutateAt===phase)fs.writeFileSync(options.mutateFile,options.mutateContent);
};
const config={...options,hook,afterPublish:options.failAfterPublish?()=>{throw new Error('Injected post-publication observation failure');}:undefined,beforeHash:options.failHash?()=>{throw new Error('Injected source hash I/O failure');}:undefined};
try{
  let result;
  if(mode==='publish')result=await publishObserved(root,config);
  else if(mode==='check')result=await checkSource(root,config);
  else if(mode==='reconcile')result=await reconcileSource(root,config);
  else if(mode==='watch'){
    send({event:'ready'});
    await watchSource(root,{...config,signal:controller.signal,onResult:value=>send({event:'tick',result:value})});
    result=sourceState(root);
  }else throw new Error(`Unknown source worker mode ${mode}`);
  await send({event:'result',result});
}catch(error){process.exitCode=1;await send({event:'error',error:error.stack});}
finally{await closeIpc();}
