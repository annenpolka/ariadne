import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RpcHost } from '../src/host/rpc-host.js';
import { browserOrigin, defaultReadLimits } from '../src/browser-policy.js';
import { writePrivateJSON } from '../src/trace.js';
import type { DocumentStamp, ReadLimits, ReadSessionSpec, ScopeGrant } from '../src/contracts.js';

// Opt-in real Chrome/AX test. Synthetic page control and DOM oracle stay in the harness.
mkdirSync('.runtime', { recursive: true, mode: 0o700 });
const root = resolve(mkdtempSync('.runtime/browser-read-'));
const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
const nonce = randomUUID(), title = `Ariadne Read ${nonce}`;
let navigation: string | undefined, observedURL: string | undefined, outsideLoaded = false;
const frameMarker = `FRAME-PRIVATE-${nonce}`;
const other = createServer((req, res) => { if (req.url === '/outside') outsideLoaded = true; res.setHeader('Content-Type', 'text/html'); res.end(`<title>Other synthetic origin</title><p>${frameMarker}</p>`); });
other.listen(0, '127.0.0.1'); await once(other, 'listening');
const otherAddress = other.address(); assert.ok(otherAddress && typeof otherAddress !== 'string');
const otherOrigin = `http://127.0.0.1:${otherAddress.port}`;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/control') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ navigation })); return; }
  if (req.url?.startsWith('/oracle?')) { observedURL = new URL(req.url, 'http://127.0.0.1').searchParams.get('url') ?? undefined; res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ja"><title>${title}</title><h1>共通 AX 読み取り</h1>
  <section aria-label="読み取り領域"><h2>List region</h2><ul><li>Alpha synthetic record</li><li>Beta synthetic record</li></ul></section>
  <iframe title="Excluded frame" src="${otherOrigin}/frame"></iframe>
  <p>${'BIG'.repeat(24000)}</p>
  <section aria-label="Large rows">${Array.from({ length: 4100 }, (_, i) => `<p>Row ${i}: synthetic</p>`).join('')}</section>
  <script>async function tick(){try{const c=await(await fetch('/control')).json();if(c.navigation&&location.href!==c.navigation){if(new URL(c.navigation).origin===location.origin){history.pushState(null,'',c.navigation);document.title='Changed read page';}else{location.assign(c.navigation);return;}}await fetch('/oracle?url='+encodeURIComponent(location.href));}finally{setTimeout(tick,100)}}tick();</script></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`, pageURL = `${origin}/read?opaque=one#start`;
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--force-renderer-accessibility', '--new-window', pageURL];
const browser = spawn(chromeExecutable, args, { stdio: 'ignore' });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(check: () => boolean, message: string) { const deadline = performance.now() + 15000; while (!check()) { assert.ok(performance.now() < deadline, message); await sleep(50); } }
let windowTitle = title;
const hosts: RpcHost[] = [], cases: string[] = [];
function connect(name: string, overrides: Partial<ReadLimits> = {}, url = pageURL) {
  const limits = { ...defaultReadLimits, maxCaptures: 20, deadlineMs: 120000, ...overrides };
  const grant: ScopeGrant = { scopeRef: 'scope-read', grantRef: 'grant-read', version: 1, appId: 'ariadne.chrome', windowRef: 'browser-page', read: true, model: false, act: false, allowedCommands: [], pageScope: { origins: [origin] }, readLimits: limits, limits: { maxOperations: 0, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: limits.deadlineMs } };
  const spec: ReadSessionSpec = { kind: 'read_session', schemaVersion: '0.1', readSessionId: `read-${name}`, scopeRef: grant.scopeRef, limits };
  writePrivateJSON(join(root, `${name}-grant.json`), grant);
  if (name === 'primary') {
    const oldReceipt = { kind: 'host_receipt', schemaVersion: '0.1', operationId: 'old-unknown', sessionEpoch: 'old-epoch', eventSeq: 0, status: 'dispatch_intent', reason: 'none' };
    const events = [
      { type: 'boot', epoch: 'old-epoch' },
      { type: 'task', taskId: 'old-task', revision: 1, digest: 'a'.repeat(64), deadlineWallMs: Date.now(), lastWallMs: Date.now() },
      { type: 'intent', taskId: 'old-task', taskRevision: 1, scopeRef: grant.scopeRef, operationId: 'old-unknown', requestDigest: 'b'.repeat(64), receipt: oldReceipt },
    ];
    writeFileSync(join(root, `${name}.jsonl`), events.map((event, i) => JSON.stringify({ version: 1, sequence: i + 1, ...event })).join('\n') + '\n', { mode: 0o600 });
  }
  const host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(browser.pid), '--window-title', windowTitle, '--page-url', url, '--grant', join(root, `${name}-grant.json`), '--journal', join(root, `${name}.jsonl`)] });
  hosts.push(host); return { host, spec };
}
// Adversarial calls bypass the public TypeScript guard to exercise the actual native boundary.
function wire(host: RpcHost, method: string, params: unknown): Promise<unknown> {
  return (host as unknown as { request(method: string, params: unknown): Promise<unknown> }).request(method, params);
}
try {
  await until(() => observedURL === pageURL, 'Synthetic page did not load');
  assert.ok(browser.pid);
  const selected = JSON.parse(execFileSync('swift', ['test/browser-window.swift', String(browser.pid), pageURL], { encoding: 'utf8', timeout: 20000 })) as { title: string; url: string };
  assert.equal(selected.url, pageURL); windowTitle = selected.title;
  const actual = execFileSync('/bin/ps', ['-p', String(browser.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  assert.equal(actual, [chromeExecutable, ...args].join(' '));
  writePrivateJSON(join(root, 'launch.json'), { pid: browser.pid, profile, args });
  // Preserve explicit small operator budgets even though the production defaults grew.
  const { host, spec } = connect('primary', { maxNodes: 2048, maxBytes: 524288, maxCaptureMs: 3000, maxDepth: 64 });
  const session = await host.openRead(spec);
  assert.deepEqual(session.unresolvedOperationIds, ['old-unknown']);
  assert.deepEqual(host.capabilities, []); cases.push('Task-free session opens with query and fragment on a 4100-row page');
  const observation = await host.read(session.document);
  writePrivateJSON(join(root, 'synthetic-observation.json'), observation);
  assert.equal(observation.coverage.status, 'partial'); assert.ok(observation.coverage.omittedReasons.includes('budget'));
  assert.ok(observation.nodes.length <= spec.limits.maxNodes); assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= spec.limits.maxBytes);
  assert.ok(!JSON.stringify(observation).includes(frameMarker)); assert.ok(observation.coverage.omittedReasons.includes('frame'));
  assert.ok(observation.nodes.every(n => !n.capabilities.length));
  writePrivateJSON(join(root, 'synthetic-observation.json'), observation); cases.push('Bounded partial capture reads text and excludes nested cross-origin frame content');
  const region = observation.nodes.find(n => n.name.status === 'available' && n.name.value === '読み取り領域'); assert.ok(region);
  const sub = await host.read(session.document, region.ref); assert.equal(sub.coverage.rootRef, region.ref); assert.equal(sub.nodes[0]?.parentRef, null);
  assert.ok(sub.nodes.some(n => n.name.status === 'available' && n.name.value.includes('Alpha synthetic record') || n.value.status === 'available' && n.value.value.includes('Alpha synthetic record')));
  cases.push('Captured descendant can be read as an independent region and recover its bounded-out text');
  await assert.rejects(wire(host, 'session.openRead', { spec }));
  await assert.rejects(wire(host, 'session.open', { task: JSON.parse(readFileSync('examples/task.json', 'utf8')) }));
  await assert.rejects(wire(host, 'operation.prepare', {})); await assert.rejects(wire(host, 'operation.commit', { preparedId: 'forged' }));
  await assert.rejects(wire(host, 'observation.capture', {}));
  await assert.rejects(wire(host, 'observation.read', { document: session.document, rootRef: 'forged' }));
  cases.push('Native boundary rejects reopen, Task, legacy capture, forged region and operation requests');
  const refreshed = await host.refreshPage(); assert.ok(refreshed.generation > session.document.generation);
  assert.equal((await host.status('old-unknown'))?.status, 'outcome_unknown');
  cases.push('Read and refresh preserve an existing synthetic unresolved journal intent');
  await assert.rejects(wire(host, 'observation.read', { document: session.document }));
  await assert.rejects(wire(host, 'observation.read', { document: refreshed, rootRef: region.ref })); cases.push('Refresh invalidates both document and node references');
  for (const [name, overrides] of [['nodes', { maxNodes: 6 }], ['bytes', { maxBytes: 8192 }], ['depth', { maxDepth: 1 }], ['time', { maxCaptureMs: 100 }]] as const) {
    const h = connect(name, overrides); const s = await h.host.openRead(h.spec); const o = await h.host.read(s.document);
    assert.equal(o.coverage.status, 'partial'); assert.ok(o.nodes.length <= h.spec.limits.maxNodes); assert.ok(Buffer.byteLength(JSON.stringify(o)) <= h.spec.limits.maxBytes);
    await h.host.close(); cases.push(`Partial result respects ${name} budget`);
  }
  const limited = connect('count', { maxCaptures: 1, maxNodes: 6 }); const ls = await limited.host.openRead(limited.spec); await limited.host.read(ls.document); const ld = await limited.host.refreshPage(); await assert.rejects(wire(limited.host, 'observation.read', { document: ld })); await limited.host.close(); cases.push('Refresh cannot reset capture count');
  const deadline = connect('deadline', { deadlineMs: 1000, maxNodes: 6 }); await deadline.host.openRead(deadline.spec); await sleep(1050); await assert.rejects(wire(deadline.host, 'page.refresh', {})); await deadline.host.close(); cases.push('Refresh cannot reset session deadline');
  const cancel = connect('cancel'); const cs = await cancel.host.openRead(cancel.spec); const pending = assert.rejects(wire(cancel.host, 'observation.read', { document: cs.document })); await cancel.host.cancel(); await pending; await assert.rejects(wire(cancel.host, 'session.openRead', { spec: cancel.spec })); await cancel.host.close(); cases.push('Cancellation invalidates queued/in-flight read and reopen');
  navigation = `${origin}/read?opaque=two#changed`; await until(() => observedURL === navigation, 'SPA navigation did not happen');
  await assert.rejects(wire(host, 'observation.read', { document: refreshed }));
  const next = await host.refreshPage(); assert.ok(next.generation > refreshed.generation); await host.read(next); cases.push('Query/fragment and title changes invalidate old identity; allowed-origin refresh succeeds');
  navigation = `${otherOrigin}/outside`; await until(() => outsideLoaded, 'Outside navigation did not happen');
  execFileSync('swift', ['test/browser-window.swift', String(browser.pid), navigation], { timeout: 20000 });
  await assert.rejects(wire(host, 'observation.read', { document: next })); await assert.rejects(wire(host, 'page.refresh', {})); cases.push('Out-of-scope navigation rejects capture and refresh');
  assert.equal(browserOrigin(pageURL), origin);
  const report = { status: 'passed', mechanism: 'native macOS AX in real dedicated Chrome', cases, syntheticRows: 4100, nodes: observation.nodes.length, coverage: observation.coverage, modelCalls: 0, operations: 0, root };
  writePrivateJSON(join(root, 'report.json'), report); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  writePrivateJSON(join(root, 'report.json'), { status: 'failed', passedCases: cases, error: String(error), root }); throw error;
} finally {
  for (const h of hosts) await h.close().catch(() => undefined);
  browser.kill('SIGTERM'); server.closeAllConnections(); server.close(); other.closeAllConnections(); other.close();
}
