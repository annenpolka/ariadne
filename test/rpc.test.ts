import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { task } from './helpers.js';

// Separate OS process and real pipes exercise framing, request correlation and lost replies.
const server = `
import { createInterface } from 'node:readline';
let commitCount = 0, cancelled = false;
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const r = JSON.parse(line);
 if (r.method === 'host.hello') { send(r.id,{protocolVersion:'1',schemaVersion:'0.1',sessionEpoch:'s-wire',capabilities:['set_value'],platform:'macos'}); continue; }
 if (r.method === 'session.open') { send(r.id,{sessionEpoch:'s-wire',controlEpoch:0,scopeRef:r.params.task.scopeRef,grantRef:'g-wire',grantVersion:1}); continue; }
 if (r.method === 'session.close') { send(r.id,null); continue; }
 if (r.method === 'session.cancel') { cancelled = true; send(r.id,null); continue; }
 if (r.method === 'observation.capture') {
  send(r.id,{kind:'observation',schemaVersion:'0.1',observationId:'obs-read',sessionEpoch:'s-wire',scopeRef:'scope-fixture',document:{sessionEpoch:'s-wire',ref:'doc',generation:1},
   capture:{startedMonoMs:0,endedMonoMs:1,eventSeqBefore:0,eventSeqAfter:0,consistency:'best_effort'},coverage:{rootRef:'root',status:'provider_exhausted',omittedReasons:[],nodeCount:1},
   nodes:[{ref:'root',parentRef:null,role:'group',nativeRole:'AXWebArea',name:{status:'available',value:''},value:{status:'unsupported'},enabled:{status:'available',value:true},capabilities:[]}]});continue;
 }
 if (r.method === 'operation.commit') {
   commitCount++;
   if (r.params.preparedId === 'lost') continue;
   if (r.params.preparedId === 'die') process.exit(1);
   setTimeout(()=>send(r.id,{kind:'host_receipt',schemaVersion:'0.1',operationId:'op-wire',sessionEpoch:'s-wire',eventSeq:commitCount,status:cancelled?'not_dispatched':'attempted',reason:cancelled?'cancelled_before_dispatch':'none'}),100);
   continue;
 }
 if (r.method === 'operation.status') {
   if(r.params.operationId === 'oversize') { process.stdout.write('x'.repeat(2049)); continue; }
   if(r.params.operationId === 'malformed') { process.stdout.write('{broken\\n'); continue; }
   if(r.params.operationId === 'foreign') { send(999,null); continue; }
   if(r.params.operationId === 'late') { setTimeout(()=>send(r.id,null),100); continue; }
   if(r.params.operationId === 'wrong') { send(r.id,{kind:'host_receipt',schemaVersion:'0.1',operationId:'not-yours',sessionEpoch:'s-wire',eventSeq:0,status:'attempted',reason:'none'}); continue; }
   send(r.id,{kind:'host_receipt',schemaVersion:'0.1',operationId:r.params.operationId,sessionEpoch:'s-wire',eventSeq:commitCount,status:'attempted',reason:'none'});
 }
}
`;
function host(timeoutMs = 1000) { return new RpcHost({ executable: process.execPath, args: ['--input-type=module', '-e', server], timeoutMs, maxMessageBytes: 2048 }); }
test('wire handshake, concurrent cancel, and fixed commit without override arguments', async t => {
  const h = host(); t.after(() => h.close());
  assert.equal((await h.openSession(task())).sessionEpoch, 's-wire');
  const pending = h.commit('prepared'); await h.cancel();
  const receipt = await pending; assert.equal(receipt.status, 'not_dispatched'); assert.equal(receipt.eventSeq, 1);
});
test('lost commit reply is reconciled through status with no automatic retry', async t => {
  const h = host(80); t.after(() => h.close()); await h.openSession(task());
  await assert.rejects(h.commit('lost'), /timed out/);
  const receipt = await h.status('op-wire'); assert.equal(receipt?.status, 'attempted'); assert.equal(receipt?.eventSeq, 1);
});
test('late timed-out reply is ignored while later responses still correlate', async t => {
  const h = host(80); t.after(() => h.close()); await h.openSession(task());
  await assert.rejects(h.status('late'), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.status('op-next'))?.operationId, 'op-next');
});
for (const bad of ['oversize', 'malformed', 'foreign']) test(`wire ${bad} cannot be used as a result`, async () => {
  const h = host(); await h.openSession(task());
  await assert.rejects(h.status(bad), { code: 'closed' }); await h.close();
});
test('status for a different operation is rejected', async t => {
  const h = host(); t.after(() => h.close()); await h.openSession(task());
  await assert.rejects(h.status('wrong'), { code: 'invalid_request' });
});
test('host death rejects commit and never launches a replacement host', async () => {
  const h = host(); await h.openSession(task());
  await assert.rejects(h.commit('die'), { code: 'closed' });
  await assert.rejects(h.status('op-wire'), { code: 'closed' }); await h.close();
});
test('a read document cannot bypass legacy Task observation limits', async t => {
 const h = host(); t.after(() => h.close()); await h.openSession(task());
 await assert.rejects(h.capture(), /Task capture cannot/);
});
