/** Acceptance observation only: watch turns may publish then defer their postcheck.
 * Never equate one turn's build count with successful publication or verification.
 */
export function verifiedAfterPublication(messages,fromIndex=0){
 let publication;
 for(let messageIndex=fromIndex;messageIndex<messages.length;messageIndex++){
  const message=messages[messageIndex];if(message.event!=='tick')continue;
  for(const [outcomeIndex,outcome] of (message.result?.outcomes??[]).entries()){
   if(outcome.type==='publish'&&outcome.status==='published')publication={messageIndex,outcomeIndex,operation:outcome.operation};
   else if(publication&&outcome.type==='check'&&outcome.status==='verified-observation')return{publication,verification:{messageIndex,outcomeIndex}};
  }
 }
 return null;
}
