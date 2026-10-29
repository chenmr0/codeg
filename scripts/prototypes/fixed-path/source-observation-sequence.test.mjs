import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedAfterPublication} from './source-observation-sequence.mjs';
const check=status=>({type:'check',status}),publish=status=>({type:'publish',status,operation:'op-test'});
const tick=(status,builds,...outcomes)=>({event:'tick',result:{status,builds,outcomes}});
test('acceptance recognizes publication then verified check across separate watch turns',()=>{
 const messages=[tick('verified-observation',0,check('verified-observation')),tick('pending',1,publish('published'),check('busy')),tick('verified-observation',0,check('verified-observation'))];
 assert.equal(verifiedAfterPublication(messages.slice(0,2)),null);assert.deepEqual(verifiedAfterPublication(messages),{publication:{messageIndex:1,outcomeIndex:0,operation:'op-test'},verification:{messageIndex:2,outcomeIndex:0}});
});
test('acceptance does not reuse pre-publication verification or pre-edit message history',()=>{
 assert.equal(verifiedAfterPublication([tick('verified-observation',0,check('verified-observation')),tick('pending',1,publish('published'),check('busy'))]),null);
 const messages=[tick('verified-observation',1,publish('published'),check('verified-observation')),tick('verified-observation',0,check('verified-observation'))];assert.equal(verifiedAfterPublication(messages,1),null);
});
test('cancelled/failed publication and build count alone cannot satisfy acceptance',()=>{
 for(const status of ['cancelled','pending','busy'])assert.equal(verifiedAfterPublication([tick('pending',1,publish(status)),tick('verified-observation',1,check('verified-observation'))]),null);
 assert.equal(verifiedAfterPublication([tick('verified-observation',1,check('verified-observation'))]),null);
});
test('same-turn successful publish followed by verification remains accepted in outcome order',()=>{
 assert.deepEqual(verifiedAfterPublication([tick('verified-observation',1,check('dirty'),publish('published'),check('verified-observation'))]),{publication:{messageIndex:0,outcomeIndex:1,operation:'op-test'},verification:{messageIndex:0,outcomeIndex:2}});
});
