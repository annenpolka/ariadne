import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RpcHost } from '../src/host/rpc-host.js';
import { ReadProjection } from '../src/read-task.js';
import { writePrivateJSON } from '../src/trace.js';
import { defaultReadLimits, defaultProjectionLimits, readLimitRanges, projectionLimitRanges } from '../src/browser-limits.generated.js';
import { browserOrigin } from '../src/browser-policy.js';
import type { ReadLimits, ReadSessionSpec, ReadTaskSpec, ScopeGrant } from '../src/contracts.js';

// Opt-in sizing experiment. Workers isolate Node RSS per case; /usr/bin/time measures
// the native host. Chrome itself is excluded. Only aggregate metadata is recorded.
const exec = promisify(execFile), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nodeArgs = ['--import', 'tsx'];
async function cli(...args: string[]) {
  const { stdout } = await exec(process.execPath, [...nodeArgs, 'src/browser.ts', ...args], { timeout: 30_000 });
  return JSON.parse(stdout);
}
async function worker(root: string, origin: string, mode: string, out: string) {
  const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
  const state = JSON.parse((await exec('swift', ['scripts/browser-window.swift', String(launch.pid), origin], { timeout: 20_000 })).stdout);
  assert.equal(state.status, 'browser_window'); assert.equal(browserOrigin(state.url), origin);
  const limits: ReadLimits = mode === 'probe' ? Object.fromEntries(Object.entries(readLimitRanges).map(([key, [, max]]) => [key, max])) as unknown as ReadLimits : { ...defaultReadLimits };
  // Session duration/count are not part of the per-capture capacity experiment.
  limits.maxCaptures = 10;
  // Three worst-case 20s probes plus serialization must fit the measurement session.
  limits.deadlineMs = mode === 'probe' ? 120000 : 60000;
  const spec: ReadSessionSpec = { kind: 'read_session', schemaVersion: '0.1', readSessionId: `measure-${randomUUID()}`, scopeRef: `scope-${randomUUID()}`, limits };
  const grant: ScopeGrant = { scopeRef: spec.scopeRef, grantRef: 'grant-measure', version: 1, read: true, model: false, act: false, allowedCommands: [], appId: 'ariadne.chrome', windowRef: 'browser-page',
    limits: { maxOperations: 0, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: limits.deadlineMs }, pageScope: { origins: [origin] }, readLimits: limits };
  writePrivateJSON(join(out, 'grant.json'), grant);
  let diagnostics = '';
  const host = new RpcHost({ executable: '/usr/bin/time', args: ['-l', resolve('.cache/swift/debug/AriadneHost'), '--pid', String(launch.pid), '--window-title', state.title, '--page-url', state.url,
    '--grant', join(out, 'grant.json'), '--journal', join(out, 'host.jsonl')], onDiagnostic: text => { diagnostics += text; } });
  const trials = [];
  let phase = 'open';
  try {
    const session = await host.openRead(spec);
    let retainedRegion: string | undefined;
    const repetitions = process.argv[7] === '1' ? 1 : 3;
    for (let i = 0; i < repetitions; i++) {
      phase = `capture-${i}`;
      const started = performance.now(), observation = await host.read(session.document), received = performance.now();
      const task: ReadTaskSpec = { kind: 'read_task', schemaVersion: '0.1', taskId: `measure-${i}`, revision: 1, recipeId: 'project-ax-text.v1', completeness: 'observed_region', readSessionId: spec.readSessionId, scopeRef: spec.scopeRef,
        document: session.document, nativeRoles: [], attributes: ['name', 'value'], limits: mode === 'probe' ? { maxRecords: projectionLimitRanges.maxRecords[1], maxOutputBytes: projectionLimitRanges.maxOutputBytes[1] } : { ...defaultProjectionLimits } };
      const projection = new ReadProjection(task, observation), result = projection.project(); projection.verify(result);
      const verified = performance.now();
      const depths = new Map<string, number>();
      for (const n of observation.nodes) depths.set(n.ref, n.parentRef === null ? 0 : (depths.get(n.parentRef) ?? 0) + 1);
      // This marker is only present on the synthetic page; it is not a site selector.
      if (!retainedRegion) retainedRegion = observation.nodes.find(n => n.name.status === 'available' && n.name.value === 'Synthetic measurement region')?.ref;
      const deepest = observation.nodes.at(-1);
      if (deepest && depths.get(deepest.ref) === readLimitRanges.maxDepth[1]) retainedRegion = deepest.ref;
      trials.push({ nodes: observation.nodes.length, maxDepth: Math.max(...depths.values()), observationBytes: Buffer.byteLength(JSON.stringify(observation)), resultBytes: Buffer.byteLength(JSON.stringify(result)) + 1,
        captureMs: observation.capture.endedMonoMs - observation.capture.startedMonoMs, readRoundTripMs: received - started, projectionAndVerificationMs: verified - received,
        coverage: observation.coverage.status, omittedReasons: observation.coverage.omittedReasons, records: result.records.length, status: result.status, outputTruncated: result.outputTruncated });
      writePrivateJSON(join(out, 'progress.json'), { phase, trials });
    }
    // Repeated full reads must not silently redirect a retained region reference.
    phase = 'region-reread';
    if (retainedRegion) assert.equal((await host.read(session.document, retainedRegion)).coverage.rootRef, retainedRegion);
    await host.close();
    const nativeRSS = Number(diagnostics.match(/(\d+)\s+maximum resident set size/)?.[1]);
    assert.ok(Number.isFinite(nativeRSS) && nativeRSS > 0);
    const report = { mode, limits, trials, regionReread: retainedRegion ? 'passed' : 'not_applicable', nativePeakRSSBytes: nativeRSS, nodePeakRSSKiB: process.resourceUsage().maxRSS, modelCalls: 0, operations: 0 };
    writePrivateJSON(join(out, 'report.json'), report); process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) { writePrivateJSON(join(out, 'error.json'), { phase, trials, error: String(error) }); throw error; }
  finally { await host.close(); }
}
if (process.argv[2] === '--worker') {
  await worker(process.argv[3]!, process.argv[4]!, process.argv[5]!, process.argv[6]!);
} else {
  mkdirSync('.runtime', { recursive: true, mode: 0o700 });
  const out = resolve(mkdtempSync('.runtime/browser-budget-measure-'));
  const files = ['build_contracts.py', 'contracts.schema.json', ...readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.ts')).map(p => join('src', p)),
    ...readdirSync('native/Sources', { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.swift')).map(p => join('native/Sources', p))];
  const fingerprint = () => Object.fromEntries(files.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
  const frozen = fingerprint(); writePrivateJSON(join(out, 'frozen.json'), frozen);
  const loaded = new Set<string>();
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/ready?')) { loaded.add(new URL(req.url, 'http://127.0.0.1').searchParams.get('path')!); res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    const count = req.url === '/ceiling' ? 32767 : req.url === '/large' ? 15000 : 5000;
    const body = req.url === '/long-text' ? Array.from({ length: 1000 }, () => `<p>${'あ'.repeat(16000)}</p>`).join('')
      : req.url === '/deep-boundary' ? `${'<div role="group" aria-label="nested">'.repeat(254)}<p>Deep synthetic content</p>${'</div>'.repeat(254)}`
      : req.url === '/deep' ? `${'<div role="group" aria-label="nested">'.repeat(200)}<p>Deep synthetic content</p>${'</div>'.repeat(200)}`
      : `<section aria-label="Synthetic measurement region">${Array.from({ length: count }, (_, i) => `<p>架空の行 ${i} | Synthetic row ${i} | ${'x'.repeat(80)}</p>`).join('')}</section>`;
    res.end(`<!doctype html><html lang="ja"><title>Ariadne capacity ${req.url}</title>${body}<script>addEventListener('load',()=>requestAnimationFrame(()=>requestAnimationFrame(()=>fetch('/ready?path='+encodeURIComponent(location.pathname)))))</script></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  const cases = process.argv.includes('--stress-only') ? [
    { label: 'synthetic-65536-nodes', url: `${local}/ceiling` },
    { label: 'synthetic-long-text', url: `${local}/long-text` },
    { label: 'synthetic-depth-256', url: `${local}/deep-boundary` },
  ] : [
    { label: 'W3C', url: 'https://www.w3.org/WAI/tutorials/tables/two-headers/' },
    { label: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles' },
    { label: 'RFC9110', url: 'https://www.rfc-editor.org/rfc/rfc9110.html' },
    { label: 'synthetic-5000-rows', url: `${local}/wide` },
    { label: 'synthetic-15000-rows', url: `${local}/large` },
    { label: 'synthetic-depth-200', url: `${local}/deep` },
  ];
  const results = [];
  try {
    for (const item of cases) {
      const launch = await cli('open', item.url);
      try {
        if (item.url.startsWith(local)) {
          const deadline = performance.now() + 45000;
          while (!loaded.has(new URL(item.url).pathname)) { assert.ok(performance.now() < deadline, 'Synthetic page did not finish loading'); await sleep(100); }
          await sleep(1000);
        } else await sleep(3000);
        for (const mode of ['probe', 'default']) {
          const dir = join(out, item.label, mode);
          const { stdout } = await exec(process.execPath, [...nodeArgs, 'test/browser-budget-benchmark.ts', '--worker', launch.root, browserOrigin(item.url)!, mode, dir, process.argv.includes('--single') ? '1' : '3'], { timeout: 90_000, maxBuffer: 1024 * 1024 });
          const report = JSON.parse(stdout); results.push({ label: item.label, ...report });
          if (mode === 'default') {
            const production = await cli('extract', launch.root, '--origin', browserOrigin(item.url)!);
            assert.equal(production.status, report.trials[0].status);
            // A time-bounded partial read may stop at a different node on each run.
            if (production.status === 'projected') assert.equal(production.records, report.trials[0].records);
            else assert.ok(production.records <= defaultProjectionLimits.maxRecords);
            writePrivateJSON(join(dir, 'production-cli.json'), production);
          }
          assert.deepEqual(fingerprint(), frozen);
          writePrivateJSON(join(out, 'report.json'), { status: 'running', cases: results });
          process.stdout.write(JSON.stringify({ label: item.label, mode, ...report.trials[0], nativePeakRSSBytes: report.nativePeakRSSBytes, nodePeakRSSKiB: report.nodePeakRSSKiB, out }) + '\n');
        }
      } finally { process.kill(launch.pid, 'SIGTERM'); }
    }
    writePrivateJSON(join(out, 'report.json'), { status: 'measured', frozenEngineFiles: files.length, productionCliChecked: true, cases: results });
  } catch (error) { writePrivateJSON(join(out, 'report.json'), { status: 'failed', cases: results, error: String(error) }); throw error; }
  finally { server.closeAllConnections(); server.close(); }
}
