import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { defaultReadLimits } from '../src/browser-policy.js';
import type { ReadSessionSpec } from '../src/contracts.js';
import { task } from './helpers.js';

const spec = (): ReadSessionSpec => ({ kind: 'read_session', schemaVersion: '0.1', readSessionId: 'read-one', scopeRef: 'scope-read', limits: { ...defaultReadLimits } });
const server = `
import {createInterface} from 'node:readline';
const mode=process.argv[1]; let generation=1;
const doc=()=>({sessionEpoch:'s-read',ref:'doc-'+generation,generation});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.method==='host.hello') send(r.id,{protocolVersion:'1',schemaVersion:'0.1',sessionEpoch:'s-read',capabilities:mode==='act'?['invoke']:[],platform:'macos'});
 else if(r.method==='session.openRead') send(r.id,{sessionEpoch:'s-read',controlEpoch:0,scopeRef:r.params.spec.scopeRef,grantRef:'g-read',grantVersion:1,unresolvedOperationIds:['old-unknown'],document:doc()});
 else if(r.method==='page.refresh') {if(mode!=='same') generation++; send(r.id,doc());}
 else if(r.method==='observation.read') {
  let document=doc(); if(mode==='foreign') document={...document,ref:'foreign'};
  const result={kind:'observation',schemaVersion:'0.1',observationId:'obs-1',sessionEpoch:'s-read',scopeRef:mode==='scope'?'foreign':r.params.scopeRef??'scope-read',document,
   capture:{startedMonoMs:0,endedMonoMs:1,eventSeqBefore:0,eventSeqAfter:0,consistency:'best_effort'},coverage:{rootRef:'n-root',status:'provider_exhausted',omittedReasons:[],nodeCount:1},
   nodes:[{ref:'n-root',parentRef:null,role:'group',nativeRole:'AXWebArea',name:{status:'available',value:'Synthetic'},value:{status:'unavailable'},enabled:{status:'available',value:true},capabilities:mode==='cap'?['invoke']:[]}]};
  if(mode==='no-document') delete result.document;
  if(mode==='metadata-url') result.document.url='https://example.org/private';
  if(mode==='large') result.nodes[0].name.value='x'.repeat(9000);
  if(mode==='multimegabyte') {
   for(let i=0;i<128;i++) result.nodes.push({...result.nodes[0],ref:'node-'+i,parentRef:'n-root',name:{status:'available',value:'日本語'.repeat(1500)}});
   result.coverage.nodeCount=result.nodes.length;
  }
  setTimeout(()=>send(r.id,result),mode==='late'?150:0);
 } else if(r.method==='session.cancel'||r.method==='session.close') send(r.id,null);
}
`;
function host(mode = 'ok') { return new RpcHost({ executable: process.execPath, args: ['--input-type=module', '-e', server, mode], timeoutMs: 2000 }); }
test('read session preserves unresolved IDs, reads without Task, and invalidates caller refs on refresh', async t => {
  const h=host();t.after(()=>h.close());const opened=await h.openRead(spec());
  assert.deepEqual(opened.unresolvedOperationIds,['old-unknown']);
  assert.equal((await h.read(opened.document)).nodes.length,1);
  const current=await h.refreshPage();assert.equal(current.generation,2);
  await assert.rejects(h.read(opened.document),{code:'stale_binding'});
  assert.equal((await h.read(current)).document.generation,2);
  await assert.rejects(h.openRead(spec()),{code:'scope_denied'});
  await assert.rejects(h.openSession(task()),{code:'scope_denied'});
  await assert.rejects(h.capture(),{code:'scope_denied'});
  await assert.rejects(h.commit('forged'),{code:'scope_denied'});
});
for(const bad of ['foreign','scope','cap','no-document','metadata-url','large']) test(`reject invalid read response: ${bad}`,async t=>{
 const h=host(bad);t.after(()=>h.close());const input=spec();input.limits.maxBytes=8192;
 const s=await h.openRead(input); await assert.rejects(h.read(s.document));
});
test('read-only handshake rejects action capability',async t=>{
 const h=host('act');t.after(()=>h.close());await assert.rejects(h.openRead(spec()),{code:'scope_denied'});
});
test('refresh cannot reuse the document generation',async t=>{
 const h=host('same');t.after(()=>h.close());const s=await h.openRead(spec());
 await assert.rejects(h.refreshPage(),{code:'stale_binding'});await assert.rejects(h.read(s.document),{code:'stale_binding'});
});
test('cancel while a read is pending rejects its late success and prevents reopen',async t=>{
 const h=host('late');t.after(()=>h.close());const s=await h.openRead(spec());
 const rejected=assert.rejects(h.read(s.document),{code:'cancelled'});await h.cancel();await rejected;
 await assert.rejects(h.openRead(spec()));
});
test('multi-megabyte read responses use the requested payload ceiling and preserve explicit transport caps', async t => {
 const large = host('multimegabyte'); t.after(() => large.close());
 const session = await large.openRead(spec()); const observation = await large.read(session.document);
 assert.ok(Buffer.byteLength(JSON.stringify(observation)) > 1024 * 1024);
 assert.equal(observation.nodes.length, 129); assert.equal(observation.nodes[128]!.name.status, 'available');
 const capped = new RpcHost({ executable: process.execPath, args: ['--input-type=module', '-e', server, 'multimegabyte'], timeoutMs: 2000, maxMessageBytes: 1024 * 1024 });
 t.after(() => capped.close()); const cs = await capped.openRead(spec());
 await assert.rejects(capped.read(cs.document), /byte limit/);
});
