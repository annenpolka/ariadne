import { spawn, spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { ExactLabelProvider, makeBinding } from '../src/providers/binding.js';
import { writePrivateJSON } from '../src/trace.js';
import type { Observation, ScopeGrant } from '../src/contracts.js';
import { grant, task } from './helpers.js';

// Explicit opt-in integration test. The Host uses AX only. This harness owns the
// local page and its DOM-side oracle; neither oracle IDs nor values go to a model.
const demo = process.argv.includes('--demo');
mkdirSync('.runtime', { recursive: true, mode: 0o700 });
const root = resolve(mkdtempSync('.runtime/browser-'));
const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
const nonce = randomUUID(); const title = `Ariadne Browser ${nonce}`;
let windowTitle = title;
const pagePath = `/fixture/${nonce}`; const outsidePath = `/outside/${nonce}`;
type Oracle = { contact: string; shipping: string; disabled: string; secret: string; submits: number; path: string };
let oracle: Oracle | undefined; let movePage = false; let requestCount = 0;
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${title}</title>
<h1>専用ブラウザ試験</h1>
<fieldset><legend>連絡先</legend><label>メール<input id="contact" type="text" autocomplete="off"></label></fieldset>
<fieldset><legend>配送通知先</legend><label>メール<input id="shipping" type="text" autocomplete="off"></label></fieldset>
<label>Disabled<input id="disabled" disabled value="unchanged"></label>
<label>Password<input id="secret" type="password" value="synthetic-secret" autocomplete="off"></label>
<button id="submit" type="button">Submit</button>
<script nonce="${nonce}">
let submits = 0;
document.getElementById('submit').onclick = () => { submits++; };
async function tick() {
 try {
  const state = await (await fetch('/control/${nonce}', {cache:'no-store'})).json();
  if (state.move && location.pathname !== '${outsidePath}') history.pushState(null, '', '${outsidePath}');
  const value = id => document.getElementById(id).value;
  await fetch('/oracle/${nonce}', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({contact:value('contact'),shipping:value('shipping'),disabled:value('disabled'),secret:value('secret'),submits,path:location.pathname})});
 } catch (_) {} finally { setTimeout(tick, 100); }
}
tick();
</script></html>`;
const server = createServer((req, res) => {
  requestCount++;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === `/control/${nonce}`) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ move: movePage })); return; }
  if (req.method === 'POST' && req.url === `/oracle/${nonce}`) {
    let body = ''; req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on('end', () => { try { oracle = JSON.parse(body) as Oracle; res.end('ok'); } catch { res.statusCode = 400; res.end(); } }); return;
  }
  if (req.method === 'GET' && [pagePath, outsidePath].includes(req.url ?? '')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'`);
    res.end(html); return;
  }
  res.statusCode = 404; res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const pageURL = `http://127.0.0.1:${address.port}${pagePath}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--force-renderer-accessibility', ...(demo ? ['--new-window', pageURL] : [`--app=${pageURL}`])];
const browser = spawn(chrome, args, { stdio: 'ignore' });
let browserEnded = false; browser.once('exit', () => { browserEnded = true; });
const browserExit = once(browser, 'exit');
const scope: ScopeGrant = { ...grant(), appId: 'ariadne.chrome_fixture', allowedCommands: ['set_value'] };
const fixed = task(); fixed.taskId = 'task-browser'; fixed.slots[0]!.meaning = 'メール';
fixed.inputs.shipping = 'delivery@example.invalid';
fixed.slots.push({ id: 'shippingEmail', meaning: 'メール', inputRef: 'shipping', regionHint: '配送通知先' });
fixed.requiredChecks.push({ id: 'check-shipping', kind: 'value_equals_input', slotId: 'shippingEmail', inputRef: 'shipping', comparison: 'exact' });
writePrivateJSON(join(root, 'grant.json'), scope); writePrivateJSON(join(root, 'task.json'), fixed);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(check: () => boolean, message: string, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (!check()) { assert.ok(performance.now() < deadline, message); assert.ok(!browserEnded, 'isolated browser exited early'); await sleep(50); }
}
function connect(suffix: string, url = pageURL) {
  return new RpcHost({ env: { ...process.env, ARIADNE_DEBUG: '1' }, onDiagnostic: message => appendFileSync(join(root, `${suffix}.stderr`), message, { mode: 0o600 }), executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(browser.pid), '--window-title', windowTitle, '--page-url', url, '--grant', join(root, 'grant.json'), '--journal', join(root, `${suffix}.jsonl`)] });
}
let host: RpcHost | undefined;
try {
  await until(() => oracle?.path === pagePath, 'isolated page did not initialize');
  assert.ok(browser.pid);
  const launchedCommand = execFileSync('/bin/ps', ['-p', String(browser.pid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(launchedCommand.includes(`--user-data-dir=${profile}`), 'must own the browser using the fresh profile');
  if (demo) {
    const selected = JSON.parse(execFileSync('swift', ['test/browser-window.swift', String(browser.pid), pageURL], { encoding: 'utf8', timeout: 20_000 })) as { pid: number; title: string; url: string };
    assert.equal(selected.pid, browser.pid); assert.equal(selected.url, pageURL); assert.ok(selected.title);
    windowTitle = selected.title; writePrivateJSON(join(root, 'window.json'), selected);
  }
  writePrivateJSON(join(root, 'launch.json'), { pid: browser.pid, profile, pageURL, args, version: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Google Chrome.app/Contents/Info.plist'], { encoding: 'utf8' }).trim() });

  const invalidURLs = ['http://127.0.0.1/fixture', 'http://localhost:1234/fixture', 'https://127.0.0.1:1234/fixture', 'http://127.0.0.1:1234/fixture?x=1', 'http://127.0.0.1:1234/fixture#x', 'http://user@127.0.0.1:1234/fixture', 'http://127.0.0.1:01234/fixture'];
  for (const [i, invalid] of invalidURLs.entries()) {
    const rejected: SpawnSyncReturns<Buffer> = spawnSync(resolve('.cache/swift/debug/AriadneHost'), ['--pid', String(browser.pid), '--window-title', title, '--page-url', invalid, '--grant', join(root, 'grant.json'), '--journal', join(root, `invalid-${i}.jsonl`)], { timeout: 2000 });
    assert.equal(rejected.status, 2, `invalid page URL must be rejected at startup: ${invalid}`);
  }
  const wrongPage = connect('wrong-page', `http://127.0.0.1:${address.port}${outsidePath}`);
  try { await assert.rejects(wrongPage.openSession(fixed)); } finally { await wrongPage.close(); }
  host = connect('host');
  const session = await host.openSession(fixed);
  const observed: Observation = await host.capture('window_summary'); writePrivateJSON(join(root, 'observation.json'), observed);
  const disabled = observed.nodes.find(n => n.name.status === 'available' && n.name.value === 'Disabled');
  const secret = observed.nodes.find(n => n.name.status === 'available' && n.name.value === 'Password');
  assert.ok(disabled); assert.ok(secret); assert.equal(secret.value.status, 'redacted'); assert.deepEqual(secret.capabilities, []);
  const group = observed.nodes.find(n => n.role === 'group'); assert.ok(group); assert.ok(!group.capabilities.includes('set_value'));
  for (const [i, node] of [disabled, secret, group].entries()) {
    await assert.rejects(host.prepare({ operationId: `op-reject-${i}`, taskId: fixed.taskId, taskRevision: fixed.revision, sessionEpoch: session.sessionEpoch, binding: makeBinding('contactEmail', node.ref, observed, 'operator'), command: { kind: 'set_value', targetRef: node.ref, value: fixed.inputs.email! } }));
  }
  const initialBindings = await new ExactLabelProvider().bind({ task: fixed, observation: observed, signal: new AbortController().signal });
  const initialBinding = initialBindings.bindings.find(b => b.slotId === 'contactEmail'); assert.ok(initialBinding);
  await host.prepare({ operationId: 'op-positive-probe', taskId: fixed.taskId, taskRevision: fixed.revision, sessionEpoch: session.sessionEpoch, binding: initialBinding, command: { kind: 'set_value', targetRef: initialBinding.targetRef, value: fixed.inputs.email! } });
  const result = await new AriadneRuntime({ host, provider: new ExactLabelProvider(), grant: scope, statePath: join(root, 'state.json'), environment: 'external_best_effort' }).run(fixed);
  writePrivateJSON(join(root, 'result.json'), result);
  assert.equal(result.result.status, 'verified_success', JSON.stringify(result.handoff));
  await until(() => oracle?.contact === fixed.inputs.email && oracle?.shipping === fixed.inputs.shipping, 'DOM oracle values did not match AX readback');
  assert.equal(oracle!.disabled, 'unchanged'); assert.equal(oracle!.secret, 'synthetic-secret'); assert.equal(oracle!.submits, 0);
  writePrivateJSON(join(root, 'oracle-after-input.json'), oracle);

  if (demo) {
    await host.close(); host = undefined;
    const report = { root, profile, browserPID: browser.pid, pageURL, browser: 'Google Chrome', mode: 'visible-demo', mechanism: 'native macOS AX only', status: result.result.status, checkedValues: { contact: oracle!.contact, shipping: oracle!.shipping }, submits: oracle!.submits, hostClosed: true };
    writePrivateJSON(join(root, 'report.json'), report); process.stdout.write(JSON.stringify(report) + '\n');
    // Keep this owned page available for inspection after the automation stops.
    // Closing Chrome ends the demo and shuts down its localhost server.
    await browserExit;
  } else {
    const next = structuredClone(fixed); next.taskId = 'task-browser-navigation'; next.inputs.email = 'must-not-be-written@example.invalid';
    const navigationSession = await host.openSession(next); const beforeMove = await host.capture();
    const bindings = await new ExactLabelProvider().bind({ task: next, observation: beforeMove, signal: new AbortController().signal });
    const binding = bindings.bindings.find(b => b.slotId === 'contactEmail'); assert.ok(binding);
    const pending = await host.prepare({ operationId: 'op-before-navigation', taskId: next.taskId, taskRevision: next.revision, sessionEpoch: navigationSession.sessionEpoch, binding, command: { kind: 'set_value', targetRef: binding.targetRef, value: next.inputs.email! } });
    movePage = true; await until(() => oracle?.path === outsidePath, 'same-title page URL did not change');
    await sleep(200);
    const receipt = await host.commit(pending.preparedId); assert.equal(receipt.status, 'not_dispatched');
    await assert.rejects(host.capture()); await sleep(150);
    assert.equal(oracle!.contact, fixed.inputs.email); assert.equal(oracle!.shipping, fixed.inputs.shipping); assert.equal(oracle!.submits, 0);
    writePrivateJSON(join(root, 'oracle-after-navigation.json'), oracle);
    const journal = readFileSync(join(root, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string });
    assert.equal(journal.filter(row => row.type === 'intent').length, 2);
    const report = { root, profile, browserPID: browser.pid, browser: 'Google Chrome', mechanism: 'native macOS AX only', status: result.result.status, checks: ['fresh-profile', 'invalid-URLs-rejected', 'wrong-url-rejected', 'disabled-rejected', 'secure-redacted-and-rejected', 'group-rejected', 'two-fields-match-DOM-oracle', 'submit-untouched', 'same-title-URL-change-prevents-dispatch'], dispatchIntents: 2, requestCount, navigationReceipt: receipt };
    writePrivateJSON(join(root, 'report.json'), report); process.stdout.write(JSON.stringify(report) + '\n');
  }
} catch (error) {
  writePrivateJSON(join(root, 'failure.json'), { error: error instanceof Error ? error.message : String(error), oracle }); throw error;
} finally {
  await host?.close().catch(() => undefined);
  if (!browserEnded) browser.kill('SIGTERM');
  const timer = setTimeout(() => { if (!browserEnded) browser.kill('SIGKILL'); }, 3000);
  try { await browserExit; } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
