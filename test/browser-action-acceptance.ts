import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { RpcHost, browserOperationId } from '../src/host/rpc-host.js';
import { writePrivateJSON } from '../src/trace.js';
import { checkActionObservation } from '../src/browser-actions.js';
import { browserSetValueRoles, browserInvokeRoles } from '../src/grants.js';
import type { BrowserActionTask, ScopeGrant, ReadObservation } from '../src/contracts.js';

mkdirSync('.runtime', { recursive: true, mode: 0o700 });
const root = resolve(mkdtempSync('.runtime/browser-action-test-'));
const title = `Ariadne Actions ${randomUUID()}`;
let draft = '', saves = 0, replacement = false;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url?.startsWith('/draft?')) { draft = new URL(req.url, 'http://x').searchParams.get('title') ?? ''; res.end('ok'); return; }
  if (req.url === '/save' && req.method === 'POST') { saves++; res.end('ok'); return; }
  if (req.url === '/state') { res.end(JSON.stringify({ replacement })); return; }
  if (req.url === '/frame') { res.setHeader('Content-Type', 'text/html'); res.end('<button>Frame button</button>'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url?.startsWith('/review')) { res.end(`<title>${title}</title><h1>確認 / Review</h1><p>${draft}</p><button id="save">Confirm</button><script>save.onclick=async()=>{await fetch('/save',{method:'POST'});document.body.innerHTML='<h1>Saved ${draft}</h1>'}</script>`); return; }
  res.end(`<title>${title}</title><label>申請タイトル<input id="title" value="old"></label><input aria-label="Disabled" disabled><input aria-label="Secret" type="password" value="synthetic-secret"><iframe src="/frame"></iframe><button id="next">Continue</button><script>
next.onclick=async()=>{await fetch('/draft?title='+encodeURIComponent(document.getElementById('title').value));location.href='/review?from=form'};
setInterval(async()=>{if((await(await fetch('/state')).json()).replacement){let old=document.getElementById('title');old.replaceWith(old.cloneNode(true))}},100);
</script>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const a = server.address(); assert.ok(a && typeof a !== 'string'); const origin = `http://127.0.0.1:${a.port}`;
const profile = join(root, 'profile'); mkdirSync(profile);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--force-renderer-accessibility', '--new-window', `${origin}/form`], { stdio: 'ignore' });
await once(chrome, 'spawn'); assert.ok(chrome.pid);
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const task = JSON.parse(readFileSync('examples/browser-action-task.json', 'utf8')) as BrowserActionTask;
const grant: ScopeGrant = { scopeRef: task.scopeRef, grantRef: 'grant-action-test', version: 1, appId: 'ariadne.chrome', windowRef: 'browser-page', read: true, model: false, act: true, allowedCommands: ['set_value', 'invoke'],
  limits: { maxOperations: task.steps.length, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: task.limits.deadlineMs }, readLimits: task.limits, pageScope: { origins: [origin] }, actionPolicy: { task, setValueRoles: browserSetValueRoles, invokeRoles: browserInvokeRoles } };
const grantPath = join(root, 'grant.json'); writePrivateJSON(grantPath, grant);
// Transport proxy drops only the final press response; it never changes a request.
const proxy = join(root, 'drop-response.mjs');
writeFileSync(proxy, `import{spawn}from'node:child_process';import{createInterface}from'node:readline';const c=spawn(process.argv[2],process.argv.slice(3),{stdio:['pipe','pipe','inherit']});let commits=0,drop;const input=createInterface({input:process.stdin});input.on('line',l=>{const q=JSON.parse(l);if(q.method==='action.commit'&&++commits===5)drop=q.id;c.stdin.write(l+'\\n')});input.on('close',()=>c.stdin.end());createInterface({input:c.stdout}).on('line',l=>{const r=JSON.parse(l);if(r.id!==drop)process.stdout.write(l+'\\n')});c.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>c.kill());`);
let host: RpcHost | undefined; const cases: string[] = [];
function node(obs: ReadObservation, name: string) { const n = obs.nodes.filter(n => n.name.status === 'available' && n.name.value === name); assert.equal(n.length, 1, name); return n[0]!; }
try {
  await pause(2500);
  const selected = JSON.parse(execFileSync('swift', ['scripts/browser-window.swift', String(chrome.pid), origin], { encoding: 'utf8' }));
  assert.equal(selected.status, 'browser_window');
  const nativeArgs = ['--pid', String(chrome.pid), '--window-title', selected.title, '--page-url', selected.url, '--grant', grantPath, '--journal', join(root, 'host.jsonl')];
  host = new RpcHost({ executable: process.execPath, args: [proxy, resolve('.cache/swift/debug/AriadneHost'), ...nativeArgs], timeoutMs: 1500 });
  const wire = host as unknown as { request(method: string, params: unknown): Promise<unknown> };
  await assert.rejects(wire.request('session.openAct', { task: { ...task, inputs: { title: 'outside authorized data' } } }));
  const opened = await host.openAct(task); let doc = opened.document;
  let obs = await host.read(doc);
  await assert.rejects(wire.request('action.prepare', { stepId: 'title', observationId: obs.observationId, targetRef: node(obs, '申請タイトル').ref, value: 'forged' }));
  await assert.rejects(wire.request('action.prepare', { stepId: 'title', observationId: obs.observationId, targetRef: 'r-forged' }));
  cases.push('Native boundary rejects a changed authorized task, extra input values and forged references');
  assert.ok(obs.coverage.omittedReasons.includes('frame')); assert.ok(!obs.nodes.some(n => n.name.status === 'available' && n.name.value === 'Frame button'));
  await assert.rejects(host.prepareAction('save', obs.observationId, node(obs, 'Continue').ref));
  await assert.rejects(host.prepareAction('title', obs.observationId, node(obs, 'Disabled').ref));
  await assert.rejects(host.prepareAction('title', obs.observationId, node(obs, 'Secret').ref));
  cases.push('Out-of-order, disabled, secure and nested-frame targets are refused');
  const stale = await host.prepareAction('title', obs.observationId, node(obs, '申請タイトル').ref);
  doc = await host.refreshPage(); assert.equal((await host.commitAction(stale.preparedId)).status, 'not_dispatched');
  cases.push('Refresh invalidates prepared operations before dispatch');
  obs = await host.read(doc);
  const replaced = await host.prepareAction('title', obs.observationId, node(obs, '申請タイトル').ref);
  replacement = true; await pause(250); replacement = false; await pause(150);
  assert.equal((await host.commitAction(replaced.preparedId)).status, 'not_dispatched');
  cases.push('Replacing a DOM element after prepare prevents dispatch to the old native element');
  obs = await host.read(doc);
  const p1 = await host.prepareAction('title', obs.observationId, node(obs, '申請タイトル').ref);
  assert.equal((await host.commitAction(p1.preparedId)).status, 'attempted');
  await assert.rejects(host.prepareAction('review', obs.observationId, node(obs, 'Continue').ref));
  obs = await host.read(doc); assert.deepEqual(node(obs, '申請タイトル').value, { status: 'available', value: task.inputs.title });
  cases.push('Native AX value readback matches the fixed input; pre-dispatch observations become stale');
  const p2 = await host.prepareAction('review', obs.observationId, node(obs, 'Continue').ref);
  assert.equal((await host.commitAction(p2.preparedId)).status, 'attempted'); await pause(350);
  await assert.rejects(host.read(doc)); doc = await host.refreshPage(); obs = await host.read(doc);
  assert.equal(draft, task.inputs.title); cases.push('Native press navigates with the DOM-side input intact; old document is rejected');
  const p3 = await host.prepareAction('save', obs.observationId, node(obs, 'Confirm').ref);
  await assert.rejects(host.commitAction(p3.preparedId), /timed out/);
  assert.equal((await host.status(p3.operationId))?.status, 'attempted');
  assert.equal((await host.commitAction(p3.preparedId)).status, 'attempted');
  assert.equal(saves, 1); cases.push('Dropped save response and duplicate commit produce exactly one server-side save');
  obs = await host.read(doc); assert.ok(checkActionObservation(task, obs).every(c => c.status === 'pass'));
  await host.close(); host = undefined;
  const now = JSON.parse(execFileSync('swift', ['scripts/browser-window.swift', String(chrome.pid), origin], { encoding: 'utf8' }));
  host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(chrome.pid), '--window-title', now.title, '--page-url', now.url, '--grant', grantPath, '--journal', join(root, 'host.jsonl')] });
  const resumed = await host.openAct(task); assert.deepEqual(resumed.attemptedStepIds, task.steps.map(s => s.id));
  assert.equal((await host.status(browserOperationId(task, 'save')))?.status, 'attempted');
  obs = await host.read(resumed.document); await assert.rejects(host.prepareAction('save', obs.observationId, obs.nodes[0]!.ref));
  assert.equal(saves, 1); cases.push('Restart preserves completed steps and cannot dispatch Save again');
  await host.close(); host = undefined;
  // Synthetic unresolved intent in the same durable profile journal, under a
  // different task/revision/scope. No UI operation produced this fixture record.
  const journalPath = join(root, 'host.jsonl');
  const previous = readFileSync(journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  let sequence = previous.at(-1).sequence as number;
  const epoch = previous.findLast(x => x.type === 'boot').epoch;
  for (const record of [
    { type: 'task', taskId: 'uncertain-fixture', revision: 7, digest: 'b'.repeat(64), deadlineWallMs: Date.now() + 600000, lastWallMs: Date.now() },
    { type: 'intent', taskId: 'uncertain-fixture', taskRevision: 7, scopeRef: 'different-scope', operationId: 'uncertain-op', requestDigest: 'c'.repeat(64), receipt: { kind: 'host_receipt', schemaVersion: '0.1', operationId: 'uncertain-op', sessionEpoch: epoch, eventSeq: 0, status: 'dispatch_intent', reason: 'none' } },
  ]) appendFileSync(journalPath, JSON.stringify({ ...record, version: 1, sequence: ++sequence }) + '\n');
  const otherTask = { ...task, taskId: 'another-task', revision: 2, scopeRef: 'new-scope' };
  const otherGrant = structuredClone(grant); otherGrant.scopeRef = otherTask.scopeRef; otherGrant.actionPolicy!.task = otherTask; writePrivateJSON(grantPath, otherGrant);
  host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(chrome.pid), '--window-title', now.title, '--page-url', now.url, '--grant', grantPath, '--journal', journalPath] });
  const blocked = await host.openAct(otherTask); assert.deepEqual(blocked.unresolvedOperationIds, ['uncertain-op']);
  obs = await host.read(blocked.document); await assert.rejects(host.prepareAction('title', obs.observationId, obs.nodes[0]!.ref), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'outcome_unknown');
  assert.equal(saves, 1); cases.push('Unresolved intent blocks mutation across task, revision, scope and process changes while reads remain usable');
  const report = { status: 'passed', cases, oracle: { draftMatches: draft === task.inputs.title, saves }, modelCalls: 0, root };
  writePrivateJSON(join(root, 'report.json'), report); console.log(JSON.stringify(report, null, 2));
} finally { await host?.close(); chrome.kill('SIGTERM'); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
