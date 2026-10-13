import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/server.js';
test('P6 finite queue rejects overflow promptly and preserves serialization',async()=>{
 assert.equal(typeof server.createCallQueue,'function');let release,started=0;
 const q=server.createCallQueue({maxPending:2,maxPerMinute:20});
 const first=q.submit(async()=>{started++;await new Promise(r=>release=r);return 'first';});await Promise.resolve();
 const second=q.submit(async()=>{started++;return 'second';});const third=q.submit(async()=>{started++;return 'third';});
 const refused=await q.submit(async()=>{throw new Error('overflow executed');});assert.equal(refused.isError,true);assert.match(refused.content[0].text,/queue.*full.*not started/i);assert.equal(started,1);
 release();assert.deepEqual(await Promise.all([first,second,third]),['first','second','third']);await q.close();
});
test('P6 invocation rate has a finite window and a clear refusal',async()=>{
 assert.equal(typeof server.createCallQueue,'function');let now=0;const q=server.createCallQueue({maxPerMinute:2,now:()=>now});
 assert.equal(await q.submit(async()=>1),1);assert.equal(await q.submit(async()=>2),2);
 assert.match((await q.submit(async()=>3)).content[0].text,/rate limit.*not started/i);
 now=60001;assert.equal(await q.submit(async()=>4),4);await q.close();
});
test('P6 a call still queued when shutdown starts is refused as shutdown, not as a cancellation, and the active call finishes',async()=>{
 const q=server.createCallQueue();let release;
 const first=q.submit(async()=>{await new Promise(r=>release=r);return 'first';});await Promise.resolve();
 const second=q.submit(async()=>'second');
 const closing=q.close();
 const refused=await second;assert.equal(refused.isError,true);assert.equal(refused.content[0].text,'ToolsEngine is shutting down; the call was not started.');
 release();assert.equal(await first,'first');await closing;
 assert.equal((await q.submit(async()=>'late')).content[0].text,'ToolsEngine is shutting down; the call was not started.');
});
