import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadProjection } from '../src/read-task.js';
import { writePrivateJSON } from '../src/trace.js';
import type { ReadObservation, ReadTaskResult, ReadTaskSpec } from '../src/contracts.js';

// Explicit real Chrome acceptance. Only this harness knows the synthetic page's expected text.
const exec = promisify(execFile), nonce = randomUUID();
const marker = `合成🧵e\u0301-${nonce}`, duplicate = `同値-${nonce}`;
let loaded = false, effects = 0;
const server = createServer((req, res) => {
  if (req.url === '/loaded') { loaded = true; res.end('ok'); return; }
  if (req.url === '/effect') { effects++; res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html lang="ja"><title>Ariadne extraction ${nonce}</title>
  <section aria-label="Synthetic extract region"><p>${marker}</p><p>${duplicate}</p><p>${duplicate}</p></section>
  <label>Public label<input type="text" value="Synthetic input"></label>${req.url === '/redacted' ? '<label>Secret<input type="password" value="excluded-secret"></label>' : ''}
  <button onclick="fetch('/effect')">Synthetic button</button><p>${'日本🧵'.repeat(3000)}</p>
  <script>addEventListener('input',()=>fetch('/effect'));fetch('/loaded')</script></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
let lastStdoutBytes = 0;
async function cli(args: string[]) {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/browser.ts', ...args], { timeout: 40_000, maxBuffer: 2_000_000 });
  lastStdoutBytes = Buffer.byteLength(stdout); return JSON.parse(stdout);
}
let root: string | undefined, pid: number | undefined;
const cases: string[] = [];
try {
  const launch = await cli(['open', `${origin}/`]); root = launch.root; pid = launch.pid;
  assert.ok(root && pid);
  for (let i = 0; i < 50 && !loaded; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(loaded); await new Promise(r => setTimeout(r, 500));
  const extract = (flags: string[] = []) => cli(['extract', root!, '--origin', origin, '--role', 'AXStaticText', '--attribute', 'value', ...flags]);
  const report = await extract(['--record']);
  assert.equal(report.status, 'projected'); assert.equal(report.outputTruncated, false);
  const read = (name: string) => JSON.parse(readFileSync(join(report.readDir, name), 'utf8'));
  const task = read('task.json') as ReadTaskSpec, observation = read('observation.json') as ReadObservation, result = read('result.json') as ReadTaskResult;
  new ReadProjection(task, observation).verify(result);
  const literals = result.records.flatMap(r => r.attributes.filter(a => a.status === 'available').map(a => a.text));
  assert.ok(literals.includes(marker)); assert.equal(literals.filter(x => x === duplicate).length, 2);
  assert.equal(result.modelCalls, 0); assert.equal(result.operations, 0);
  cases.push('Real native AX CLI projects synthetic Unicode and duplicate values with verifiable source spans');
  assert.ok(!JSON.stringify(report).includes(marker)); assert.ok(!JSON.stringify(report).includes('Digest'));
  const privateDefault = await extract();
  assert.ok(!existsSync(join(privateDefault.readDir, 'observation.json')) && !existsSync(join(privateDefault.readDir, 'result.json')) && !existsSync(join(privateDefault.readDir, 'task.json')));
  cases.push('Default CLI output/report contains counts and states; raw task/observation/result require record');
  const limited = await extract(['--max-records', '1']); assert.equal(limited.status, 'partial'); assert.equal(limited.records, 1); assert.equal(limited.outputTruncated, true);
  cases.push('Record limit returns partial without inventing completeness');
  const bytes = await extract(['--max-output-bytes', '8192', '--raw', '--record']); assert.equal(bytes.status, 'partial'); assert.equal(bytes.outputTruncated, true); assert.ok(lastStdoutBytes <= 8192);
  const saved = statSync(join(root, bytes.source.readSessionId, 'result.json')); assert.ok(saved.size <= 8192); assert.equal(saved.mode & 0o777, 0o600);
  cases.push('UTF-8 result byte limit includes evidence and envelope, truncating only whole records');
  const partial = await extract(['--max-nodes', '1']); assert.equal(partial.status, 'unknown'); assert.equal(partial.records, 0);
  cases.push('Zero matches in partial source returns unknown');
  const noMatch = await cli(['extract', root, '--origin', origin, '--role', 'AXAbsentSyntheticRole']); assert.equal(noMatch.status, 'no_match_in_observation');
  cases.push('Zero matches in exhausted observation returns no_match_in_observation');
  const firstRoot = root;
  process.kill(pid, 'SIGTERM'); pid = undefined; loaded = false;
  const privateLaunch = await cli(['open', `${origin}/redacted`]); root = privateLaunch.root; pid = privateLaunch.pid;
  assert.ok(root && pid);
  for (let i = 0; i < 50 && !loaded; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(loaded); await new Promise(r => setTimeout(r, 500));
  const redacted = await cli(['extract', root, '--origin', origin, '--raw']);
  assert.equal(redacted.status, 'partial'); assert.ok(redacted.source.coverage.omittedReasons.includes('redacted'));
  assert.ok(redacted.records.some((r: ReadTaskResult['records'][number]) => r.attributes.some(a => a.status === 'redacted')));
  assert.ok(!JSON.stringify(redacted).includes('excluded-secret'));
  cases.push('Secret attribute remains redacted and prevents a complete-source claim');
  assert.equal(effects, 0);
  const accepted = { status: 'passed', mechanism: 'native macOS AX through production extract CLI in real dedicated Chrome', cases,
    records: result.records.length, coverage: result.source.coverage.status, modelCalls: 0, operations: 0, syntheticPageEffects: effects, root: firstRoot, redactedRoot: root };
  writePrivateJSON(join(firstRoot, 'extract-acceptance.json'), accepted); process.stdout.write(JSON.stringify(accepted, null, 2) + '\n');
} catch (error) {
  if (root) writePrivateJSON(join(root, 'extract-acceptance.json'), { status: 'failed', passedCases: cases, error: String(error), root });
  throw error;
} finally {
  if (pid) process.kill(pid, 'SIGTERM');
  server.closeAllConnections(); server.close();
}
