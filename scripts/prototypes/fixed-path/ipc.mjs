/** Test-worker IPC: never disconnect with an unacknowledged send in flight.
 * Hook notifications remain synchronous/nonblocking; close() drains all callbacks.
 * A callback confirms transport handoff, not a parent application-level ACK.
 */
export function createIpcChannel(endpoint=process){
 const pending=new Set();let failure;
 function send(message){
  if(typeof endpoint.send!=='function')return Promise.resolve();
  const completion=new Promise((resolve,reject)=>{try{endpoint.send(message,error=>error?reject(error):resolve());}catch(error){reject(error);}});
  pending.add(completion);
  // Observe failures even for non-awaited phase hooks, without hiding them from close.
  completion.then(()=>pending.delete(completion),error=>{pending.delete(completion);failure??=error;});
  return completion;
 }
 async function close(){
  try{while(pending.size)await Promise.allSettled([...pending]);if(failure)throw failure;}
  finally{if(endpoint.connected)endpoint.disconnect();}
 }
 return{send,close};
}

/** Exit reports OS termination, not drained IPC/stdio. Only close is final. */
export function waitForChildClose(child){
 return new Promise((resolve,reject)=>{
  const onError=error=>{child.removeListener('close',onClose);reject(error);};
  const onClose=(code,signal)=>{child.removeListener('error',onError);resolve({code,signal});};
  child.once('error',onError);child.once('close',onClose);
 });
}
