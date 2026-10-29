import { setTimeout as delay } from 'node:timers/promises';
import { Participant, now } from './protocol.mjs';
import { graphAt } from './graph-adapter.mjs';
const [root,role] = process.argv.slice(2);
const p = new Participant(root,file=>graphAt(root,file,{readOnly:true}));
let running=true;const samples=[],states=[],errors=[];
process.on('message',m=>{if(m==='stop')running=false;});
process.send?.({type:'ready',role});
while(running){
  const t=now();
  try {
    const value=await p.request(g=>{
      const old=g.searchNodes('old_marker').some(r=>r.node.name==='old_marker');
      const next=g.searchNodes('new_marker').some(r=>r.node.name==='new_marker');
      if(old===next)throw new Error('Mixed or incomplete snapshot');
      if(samples.length%10===0)g.getDetectedFrameworks();
      return next?'new':'old';
    });samples.push(now()-t);states.push(value);
  }catch(e){errors.push(e.stack);}
  await delay(3);
}
p.close();process.send?.({type:'result',role,samples,states,errors,reopens:p.reopens,reopenDurationsMs:p.reopenDurationsMs,admissionWaitMs:p.admissionWaitMs,gateMetrics:p.p.gateMetrics},()=>process.disconnect());
